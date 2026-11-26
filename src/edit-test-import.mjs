import {
  assessEditTestAuthority, isEditTestRepository, isEditTestResource, parseEditTestTime, validateEditTestGrants,
} from './edit-test-grants.mjs';

const KiB = 1024;
export const editTestFolderLimits = Object.freeze({
  'SHA256SUMS': 16 * KiB,
  'setup.json': 16 * KiB,
  'grants.jsonl': 32 * KiB,
  'attempts.jsonl': 16 * KiB,
  'actions.jsonl': 16 * KiB,
  'test-receipt.json': 16 * KiB,
  'test-stdout.bin': 128 * KiB,
  'test-stderr.txt': 128 * KiB,
});

const receiptName = 'test-receipt.json';
const outputNames = ['test-stdout.bin', 'test-stderr.txt'];
const command = ['python3', '-I', '-B', '-m', 'unittest', 'discover', '-s', 'tests', '-v'];
const attemptFields = ['runId', 'attemptId', 'actor', 'grantId', 'action', 'resource', 'revision', 'startedAt'];
const decoder = new TextDecoder('utf-8', { fatal: true });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const identifier = value => matches(value, /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/);
const sha256 = value => matches(value, /^[0-9a-f]{64}$/);
const revision = value => matches(value, /^[0-9a-f]{40}$/) && value !== '0'.repeat(40);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const issue = (code, file, message) => ({ code, file, message });
const invalid = (file, message) => Object.assign(new Error(message), { code: 'INVALID_EDIT_TEST_INPUT', file });

function selectFiles(files) {
  const selected = new Map();
  let root;
  for (const file of files) {
    const [folder, name, ...nested] = file.webkitRelativePath?.split('/') ?? [];
    if (!folder || !name || folder === '.' || folder === '..' || (root && root !== folder)) {
      throw invalid('folder', 'Choose a single edit and test capture folder.');
    }
    root = folder;
    if (nested.length || !Object.hasOwn(editTestFolderLimits, name)) continue;
    if (selected.has(name)) throw invalid(name, 'The selected folder has duplicate evidence files.');
    selected.set(name, file);
  }
  return selected;
}

async function readFile(file, name) {
  const limit = editTestFolderLimits[name];
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > limit) {
    throw invalid(name, 'The selected file exceeds its import limit or has an invalid size.');
  }
  let bytes;
  try { bytes = await file.arrayBuffer(); }
  catch { throw invalid(name, 'Could not read the selected file.'); }
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > limit || bytes.byteLength !== file.size) {
    throw invalid(name, 'The selected file changed size or exceeded its import limit.');
  }
  return bytes;
}

async function digest(bytes) {
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}

function decode(bytes, name) {
  try { return decoder.decode(bytes); }
  catch { throw invalid(name, 'Expected UTF-8 text in the selected evidence file.'); }
}

function parseRecord(text, name) {
  let value;
  try { value = JSON.parse(text); }
  catch { throw invalid(name, 'Expected valid JSON in the selected evidence file.'); }
  if (!object(value)) throw invalid(name, 'Expected a JSON object in the selected evidence file.');
  // JSON.parse accepts repeated keys. Scan the validated syntax, including escaped
  // key spellings, so conflicting claims cannot disappear during normalization.
  const levels = [];
  for (const token of text.matchAll(/("(?:[^"\\]|\\.)*")(\s*:)?|[{}]/g)) {
    if (token[0] === '{') levels.push(new Set());
    else if (token[0] === '}') levels.pop();
    else if (token[2]) {
      const key = JSON.parse(token[1]);
      if (levels.at(-1).has(key)) throw invalid(name, 'Duplicate JSON fields make the evidence ambiguous.');
      levels.at(-1).add(key);
    }
  }
  return value;
}

function ledger(bytes, name, limit) {
  const lines = decode(bytes, name).split(/\r?\n/).filter(line => line.trim());
  if (lines.length > limit) throw invalid(name, 'Too many records for the edit and test capture format.');
  return lines.map(line => parseRecord(line, name));
}

function parseManifest(bytes) {
  const sums = new Map();
  for (const line of decode(bytes, 'SHA256SUMS').split(/\r?\n/).filter(Boolean)) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match) throw invalid('SHA256SUMS', 'Expected SHA-256 checksum lines in SHA256SUMS.');
    const [, hash, name] = match;
    if (!Object.hasOwn(editTestFolderLimits, name) || name === 'SHA256SUMS') continue;
    if (sums.has(name)) throw invalid('SHA256SUMS', 'A capture file has duplicate SHA256SUMS entries.');
    sums.set(name, hash);
  }
  return sums;
}

function checkManifest(files, sums, actual, diagnostics) {
  for (const name of Object.keys(editTestFolderLimits)) {
    if (name === 'SHA256SUMS' || (!files.has(name) && !sums.has(name))) continue;
    if (!files.has(name) || !sums.has(name)) {
      diagnostics.push(issue('MANIFEST_FILE_MISSING', name, 'The file and its SHA256SUMS entry must both be supplied.'));
    } else if (actual.get(name) !== sums.get(name)) {
      diagnostics.push(issue('MANIFEST_HASH_MISMATCH', name, 'The file digest differs from SHA256SUMS.'));
    }
  }
}

function parseSetup(bytes) {
  const name = 'setup.json';
  const setup = parseRecord(decode(bytes, name), name);
  if (!identifier(setup.runId) || !isEditTestRepository(setup.repository) || !revision(setup.baseRevision)
      || parseEditTestTime(setup.setupAt) === null
      || ![setup.originalSourceSha256, setup.frozenTestSha256, setup.grantFileSha256].every(sha256)) {
    throw invalid(name, 'Expected a run, repository, setup time, base revision and setup digests.');
  }
  return setup;
}

function stageRows(rows, name) {
  const byAction = new Map();
  const attempts = new Set();
  const events = new Set();
  for (const row of rows) {
    const edit = row.action === 'file:write';
    if ((!edit && row.action !== 'test:execute') || byAction.has(row.action) || attempts.has(row.attemptId)
        || ![row.runId, row.attemptId, row.actor, row.grantId].every(identifier)
        || !isEditTestResource(row.resource) || !revision(row.revision) || parseEditTestTime(row.startedAt) === null) {
      throw invalid(name, 'Expected a unique, valid record for each edit or test stage.');
    }
    if (name === 'attempts.jsonl') {
      if (!exactKeys(row, attemptFields)) throw invalid(name, 'An attempt contains fields outside the capture format.');
    } else {
      const fields = [...attemptFields, 'eventId', 'completedAt', 'outcome', 'evidence'];
      if (!edit) fields.push('dependsOnEventId');
      const supportedOutcome = edit ? row.outcome === 'completed' : ['passed', 'failed'].includes(row.outcome);
      if (!exactKeys(row, fields) || !identifier(row.eventId) || events.has(row.eventId)
          || parseEditTestTime(row.completedAt) === null || !object(row.evidence) || !supportedOutcome
          || (!edit && !identifier(row.dependsOnEventId))) {
        throw invalid(name, 'Expected a unique, completed edit or test action in the capture format.');
      }
      events.add(row.eventId);
    }
    byAction.set(row.action, row);
    attempts.add(row.attemptId);
  }
  return byAction;
}

function assessStage(action, event, attempt, grants, setup, diagnostics) {
  const row = event ?? attempt;
  if (event && (!attempt || !attemptFields.every(key => attempt[key] === event[key]))) {
    diagnostics.push(issue('ATTEMPT_ACTION_MISMATCH', 'attempts.jsonl', 'The completed action has no exactly matching attempt.'));
  }
  if (row && (row.runId !== setup.runId || !row.resource.startsWith(setup.repository + '/'))) {
    diagnostics.push(issue('STAGE_SETUP_MISMATCH', 'setup.json', 'The stage belongs to another run or repository.'));
  }
  if (row && parseEditTestTime(row.startedAt) < parseEditTestTime(setup.setupAt)) {
    diagnostics.push(issue('STAGE_TIME_ORDER', event ? 'actions.jsonl' : 'attempts.jsonl', 'The recorded stage starts before setup.'));
  }
  const evaluated = row ? assessEditTestAuthority(grants, row) : { authority: 'unassessed', grant: null, diagnostics: [] };
  diagnostics.push(...evaluated.diagnostics);
  return {
    action, actor: row?.actor ?? null, resource: row?.resource ?? null, grantId: row?.grantId ?? null,
    grant: evaluated.grant, authority: evaluated.authority, completed: Boolean(event), revision: row?.revision ?? null,
    startedAt: row?.startedAt ?? null, completedAt: event?.completedAt ?? null,
    attemptId: row?.attemptId ?? null, eventId: event?.eventId ?? null,
    dependsOnEventId: event?.dependsOnEventId ?? null, outcome: event?.outcome ?? null,
  };
}

function checkHandoff(editor, verifier, setup, diagnostics) {
  if (!editor.completed) diagnostics.push(issue('NO_COMPLETED_EDIT', 'actions.jsonl', 'No completed edit action was supplied.'));
  if (!verifier.completed) diagnostics.push(issue('NO_COMPLETED_VERIFICATION', 'actions.jsonl', 'No completed verification action was supplied.'));
  if (editor.revision && editor.revision !== setup.baseRevision) {
    diagnostics.push(issue('BASE_REVISION_MISMATCH', 'setup.json', 'The edit does not identify the setup base revision.'));
  }
  if (editor.actor && verifier.actor && (editor.actor === verifier.actor || editor.grantId === verifier.grantId)) {
    diagnostics.push(issue('INDEPENDENCE_MISMATCH', 'actions.jsonl', 'The edit and verification require distinct actors and grants.'));
  }
  if (editor.resource && verifier.resource && editor.resource === verifier.resource) {
    diagnostics.push(issue('RESOURCE_MISMATCH', 'actions.jsonl', 'The source edit and the frozen test identify the same resource.'));
  }
  if (verifier.resource && !/^tests\/test[A-Za-z0-9_]*\.py$/.test(verifier.resource.slice(setup.repository.length + 1))) {
    diagnostics.push(issue('TEST_DISCOVERY_TARGET_MISMATCH', verifier.completed ? 'actions.jsonl' : 'attempts.jsonl',
      'The supported capture requires a discoverable test module directly inside the tests directory.'));
  }
  if (verifier.completed && (!editor.completed || verifier.dependsOnEventId !== editor.eventId
      || parseEditTestTime(verifier.startedAt) < parseEditTestTime(editor.completedAt)
      || verifier.revision === setup.baseRevision)) {
    diagnostics.push(issue('EDIT_TEST_DEPENDENCY_MISMATCH', 'actions.jsonl', 'The test must follow the completed edit and name a new revision.'));
  }
}

function assessReceipt(event, editor, setup, files, hashes, diagnostics) {
  if (!event) return { status: 'not-applicable' };
  const evidence = event.evidence;
  const expected = sha256(evidence.receiptSha256) ? evidence.receiptSha256 : null;
  const actual = hashes.get(receiptName) ?? null;
  const result = { expectedSha256: expected, actualSha256: actual, outputs: [] };
  const receiptFiles = [receiptName, ...outputNames];
  const problems = diagnostics.filter(item => receiptFiles.includes(item.file));
  const add = (code, file, message) => {
    const finding = issue(code, file, message);
    diagnostics.push(finding);
    problems.push(finding);
  };
  if (!exactKeys(evidence, ['receiptFile', 'receiptSha256']) || evidence.receiptFile !== receiptName || !expected) {
    add('VERIFIER_EVIDENCE_INVALID', 'actions.jsonl', 'The verification action must name the supported receipt and its SHA-256 digest.');
  }
  if (!actual) {
    add('MISSING_TEST_RECEIPT', receiptName, 'The completed verification is missing its test receipt.');
    return { ...result, status: 'missing' };
  }
  if (expected && actual !== expected) add('RECEIPT_HASH_MISMATCH', receiptName, 'The receipt digest differs from the verification action.');
  let receipt;
  try { receipt = parseRecord(decode(files.get(receiptName), receiptName), receiptName); }
  catch {
    add('INVALID_TEST_RECEIPT', receiptName, 'The test receipt must contain a readable, unambiguous JSON object.');
    return { ...result, status: problems.some(item => item.code.endsWith('HASH_MISMATCH')) ? 'mismatch' : 'unverified' };
  }
  const links = ['runId', 'attemptId', 'eventId', 'grantId', 'actor', 'resource', 'startedAt', 'completedAt'];
  const fields = [...links, 'testedRevision', 'tree', 'testSha256', 'testedSourceSha256', 'command', 'exitCode',
    'stdoutFile', 'stdoutSha256', 'stderrFile', 'stderrSha256'];
  if (Object.hasOwn(receipt, 'python')) fields.push('python');
  if (!exactKeys(receipt, fields)) {
    add('INVALID_TEST_RECEIPT', receiptName, 'The test receipt has missing or unsupported fields.');
  }
  if (receipt.runId !== setup.runId || !links.every(key => receipt[key] === event[key])) {
    add('RECEIPT_ACTION_MISMATCH', receiptName, 'The test receipt does not identify the same run and completed verification action.');
  }
  result.testedRevision = revision(receipt.testedRevision) ? receipt.testedRevision : null;
  result.tree = revision(receipt.tree) ? receipt.tree : null;
  result.testSha256 = sha256(receipt.testSha256) ? receipt.testSha256 : null;
  result.testedSourceSha256 = sha256(receipt.testedSourceSha256) ? receipt.testedSourceSha256 : null;
  if (result.testedRevision !== event.revision || !result.tree || result.testSha256 !== setup.frozenTestSha256
      || !result.testedSourceSha256 || result.testedSourceSha256 !== editor.afterSha256) {
    add('TESTED_CONTENT_MISMATCH', receiptName, 'The recorded revision, tree, frozen test or edited source is missing or inconsistent.');
  }
  const commandMatches = Array.isArray(receipt.command) && receipt.command.length === command.length
    && command.every((arg, index) => arg === receipt.command[index]);
  result.command = commandMatches ? [...command] : null;
  result.exitCode = Number.isSafeInteger(receipt.exitCode) ? receipt.exitCode : null;
  if (!commandMatches || result.exitCode === null || ((result.exitCode === 0) !== (event.outcome === 'passed'))) {
    add('TEST_RESULT_MISMATCH', receiptName, 'The recorded command, exit code and verification outcome must agree.');
  }
  for (const [index, stream] of ['stdout', 'stderr'].entries()) {
    const file = outputNames[index];
    const expectedSha256 = sha256(receipt[stream + 'Sha256']) ? receipt[stream + 'Sha256'] : null;
    const actualSha256 = hashes.get(file) ?? null;
    result.outputs.push({ file, expectedSha256, actualSha256 });
    if (receipt[stream + 'File'] !== file || !expectedSha256) {
      add('OUTPUT_REFERENCE_INVALID', receiptName, 'The receipt must name the supported output files with valid SHA-256 digests.');
    }
    if (!actualSha256) add('MISSING_TEST_OUTPUT', file, 'A completed verification is missing a recorded test output.');
    else if (expectedSha256 && actualSha256 !== expectedSha256) {
      add('OUTPUT_HASH_MISMATCH', file, 'The output digest differs from the test receipt.');
    }
  }
  if (event.outcome === 'failed') diagnostics.push(issue('TEST_FAILED', receiptName, 'The completed verification recorded a failing test.'));
  return { ...result, status: problems.length ? 'mismatch' : 'verified' };
}

export async function importEditTestFolder(files) {
  if (!globalThis.crypto?.subtle) throw invalid('folder', 'Open the dashboard on localhost to verify file digests.');
  const selected = selectFiles(files);
  for (const name of ['SHA256SUMS', 'setup.json', 'grants.jsonl', 'attempts.jsonl', 'actions.jsonl']) {
    if (!selected.has(name)) throw invalid(name, 'A required setup, manifest or ledger file is missing.');
  }
  const contents = new Map();
  const hashes = new Map();
  for (const name of Object.keys(editTestFolderLimits)) {
    if (!selected.has(name)) continue;
    const bytes = await readFile(selected.get(name), name);
    contents.set(name, bytes);
    if (name !== 'SHA256SUMS') hashes.set(name, await digest(bytes));
  }
  const diagnostics = [];
  checkManifest(contents, parseManifest(contents.get('SHA256SUMS')), hashes, diagnostics);
  const setup = parseSetup(contents.get('setup.json'));
  const grants = ledger(contents.get('grants.jsonl'), 'grants.jsonl', 3);
  diagnostics.push(...validateEditTestGrants(grants));
  if (hashes.get('grants.jsonl') !== setup.grantFileSha256) {
    diagnostics.push(issue('GRANT_HASH_MISMATCH', 'grants.jsonl', 'The supplied grants differ from the ledger digest recorded during setup.'));
  }
  const getRows = name => stageRows(ledger(contents.get(name), name, 2), name);
  const actions = getRows('actions.jsonl');
  const attempts = getRows('attempts.jsonl');
  const stage = action => assessStage(action, actions.get(action), attempts.get(action), grants, setup, diagnostics);
  const editor = stage('file:write');
  const verifier = stage('test:execute');
  const editEvidence = actions.get('file:write')?.evidence;
  editor.beforeSha256 = sha256(editEvidence?.beforeSha256) ? editEvidence.beforeSha256 : null;
  editor.afterSha256 = sha256(editEvidence?.afterSha256) ? editEvidence.afterSha256 : null;
  if (editor.completed && (!exactKeys(editEvidence, ['beforeSha256', 'afterSha256'])
      || editor.beforeSha256 !== setup.originalSourceSha256 || !editor.afterSha256 || editor.beforeSha256 === editor.afterSha256)) {
    diagnostics.push(issue('EDIT_EVIDENCE_MISMATCH', 'actions.jsonl', 'The edit must link the original source digest to a different edited digest.'));
  }
  checkHandoff(editor, verifier, setup, diagnostics);
  const receipt = assessReceipt(actions.get('test:execute'), editor, setup, contents, hashes, diagnostics);
  const verified = !diagnostics.length && editor.authority === 'within-scope' && verifier.authority === 'within-scope'
    && editor.completed && verifier.completed && verifier.outcome === 'passed' && receipt.status === 'verified';
  const findings = new Map(diagnostics.map(finding => [JSON.stringify(finding), finding]));
  return { runId: setup.runId, status: verified ? 'verified' : 'open', editor, verifier, receipt,
    diagnostics: [...findings.values()] };
}
