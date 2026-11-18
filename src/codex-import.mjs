import { parseInvestigation } from './import.mjs';

const KiB = 1024;
const maxRecords = 200;
const fileLimits = {
  'actions.jsonl': 256 * KiB,
  'grants.jsonl': 256 * KiB,
  'attempts.jsonl': 128 * KiB,
  'before.md': 128 * KiB,
  'after.md': 128 * KiB,
  'quickstart.diff': 256 * KiB,
  'codex-events.jsonl': 512 * KiB,
};

const evidenceTools = {
  preflight_read: { action: 'file:read', receipt: 'before.md' },
  read_quickstart: { action: 'file:read', receipt: 'before.md', recordsAttempt: true },
  update_preview_paragraph: { action: 'file:write', receipt: 'after.md', recordsAttempt: true },
};

const digestPattern = /^[0-9a-f]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const decoder = new TextDecoder('utf-8', { fatal: true });

function selectFiles(files) {
  const selected = new Map();
  let root;
  for (const file of files) {
    const parts = file.webkitRelativePath?.split('/') ?? [];
    const [folder, name] = parts;
    if (!folder || (root && root !== folder)) throw new Error('Choose one Codex run folder.');
    root = folder;
    if (parts.length !== 2 || (name !== 'manifest.json' && !Object.hasOwn(fileLimits, name))) continue;
    if (selected.has(name)) throw new Error(`The folder has more than one ${name}.`);
    selected.set(name, file);
  }
  return selected;
}

async function readFile(files, name, limit) {
  const file = files.get(name);
  if (!file) throw new Error(`Missing ${name} in the Codex run folder.`);
  if (file.size > limit) throw new Error(`${name} exceeds the ${limit / KiB} KiB import limit.`);
  let bytes;
  try { bytes = await file.arrayBuffer(); }
  catch { throw new Error(`Could not read ${name}.`); }
  if (bytes.byteLength > limit) throw new Error(`${name} exceeds the ${limit / KiB} KiB import limit.`);
  return bytes;
}

async function digest(bytes) {
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}

function readManifest(bytes) {
  const names = Object.keys(fileLimits);
  let raw;
  let manifest;
  try {
    raw = decoder.decode(bytes);
    manifest = JSON.parse(raw);
  } catch {
    throw new Error('Read manifest.json as a UTF-8 JSON object.');
  }
  // Values must be digests. Counting key tokens also rejects duplicate JSON
  // keys that JSON.parse would otherwise silently discard.
  if (!object(manifest) || Object.keys(manifest).length !== names.length
    || [...raw.matchAll(/"(?:[^"\\]|\\.)*"\s*:/g)].length !== names.length
    || !names.every(name => Object.hasOwn(manifest, name) && typeof manifest[name] === 'string' && digestPattern.test(manifest[name]))) {
    throw new Error('manifest.json must list exactly the seven Codex capture files with one SHA-256 digest each.');
  }
  return manifest;
}

function readRecords(bytes, name) {
  try {
    const lines = decoder.decode(bytes).split(/\r?\n/).filter(line => line.trim());
    if (lines.length > maxRecords) throw new Error('Too many records');
    const records = lines.map(line => JSON.parse(line));
    if (!records.every(object)) throw new Error('Expected JSON objects');
    return records;
  } catch {
    throw new Error(`Expected up to ${maxRecords} UTF-8 JSON records in ${name}.`);
  }
}

function checkReceipts(actions, attempts, manifest) {
  const completed = new Map();
  const attemptIds = new Set();
  for (const attempt of attempts) {
    const { callId, tool, status } = attempt;
    if (typeof callId !== 'string' || !callId.trim() || attemptIds.has(callId) || typeof tool !== 'string'
      || (status !== 'completed' && status !== 'rejected')) {
      throw new Error('attempts.jsonl contains an invalid or duplicate tool call.');
    }
    attemptIds.add(callId);
    if (status === 'completed') completed.set(callId, tool);
  }

  const actionCalls = new Set();
  for (const event of actions) {
    const { callId, tool, artifactSha256 } = event.evidence ?? {};
    const expected = typeof tool === 'string' && Object.hasOwn(evidenceTools, tool) ? evidenceTools[tool] : undefined;
    if (typeof callId !== 'string' || !callId.trim() || actionCalls.has(callId)
      || !expected || event.action?.action !== expected.action || event.action.outcome !== 'completed') {
      throw new Error('actions.jsonl contains a tool call outside the Codex pilot capture format.');
    }
    actionCalls.add(callId);
    if (artifactSha256 !== manifest[expected.receipt]) {
      throw new Error(`${expected.receipt} does not match the digest recorded by its action.`);
    }
    if (expected.recordsAttempt) {
      if (completed.get(callId) !== tool) throw new Error('A completed action does not match its tool receipt in attempts.jsonl.');
      completed.delete(callId);
    }
  }
  if (completed.size) throw new Error('attempts.jsonl contains a completed call without an action record.');
}

export async function importCodexFolder(files) {
  if (!globalThis.crypto?.subtle) throw new Error('Open the dashboard on localhost to verify file digests.');
  const selected = selectFiles(files);
  const manifest = readManifest(await readFile(selected, 'manifest.json', 8 * KiB));
  const names = Object.keys(fileLimits);
  const verified = new Map();
  for (const name of names) {
    const bytes = await readFile(selected, name, fileLimits[name]);
    if (await digest(bytes) !== manifest[name]) throw new Error(`${name} hash mismatch against manifest.json.`);
    if (name === 'actions.jsonl' || name === 'grants.jsonl' || name === 'attempts.jsonl') verified.set(name, bytes);
  }

  const actions = readRecords(verified.get('actions.jsonl'), 'actions.jsonl');
  const grants = readRecords(verified.get('grants.jsonl'), 'grants.jsonl');
  const attempts = readRecords(verified.get('attempts.jsonl'), 'attempts.jsonl');
  checkReceipts(actions, attempts, manifest);
  const roots = actions.filter(event => event.parentEventId === null && event.evidence?.tool === 'preflight_read');
  if (roots.length !== 1 || typeof roots[0].id !== 'string') throw new Error('Expected one coordinator preflight action.');
  const root = roots[0];
  const rootGrant = grants.find(grant => grant.id === root.authorityId);
  const suppliedPrincipals = new Set(grants.map(grant => grant.principal));
  const supportedPrincipal = rootGrant?.principal ?? (suppliedPrincipals.size === 1 ? grants[0].principal : undefined);
  const principal = supportedPrincipal === undefined
    ? { id: 'unverified-principal', name: 'Principal unavailable' } : { id: supportedPrincipal };
  // Use the verified digest set to keep changed captures separate, even when
  // the original action and grant IDs are reused in a comparison.
  const fingerprint = await digest(new TextEncoder().encode(names.map(name => manifest[name]).join('\n')));
  const chain = parseInvestigation(JSON.stringify({ schemaVersion: 1, chain: {
    id: `CODEX-${fingerprint}`,
    title: `Codex run · ${root.id.replace(/-inspect$/, '')}`,
    source: 'Codex pilot capture folder',
    principal, rootGrantId: root.authorityId, events: actions, grants,
  } }));
  return { chain, verifiedFileCount: names.length };
}
