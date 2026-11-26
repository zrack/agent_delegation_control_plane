// Offline producer checks. Messages describe source positions without printing record contents.
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { codexFolderLimits, importCodexFolder } from '../src/codex-import.mjs';
import { evaluateChain } from '../src/evaluator.mjs';
import { MAX_IMPORT_BYTES, parseInvestigation } from '../src/import.mjs';
import { readBytes } from './bounded-file.mjs';

const usage = 'Usage: node scripts/validate-capture.mjs (--investigation FILE | --codex-folder DIRECTORY) [--json]';
const issue = (file, message) => Object.assign(new Error(message), { file, code: 'UNREADABLE_INPUT' });

function readSource(file, path, limit) {
  try {
    if (!lstatSync(path).isFile()) throw issue(file, 'Expected a regular file.');
    return readBytes(path, limit, { noFollow: true });
  } catch {
    throw issue(file, `Supply a readable regular file of at most ${limit} bytes. Symbolic links are rejected.`);
  }
}

async function loadInput(values) {
  if (values.investigation) {
    const bytes = readSource('investigation.json', values.investigation, MAX_IMPORT_BYTES);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw issue('investigation.json', 'Save the investigation as UTF-8 JSON.'); }
    return { chain: parseInvestigation(text) };
  }
  const directory = values['codex-folder'];
  try {
    if (!lstatSync(directory).isDirectory()) throw issue('Codex folder', 'Expected a directory.');
  } catch { throw issue('Codex folder', 'Select the capture directory itself. Symbolic links are rejected.'); }
  const files = Object.entries(codexFolderLimits).map(([name, limit]) =>
    Object.assign(new Blob([readSource(name, join(directory, name), limit)]), { webkitRelativePath: 'capture/' + name }));
  return importCodexFolder(files);
}

function location(field, folder, defaultFile = folder ? 'Codex folder' : 'investigation.json') {
  if (folder && field) {
    const source = /^chain\.(events|grants)(.*)$/.exec(field);
    if (source) return { file: source[1] === 'events' ? 'actions.jsonl' : 'grants.jsonl', field: 'records' + source[2] };
  }
  return field ? { file: defaultFile, field } : { file: defaultFile };
}

function authFinding(finding, chain, folder) {
  const event = chain.events.findIndex(event => event.id === finding.eventId);
  const grant = chain.grants.findIndex(grant => grant.id === finding.grantId);
  let field = 'chain';
  if (finding.code === 'GRANT_MISSING' && event >= 0 && chain.events[event].authorityId === finding.grantId) {
    field = `chain.events[${event}].authorityId`;
  } else if (finding.code === 'GRANT_MISSING') {
    const child = chain.grants.findIndex(record => record.parentGrantId === finding.grantId);
    if (child >= 0) field = `chain.grants[${child}].parentGrantId`;
  } else if (finding.code === 'ROOT_MISSING') {
    field = 'chain.rootGrantId';
  } else if (grant >= 0) {
    field = `chain.grants[${grant}]`;
  } else if (event >= 0) {
    field = `chain.events[${event}]`;
  }
  const result = { code: finding.code, ...location(field, folder), severity: finding.severity };
  // parseInvestigation restricts all IDs to a short, safe alphabet.
  if (finding.eventId) result.eventId = finding.eventId;
  if (finding.grantId) result.grantId = finding.grantId;
  if (finding.code === 'GRANT_MISSING') result.message = 'Locate the referenced grant in the source ledger or leave authority unverifiable.';
  else if (finding.code === 'ACTION_OUTSIDE_SCOPE') result.message = 'Compare the recorded action and resource with the grant capabilities.';
  else result.message = 'Inspect the indicated authority record and its source evidence.';
  return result;
}

async function validate(values) {
  const folder = Boolean(values['codex-folder']);
  const header = { schemaVersion: 1, inputKind: folder ? 'codex-folder' : 'investigation' };
  try {
    const { chain, verifiedFileCount } = await loadInput(values);
    const evaluation = evaluateChain(chain);
    const status = { valid: 'within-scope', unknown: 'unverifiable', violation: 'violation' }[evaluation.status];
    return {
      ...header, status, authority: status, receipts: folder ? 'verified' : 'not-supplied',
      ...(folder ? { verifiedFileCount } : {}), findingCount: evaluation.findings.length,
      diagnostics: evaluation.findings.slice(0, 25).map(finding => authFinding(finding, chain, folder)),
    };
  } catch (error) {
    const mismatch = ['RECEIPT_HASH_MISMATCH', 'ACTION_RECEIPT_MISMATCH'].includes(error.code);
    // All errors emitted by loadInput or the importers use static labels and validated field paths.
    return { ...header, status: mismatch ? 'receipt-mismatch' : 'invalid-input', authority: 'unassessed',
      receipts: folder ? (mismatch ? 'mismatch' : 'unverified') : 'not-supplied',
      diagnostics: [{ code: error.code ?? 'INVALID_CAPTURE', ...location(error.field, folder, error.file), message: error.message }],
    };
  }
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: { investigation: { type: 'string' }, 'codex-folder': { type: 'string' },
      json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } }));
  } catch { console.error(usage); return 2; }
  if (values.help) { console.log(usage); return 0; }
  if (Boolean(values.investigation) === Boolean(values['codex-folder'])) { console.error(usage); return 2; }
  const result = await validate(values);
  if (values.json) console.log(JSON.stringify(result));
  else {
    console.log(`${result.status} · authority ${result.authority} · receipts ${result.receipts}`);
    for (const { file, field, code, message, grantId, eventId } of result.diagnostics) {
      console.log([file, field, code, eventId && 'event ' + eventId, grantId && 'grant ' + grantId, message].filter(Boolean).join(' · '));
    }
    if (result.findingCount > result.diagnostics.length) console.log(`Showing ${result.diagnostics.length} of ${result.findingCount} findings.`);
  }
  if (result.status === 'within-scope') return 0;
  if (result.status === 'invalid-input') return 2;
  return 1;
}

process.exitCode = await main();
