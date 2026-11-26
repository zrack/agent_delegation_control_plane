// Rehearse a fresh receiver without writing to disk or an existing inbox.
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readText } from './bounded-file.mjs';
import { MAX_IMPORT_BYTES, parseInvestigation } from '../src/import.mjs';
import { canPinBaseline } from '../src/comparison.mjs';
import { evaluateChain } from '../src/evaluator.mjs';
import { codexReceiptNames } from '../src/codex-import.mjs';
import { assessFollowUp, assessReview, importReviewPackage, MAX_REVIEW_PACKAGE_BYTES } from '../src/review.mjs';
import { runFingerprint, saveInvestigation, saveWorkflowBaseline } from '../src/storage.mjs';

const usage = 'node scripts/verify-case.mjs --case CASE.json [--baseline-dir DIRECTORY --workflow NAME] [--json]';

class InputError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

async function receiverStorage(directory, workflow) {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, data) => values.set(key, data) };
  const getStorage = () => storage;
  if (directory === undefined) return getStorage;
  try {
    const chain = parseInvestigation(readText(join(directory, 'investigation.json'), MAX_IMPORT_BYTES));
    const pin = JSON.parse(readText(join(directory, 'pin.json'), 1024));
    const fingerprint = await runFingerprint(chain);
    if (pin?.schemaVersion !== 1 || pin.runId !== chain.id || pin.fingerprint !== fingerprint
        || !canPinBaseline(chain, evaluateChain(chain))) throw new Error();
    saveInvestigation(getStorage, chain);
    saveWorkflowBaseline(getStorage, workflow, chain, fingerprint);
  } catch {
    throw new InputError('invalid-receiver-baseline');
  }
  return getStorage;
}

function failedEvidence(stage, message) {
  const receipt = codexReceiptNames.find(name => message.includes(name));
  const mismatch = message.includes('hash mismatch');
  return { code: stage + (mismatch ? '-receipt-mismatch' : '-evidence-invalid'), ...(receipt ? { receipt } : {}) };
}

async function verify(file, directory, workflow) {
  const storage = await receiverStorage(directory, workflow);
  let raw, bundle, item;
  try {
    raw = readText(file, MAX_REVIEW_PACKAGE_BYTES);
    bundle = JSON.parse(raw);
  } catch {
    throw new InputError('invalid-case-file');
  }
  if (bundle?.kind !== 'adcp-codex-review-case' || bundle.schemaVersion !== 1) {
    throw new InputError('unsupported-case-format');
  }
  try {
    const { items } = await importReviewPackage(storage, raw);
    item = items[0];
  } catch {
    throw new InputError('invalid-case-package');
  }
  const original = await assessReview(item).catch(error => ({ error: error.message }));
  const follow = await assessFollowUp(item, original, storage);
  const pin = follow.pinState.status;
  const disposition = follow.resolved ? 'resolved' : follow.canResolve ? 'open-ready' : 'open-blocked';
  const reasons = [];
  if (original.error) reasons.push(failedEvidence('original', original.error));
  else if (!original.verdict) reasons.push({ code: 'original-comparison-unverified' });
  if (pin !== 'matched') reasons.push({ code: pin === 'conflict' ? 'conflicting-pin' : pin + '-pin' });
  if (!item.followUp) reasons.push({ code: bundle.followUp ? 'incompatible-follow-up' : 'missing-follow-up' });
  else if (follow.error) reasons.push(failedEvidence('follow-up', follow.error));
  else if (!original.error && follow.incompatible) reasons.push({ code: 'incompatible-follow-up' });
  else if (!original.error && follow.assessment?.verdict?.status !== 'pass') reasons.push({ code: 'follow-up-not-passing' });
  if (follow.resolved) reasons.push({ code: 'verified-closure' });
  else if (follow.canResolve) reasons.push({ code: 'explicit-closure-needed' });
  if (bundle.resolution !== undefined && !item.resolution) reasons.push({ code: 'unverified-closure-record' });
  if (!reasons.length) reasons.push({ code: 'closure-conditions-unmet' });
  const grants = [...new Set((original.candidateResult?.findings ?? []).flatMap(f => f.grantId ? [f.grantId] : []))];
  return {
    schemaVersion: 1, input: 'valid', disposition, reasons,
    checks: { pin, original: original.verdict?.status ?? 'unverified',
      followUp: follow.assessment?.verdict?.status ?? (item.followUp ? 'unverified' : 'absent') },
    ...(grants.length ? { originalGrantReferences: grants } : {}),
  };
}

let result;
let json = process.argv.slice(2).includes('--json');
try {
  let values;
  try {
    ({ values } = parseArgs({ options: { case: { type: 'string' }, 'baseline-dir': { type: 'string' },
      workflow: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' } } }));
  } catch {
    throw new InputError('invalid-arguments');
  }
  if (values.help) { console.log(usage); process.exit(0); }
  json = Boolean(values.json);
  if (!values.case || (values['baseline-dir'] !== undefined) !== (values.workflow !== undefined)) {
    throw new InputError('invalid-arguments');
  }
  result = await verify(values.case, values['baseline-dir'], values.workflow);
  process.exitCode = result.disposition === 'resolved' ? 0 : 1;
} catch (error) {
  result = { schemaVersion: 1, input: 'invalid', disposition: null,
    reasons: [{ code: error instanceof InputError ? error.code : 'verification-error' }] };
  process.exitCode = 2;
}
if (json) console.log(JSON.stringify(result));
else {
  console.log(result.disposition ?? 'Cannot verify input');
  if (result.checks) console.log('Receiver pin: %s | original: %s | follow-up: %s',
    result.checks.pin, result.checks.original, result.checks.followUp);
  for (const reason of result.reasons) console.log('-', reason.code, reason.receipt ?? '');
  if (result.originalGrantReferences?.length) console.log('Original grant references:', result.originalGrantReferences.join(', '));
  if (result.input === 'invalid') console.log(usage);
}
