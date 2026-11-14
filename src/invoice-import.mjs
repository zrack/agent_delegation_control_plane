import { evaluateChain, statusLabels } from './evaluator.mjs';
import { MAX_IMPORT_BYTES, parseInvestigation } from './import.mjs';

const digestPattern = /^[0-9a-f]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const json = text => JSON.parse(text);
const smallReceipt = 32 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const casePattern = /^invoice-[a-z0-9][a-z0-9-]{0,63}$/;

export const invoiceFields = {
  invoice_count: 'Invoices',
  subtotal_cents: 'Subtotal (cents)',
  tax_cents: 'Tax (cents)',
  total_cents: 'Total (cents)',
};

function totals(value) {
  const keys = Object.keys(invoiceFields);
  if (!object(value) || Object.keys(value).length !== keys.length
    || !keys.every(key => Object.hasOwn(value, key) && Number.isSafeInteger(value[key]))) {
    throw new Error('Expected four safe integer invoice totals.');
  }
  return value;
}

function parseTotals(text) {
  // The pilot expects four unique JSON keys and integer literals, including
  // when decimal or exponent notation would produce the same JS number.
  const value = totals(json(text));
  const member = /"(?:[^"\\]|\\.)*"[ \t\r\n]*:[ \t\r\n]*-?(?:0|[1-9]\d*)[ \t\r\n]*(?=[,}])/g;
  if ([...text.matchAll(member)].length !== Object.keys(invoiceFields).length
    || text.replace(member, '').replace(/[ \t\r\n]/g, '') !== '{,,,}') {
    throw new Error('Expected four unique invoice keys with integer literals.');
  }
  return value;
}

function validation(text) {
  const value = json(text);
  if (!object(value) || typeof value.passed !== 'boolean') throw new Error('Invalid validation receipt.');
  return { passed: value.passed, actual: value.passed ? totals(value.actual) : null };
}

function attempts(text) {
  const value = json(text);
  if (!Array.isArray(value) || !value.every(entry => object(entry)
    && ['allowed', 'denied'].includes(entry.outcome)
    && ['actor', 'action', 'resource', 'callId'].every(key => typeof entry[key] === 'string' && entry[key].trim()))) {
    throw new Error('Invalid authorization attempts.');
  }
  const allowed = value.filter(entry => entry.outcome === 'allowed').length;
  return { allowed, denied: value.length - allowed };
}

const executionStatuses = {
  completed: 'Completed',
  failed: 'Failed',
  execution_failed: 'Execution failed',
  timeout: 'Timed out',
  output_limit: 'Output limit reached',
  artifact_invalid: 'Artifact collection failed',
};

function execution(text) {
  const value = json(text);
  if (!object(value) || typeof value.status !== 'string' || !Object.hasOwn(executionStatuses, value.status)
    || (value.exit_code !== null && !Number.isSafeInteger(value.exit_code))
    || typeof value.input_unchanged !== 'boolean' || typeof value.cleaned !== 'boolean') {
    throw new Error('Invalid execution receipt.');
  }
  return {
    completed: value.status === 'completed' && value.exit_code === 0,
    status: executionStatuses[value.status],
    exitCode: value.exit_code,
    inputUnchanged: value.input_unchanged,
    cleaned: value.cleaned,
  };
}

const receipts = {
  'investigation.json': [MAX_IMPORT_BYTES, parseInvestigation],
  'results.json': [smallReceipt, parseTotals],
  'expected.json': [smallReceipt, parseTotals],
  'validation.json': [smallReceipt, validation],
  'attempts.json': [smallReceipt, attempts],
  'execution.json': [128 * 1024, execution],
};

function selectReceipts(files) {
  const selected = new Map();
  let root;
  for (const file of files) {
    const parts = file.webkitRelativePath.split('/');
    const [folder, name] = parts;
    if (!folder || (root && root !== folder)) throw new Error('Choose one invoice-run folder.');
    root = folder;
    if (parts.length !== 2 || (name !== 'manifest.json' && !Object.hasOwn(receipts, name))) continue;
    if (selected.has(name)) throw new Error('The folder contains duplicate receipt names.');
    selected.set(name, file);
  }
  return selected;
}

async function readBytes(file, limit) {
  if (file.size > limit) throw new Error('File exceeds the import limit.');
  return await file.arrayBuffer();
}

async function readManifest(file) {
  if (!file) throw new Error('Choose the invoice-run folder containing manifest.json.');
  let manifest;
  try { manifest = json(decoder.decode(await readBytes(file, 64 * 1024))); }
  catch { throw new Error('Could not read manifest.json as JSON within the 64 KiB limit.'); }
  if (!object(manifest) || typeof manifest.case !== 'string' || !casePattern.test(manifest.case)
    || !object(manifest.files)) throw new Error('Expected an invoice manifest with a case ID and file digests.');
  return manifest;
}

// Preserve exact bytes for a fresh digest check after reload. Undefined means
// the file was absent, and null means the selected file could not be read.
async function captureReceipt(file, limit) {
  if (!file) return undefined;
  try {
    const bytes = new Uint8Array(await readBytes(file, limit));
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  } catch {
    return null;
  }
}

async function assessReceipt(name, encoded, hashes) {
  if (encoded === undefined) return { state: 'missing' };
  if (!Object.hasOwn(hashes, name)) return { state: 'unlisted' };
  const digest = hashes[name];
  const [limit, parse] = receipts[name];
  if (typeof digest !== 'string' || !digestPattern.test(digest)
    || typeof encoded !== 'string' || encoded.length > 4 * Math.ceil(limit / 3)) return { state: 'invalid' };

  try {
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    if (bytes.length > limit) return { state: 'invalid' };
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
    const actual = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== actual) return { state: 'mismatch' };
    return { state: 'matched', digest, data: parse(decoder.decode(bytes)) };
  } catch {
    return { state: 'invalid' };
  }
}

function assessOutput(chain, result, expected, grade) {
  if ([result, expected, grade].some(receipt => receipt.state === 'mismatch')) {
    return { tone: 'violation', label: 'Hash mismatch', message: 'An output receipt differs from the supplied manifest.' };
  }
  if (!result.data || !expected.data || !grade.data || !chain) {
    return { tone: 'unknown', label: 'Unverifiable', message: 'This check needs the matching output, expected totals, validation receipt, and investigation.' };
  }
  const resource = 'sandbox:' + chain.id;
  const recordedOutput = (actor, action, target) => chain.events.some(event => event.actor === actor
    && event.action.action === action && event.action.resource === target && event.evidence?.tool === action
    && event.evidence.artifactSha256 === result.digest);
  if (!recordedOutput('Coder', 'code:execute', resource)
    || !recordedOutput('Verifier', 'artifact:verify', resource + ':results.json')) {
    return { tone: 'violation', label: 'Evidence disagrees', message: 'The output hash does not match the recorded Coder and Verifier evidence.' };
  }
  const matches = Object.keys(invoiceFields).every(key =>
    result.data[key] === expected.data[key] && result.data[key] === grade.data.actual?.[key]);
  if (!matches || !grade.data.passed) return {
    tone: 'violation', label: 'Validation failed', message: 'The totals and recorded validation do not agree on a passing result.',
  };
  return { tone: 'valid', label: 'Totals verified', totals: result.data };
}

export async function importInvoiceFolder(files) {
  if (!globalThis.crypto?.subtle) throw new Error('Open the dashboard on localhost to verify file digests.');
  const selected = selectReceipts(files);
  const manifest = await readManifest(selected.get('manifest.json'));
  const hashes = {};
  const filesByName = {};
  await Promise.all(Object.entries(receipts).map(async ([name, [limit]]) => {
    if (Object.hasOwn(manifest.files, name)) {
      const hash = manifest.files[name];
      hashes[name] = typeof hash === 'string' && digestPattern.test(hash) ? hash : null;
    }
    const contents = await captureReceipt(selected.get(name), limit);
    if (contents !== undefined) filesByName[name] = contents;
  }));
  // Preserve digest and file order regardless of when file reads finish.
  const ordered = records => Object.fromEntries(Object.keys(receipts)
    .filter(name => Object.hasOwn(records, name)).map(name => [name, records[name]]));
  const evidence = { caseId: manifest.case, hashes: ordered(hashes), files: ordered(filesByName) };
  return { evidence, ...await assessInvoiceFolder(evidence) };
}

export function portableInvoiceEvidence({ caseId, hashes, files } = {}) {
  if (typeof caseId !== 'string' || !casePattern.test(caseId) || !object(hashes) || !object(files)) {
    throw new Error('The invoice receipt snapshot is invalid.');
  }
  const selected = { caseId, hashes: {}, files: {} };
  for (const [name, [limit]] of Object.entries(receipts)) {
    if (Object.hasOwn(hashes, name)) {
      const digest = hashes[name];
      if (digest !== null && (typeof digest !== 'string' || !digestPattern.test(digest))) {
        throw new Error('The invoice receipt digest is invalid.');
      }
      selected.hashes[name] = digest;
    }
    if (Object.hasOwn(files, name)) {
      const contents = files[name];
      if (contents !== null && (typeof contents !== 'string' || contents.length > 4 * Math.ceil(limit / 3))) {
        throw new Error('An invoice receipt exceeds its size limit or is invalid.');
      }
      selected.files[name] = contents;
    }
  }
  return selected;
}

export async function assessInvoiceFolder({ caseId, hashes, files }) {
  if (typeof caseId !== 'string' || !casePattern.test(caseId) || !object(hashes) || !object(files)) {
    throw new Error('The invoice receipt snapshot is invalid.');
  }
  const checks = Object.fromEntries(await Promise.all(Object.keys(receipts).map(async name =>
    [name, await assessReceipt(name, files[name], hashes)])));
  const chain = checks['investigation.json'].data;
  const authority = chain && evaluateChain(chain);
  const output = assessOutput(chain, checks['results.json'], checks['expected.json'], checks['validation.json']);
  const reportedExecution = checks['execution.json'].data;
  const reportedAttempts = checks['attempts.json'].data;
  const executionTone = !reportedExecution || !reportedAttempts ? 'unknown'
    : reportedExecution.completed && reportedExecution.inputUnchanged && reportedExecution.cleaned ? 'valid' : 'violation';
  return {
    caseId,
    candidate: chain,
    receiptStates: Object.fromEntries(Object.entries(checks).map(([name, check]) => [name, check.state])),
    authority: {
      tone: authority?.status ?? 'unknown',
      label: statusLabels[authority?.status ?? 'unknown'],
      runId: chain?.id,
      actions: chain?.events.length,
      findings: authority?.findings.slice(0, 8).map(finding => finding.message) ?? [],
    },
    output,
    execution: {
      tone: executionTone,
      label: { valid: 'Execution recorded complete', violation: 'Execution needs review', unknown: 'Unverifiable' }[executionTone],
      receipt: reportedExecution,
      attempts: reportedAttempts,
    },
  };
}
