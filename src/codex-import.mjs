import { parseInvestigation } from './import.mjs';

const KiB = 1024;
const maxRecords = 200;
const fileLimits = Object.freeze({
  'actions.jsonl': 256 * KiB,
  'grants.jsonl': 256 * KiB,
  'attempts.jsonl': 128 * KiB,
  'before.md': 128 * KiB,
  'after.md': 128 * KiB,
  'quickstart.diff': 256 * KiB,
  'codex-events.jsonl': 512 * KiB,
});
export const codexFolderLimits = Object.freeze({ 'manifest.json': 8 * KiB, ...fileLimits });

const captureNames = Object.keys(fileLimits);
const ledgerNames = ['actions.jsonl', 'grants.jsonl', 'attempts.jsonl'];
export const codexReceiptNames = Object.freeze([...ledgerNames, 'before.md', 'after.md']);

const evidenceTools = {
  preflight_read: { action: 'file:read', receipt: 'before.md' },
  read_quickstart: { action: 'file:read', receipt: 'before.md', recordsAttempt: true },
  update_preview_paragraph: { action: 'file:write', receipt: 'after.md', recordsAttempt: true },
};

const digestPattern = /^[0-9a-f]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const decoder = new TextDecoder('utf-8', { fatal: true });
const problem = (file, message, field, code = 'INVALID_CAPTURE') => Object.assign(new Error(message), { file, field, code });

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
  if (!globalThis.crypto?.subtle) throw new Error('Open the dashboard on localhost to verify file digests.');
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}

function hasExactKeys(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validHashes(hashes) {
  return hasExactKeys(hashes, captureNames)
    && captureNames.every(name => typeof hashes[name] === 'string' && digestPattern.test(hashes[name]));
}

function readManifest(bytes) {
  let raw;
  let manifest;
  try {
    raw = decoder.decode(bytes);
    manifest = JSON.parse(raw);
  } catch {
    throw problem('manifest.json', 'Read manifest.json as a UTF-8 JSON object.');
  }
  // Values must be digests. Counting key tokens also rejects duplicate JSON
  // keys that JSON.parse would otherwise silently discard.
  if (!validHashes(manifest) || [...raw.matchAll(/"(?:[^"\\]|\\.)*"\s*:/g)].length !== captureNames.length) {
    throw problem('manifest.json', 'manifest.json must list exactly the seven Codex capture files with one SHA-256 digest each.');
  }
  return manifest;
}

function readRecords(bytes, name) {
  let lines;
  try { lines = decoder.decode(bytes).split(/\r?\n/).filter(line => line.trim()); }
  catch { throw problem(name, `Expected UTF-8 JSON records in ${name}.`); }
  if (lines.length > maxRecords) throw problem(name, `Expected up to ${maxRecords} UTF-8 JSON records in ${name}.`);
  return lines.map((line, index) => {
    let value;
    try { value = JSON.parse(line); } catch { /* Report the record position without its contents. */ }
    if (!object(value)) throw problem(name, `Expected a JSON object in ${name}.`, `records[${index}]`);
    return value;
  });
}

function checkReceipts(actions, attempts, manifest) {
  const completed = new Map();
  const attemptIds = new Set();
  for (const [index, attempt] of attempts.entries()) {
    const { callId, tool, status } = attempt;
    if (typeof callId !== 'string' || !callId.trim() || attemptIds.has(callId) || typeof tool !== 'string'
      || (status !== 'completed' && status !== 'rejected')) {
      throw problem('attempts.jsonl', 'attempts.jsonl contains an invalid or duplicate tool call.', `records[${index}]`);
    }
    attemptIds.add(callId);
    if (status === 'completed') completed.set(callId, tool);
  }

  const actionCalls = new Set();
  for (const [index, event] of actions.entries()) {
    const { callId, tool, artifactSha256 } = event.evidence ?? {};
    const expected = typeof tool === 'string' && Object.hasOwn(evidenceTools, tool) ? evidenceTools[tool] : undefined;
    if (typeof callId !== 'string' || !callId.trim() || actionCalls.has(callId)
      || !expected || event.action?.action !== expected.action || event.action.outcome !== 'completed') {
      throw problem('actions.jsonl', 'actions.jsonl contains a tool call outside the Codex pilot capture format.', `records[${index}]`);
    }
    actionCalls.add(callId);
    if (artifactSha256 !== manifest[expected.receipt]) {
      throw problem(expected.receipt, `${expected.receipt} does not match the digest recorded by its action.`, undefined, 'ACTION_RECEIPT_MISMATCH');
    }
    if (expected.recordsAttempt) {
      if (completed.get(callId) !== tool) throw problem('attempts.jsonl', 'A completed action does not match its tool receipt in attempts.jsonl.', undefined, 'ACTION_RECEIPT_MISMATCH');
      completed.delete(callId);
    }
  }
  if (completed.size) throw problem('attempts.jsonl', 'attempts.jsonl contains a completed call without an action record.', undefined, 'ACTION_RECEIPT_MISMATCH');
}

async function verifyFile(name, bytes, hashes) {
  if (await digest(bytes) !== hashes[name]) throw problem(name, `${name} hash mismatch against manifest.json.`, undefined, 'RECEIPT_HASH_MISMATCH');
}

function encodeFile(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary);
}

function decodeFile(contents, name) {
  const limit = fileLimits[name];
  if (typeof contents === 'string' && contents.length <= 4 * Math.ceil(limit / 3)) {
    let binary;
    try { binary = atob(contents); } catch { /* Invalid base64. */ }
    if (binary !== undefined && binary.length <= limit && btoa(binary) === contents) {
      return Uint8Array.from(binary, char => char.charCodeAt(0));
    }
  }
  throw new Error(`Invalid or oversized saved Codex receipt for ${name}.`);
}

// The old manifest contains the expected digest, which can differ from the
// bytes that were actually in the inbox immediately before a repair.
export async function previousCodexReceiptDigest(files, name) {
  if (!files || !Object.hasOwn(files, name)) return 'missing';
  let bytes;
  try { bytes = decodeFile(files[name], name); }
  catch { return 'unreadable'; }
  return digest(bytes);
}

async function deriveChain(verified, manifest) {
  const actions = readRecords(verified.get('actions.jsonl'), 'actions.jsonl');
  const grants = readRecords(verified.get('grants.jsonl'), 'grants.jsonl');
  const attempts = readRecords(verified.get('attempts.jsonl'), 'attempts.jsonl');
  checkReceipts(actions, attempts, manifest);
  const roots = actions.filter(event => event.parentEventId === null && event.evidence?.tool === 'preflight_read');
  if (roots.length !== 1 || typeof roots[0].id !== 'string') throw problem('actions.jsonl', 'Expected one coordinator preflight action.');
  const root = roots[0];
  const rootGrant = grants.find(grant => grant.id === root.authorityId);
  const suppliedPrincipals = new Set(grants.map(grant => grant.principal));
  const supportedPrincipal = rootGrant?.principal ?? (suppliedPrincipals.size === 1 ? grants[0].principal : undefined);
  const principal = supportedPrincipal === undefined
    ? { id: 'unverified-principal', name: 'Principal unavailable' } : { id: supportedPrincipal };
  // Use the verified digest set to keep changed captures separate, even when
  // the original action and grant IDs are reused in a comparison.
  const fingerprint = await digest(new TextEncoder().encode(captureNames.map(name => manifest[name]).join('\n')));
  return parseInvestigation(JSON.stringify({ schemaVersion: 1, chain: {
    id: `CODEX-${fingerprint}`,
    title: `Codex run · ${root.id.replace(/-inspect$/, '')}`,
    source: 'Codex pilot capture folder',
    principal, rootGrantId: root.authorityId, events: actions, grants,
  } }));
}

export async function importCodexFolder(files, { retainEvidence = false } = {}) {
  const selected = selectFiles(files);
  const hashes = readManifest(await readFile(selected, 'manifest.json', codexFolderLimits['manifest.json']));
  const verified = new Map();
  const snapshotFiles = {};
  for (const name of captureNames) {
    const bytes = await readFile(selected, name, fileLimits[name]);
    await verifyFile(name, bytes, hashes);
    if (ledgerNames.includes(name)) verified.set(name, bytes);
    if (retainEvidence && codexReceiptNames.includes(name)) snapshotFiles[name] = encodeFile(bytes);
  }
  const result = { chain: await deriveChain(verified, hashes), verifiedFileCount: captureNames.length };
  if (retainEvidence) result.evidence = { hashes, files: snapshotFiles };
  return result;
}

// A portable case may carry only the seven digests and five bounded receipts.
// Copy them in capture order so imported object key order cannot alter the snapshot.
export function portableCodexEvidence(evidence) {
  if (!hasExactKeys(evidence, ['hashes', 'files']) || !validHashes(evidence.hashes)
    || !hasExactKeys(evidence.files, codexReceiptNames)) throw new Error('The saved Codex receipt snapshot is invalid.');
  const hashes = Object.fromEntries(captureNames.map(name => [name, evidence.hashes[name]]));
  const files = {};
  for (const name of codexReceiptNames) {
    const contents = evidence.files[name];
    if (typeof contents !== 'string' || contents.length > 4 * Math.ceil(fileLimits[name] / 3)) {
      throw new Error(`Invalid or oversized saved Codex receipt for ${name}.`);
    }
    files[name] = contents;
  }
  return { hashes, files };
}

// Rehash the retained ledgers and document receipts. The diff and Codex event
// stream were checked at import; their digests still contribute to the run ID.
export async function assessCodexEvidence(evidence) {
  const { hashes, files } = portableCodexEvidence(evidence);
  const verified = new Map();
  for (const name of codexReceiptNames) {
    const bytes = decodeFile(files[name], name);
    await verifyFile(name, bytes, hashes);
    if (ledgerNames.includes(name)) verified.set(name, bytes);
  }
  return { chain: await deriveChain(verified, hashes), verifiedFileCount: codexReceiptNames.length, evidence: { hashes, files } };
}
