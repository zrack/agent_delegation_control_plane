import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { importInvoiceFolder } from '../../src/invoice-import.mjs';
import {
  assessFollowUp, assessReview, assessSavedInvoice, attachInvoiceFollowUp, attachReviewFollowUp, createReviewCase,
  resolveReviewCase, restoreReviews, REVIEW_STORAGE_KEY, saveInvoiceCandidate, saveReview, saveReviewDecision,
} from '../../src/review.mjs';
import { restoreWorkflowBaselines, runFingerprint, saveInvestigation, saveWorkflowBaseline } from '../../src/storage.mjs';
import { parseInvestigation } from '../../src/import.mjs';

function folder(id = 'SANDBOX-000000000001') {
  const stamp = '2026-01-01T00:00:00Z';
  const end = '2026-01-01T00:02:00Z';
  const scope = [
    { action: 'code:execute', resource: `sandbox:${id}` },
    { action: 'artifact:verify', resource: `sandbox:${id}:results.json` },
  ];
  const result = { invoice_count: 1, subtotal_cents: 100, tax_cents: 7, total_cents: 107 };
  const files = {
    'results.json': JSON.stringify(result),
    'expected.json': JSON.stringify(result),
    'validation.json': JSON.stringify({ passed: true, actual: result }),
    'execution.json': JSON.stringify({ status: 'completed', exit_code: 0, input_unchanged: true, cleaned: true }),
  };
  const evidence = scope.map(({ action }, index) => ({
    callId: 'call-' + index, tool: action, artifactSha256: digest(files['results.json']),
  }));
  const identity = { principal: 'owner', validFrom: stamp, expiresAt: end };
  files['investigation.json'] = JSON.stringify({ schemaVersion: 1, chain: {
    id, principal: { id: 'owner' }, rootGrantId: 'g1',
    grants: [
      { ...identity, id: 'g1', parentGrantId: null, issuer: 'owner', subject: 'Coder', capabilities: scope, canDelegate: true },
      { ...identity, id: 'g2', parentGrantId: 'g1', issuer: 'Coder', subject: 'Verifier', capabilities: [scope[1]], canDelegate: false },
    ],
    events: ['Coder', 'Verifier'].map((actor, index) => ({
      id: 'e' + (index + 1), actor, parentEventId: index ? 'e1' : null, authorityId: 'g' + (index + 1),
      action: { ...scope[index], outcome: 'completed', at: '2026-01-01T00:01:00Z' }, evidence: evidence[index],
    })),
  } });
  files['attempts.json'] = JSON.stringify(['Coder', 'Verifier'].map((actor, index) => ({
    actor, ...scope[index], callId: evidence[index].callId, outcome: 'allowed',
  })));
  return files;
}

const digest = text => createHash('sha256').update(text).digest('hex');
const manifestFor = files => ({
  case: 'invoice-b',
  files: Object.fromEntries(Object.entries(files).map(([name, contents]) => [name, digest(contents)])),
});
function selectedFiles(files, manifest = manifestFor(files)) {
  return Object.entries({ ...files, 'manifest.json': JSON.stringify(manifest) })
    .map(([name, contents]) => Object.assign(new Blob([contents]), { webkitRelativePath: 'invoice-b/' + name }));
}

test('checks authority, exact invoice output, and execution independently from one selected folder', async () => {
  const files = selectedFiles(folder());
  files.push({ webkitRelativePath: 'invoice-b/nested/validation.json' });
  files.push({ webkitRelativePath: 'invoice-b/program.py' });
  const check = await importInvoiceFolder(files);
  assert.equal(check.caseId, 'invoice-b');
  assert.ok(Object.values(check.receiptStates).every(state => state === 'matched'));
  assert.equal(check.authority.label, 'Within scope');
  assert.equal(check.output.label, 'Totals verified');
  assert.equal(check.output.totals.total_cents, 107);
  assert.equal(check.execution.label, 'Execution recorded complete');
  assert.deepEqual(check.execution.attempts, { allowed: 2, denied: 0 });
});

test('a missing validation receipt makes output unverifiable with authority and execution still checked', async () => {
  const files = folder();
  const manifest = manifestFor(files);
  delete files['validation.json'];
  const check = await importInvoiceFolder(selectedFiles(files, manifest));
  assert.equal(check.receiptStates['validation.json'], 'missing');
  assert.equal(check.output.label, 'Unverifiable');
  assert.equal(check.authority.tone, 'valid');
  assert.equal(check.execution.tone, 'valid');
});

test('altered output bytes cannot receive a passing verdict', async () => {
  const files = folder();
  const manifest = manifestFor(files);
  files['results.json'] += '\n';
  const check = await importInvoiceFolder(selectedFiles(files, manifest));
  assert.equal(check.receiptStates['results.json'], 'mismatch');
  assert.equal(check.output.label, 'Hash mismatch');
  assert.equal(check.authority.tone, 'valid');
  assert.equal(check.execution.tone, 'valid');
  const updated = await importInvoiceFolder(selectedFiles(files));
  assert.equal(updated.receiptStates['results.json'], 'matched');
  assert.equal(updated.output.label, 'Evidence disagrees');
});

test('a matching execution receipt can report a failure independently of output and authority', async () => {
  const files = folder();
  files['execution.json'] = JSON.stringify({ status: 'artifact_invalid', exit_code: 0, input_unchanged: false, cleaned: true });
  const check = await importInvoiceFolder(selectedFiles(files));
  assert.equal(check.receiptStates['execution.json'], 'matched');
  assert.equal(check.execution.label, 'Execution needs review');
  assert.equal(check.execution.receipt.status, 'Artifact collection failed');
  assert.equal(check.output.tone, 'valid');
  assert.equal(check.authority.tone, 'valid');
});

test('a listed file without a usable hash is not accepted and missing manifests reject the import', async () => {
  const files = folder();
  const manifest = manifestFor(files);
  delete manifest.files['execution.json'];
  const check = await importInvoiceFolder(selectedFiles(files, manifest));
  assert.equal(check.receiptStates['execution.json'], 'unlisted');
  assert.equal(check.execution.tone, 'unknown');
  assert.equal(check.output.tone, 'valid');
  await assert.rejects(importInvoiceFolder(selectedFiles(files).filter(file => !file.webkitRelativePath.endsWith('/manifest.json'))),
    /folder containing manifest\.json/);
});

test('malformed or non-integer output is invalid even when the manifest hash matches', async () => {
  const files = folder();
  for (const output of [
    files['results.json'].replace('107', '107.0'),
    files['results.json'].replace('{', '{"total_cents":0,'),
  ]) {
    const candidate = { ...files, 'results.json': output };
    const check = await importInvoiceFolder(selectedFiles(candidate));
    assert.equal(check.receiptStates['results.json'], 'invalid');
    assert.equal(check.output.tone, 'unknown');
  }
});

async function savedWorkflow() {
  const records = new Map();
  const getStorage = () => ({
    getItem: key => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
  });
  const baseline = parseInvestigation(folder()['investigation.json']);
  saveInvestigation(getStorage, baseline);
  saveWorkflowBaseline(getStorage, 'Invoices', baseline, await runFingerprint(baseline));
  return { getStorage, baseline, pin: restoreWorkflowBaselines(getStorage).baselines[0] };
}

test('saved invoice comparisons recheck exact receipts and preserve different snapshots of the same run', async () => {
  const { getStorage, pin } = await savedWorkflow();
  const files = folder('SANDBOX-000000000002');
  const manifest = manifestFor(files);
  const clean = await importInvoiceFolder(selectedFiles(files));
  const missing = { ...files };
  delete missing['validation.json'];
  const altered = { ...files, 'results.json': files['results.json'] + '\n' };
  const cases = [
    [clean, 'Totals verified'],
    [await importInvoiceFolder(selectedFiles(missing, manifest)), 'Unverifiable'],
    [await importInvoiceFolder(selectedFiles(altered, manifest)), 'Hash mismatch'],
  ];
  for (const [folder, output] of cases) {
    const id = await saveInvoiceCandidate(getStorage, pin, folder.evidence);
    const item = restoreReviews(getStorage).items.find(item => item.id === id);
    assert.equal((await assessReview(item)).verdict.status, 'pass');
    const receipts = await assessSavedInvoice(item);
    assert.equal(receipts.output.label, output);
    assert.equal(receipts.execution.label, 'Execution recorded complete');
    assert.deepEqual(receipts.receiptStates, folder.receiptStates);
  }
  const before = restoreReviews(getStorage).items;
  assert.equal(before.length, 3);
  const original = before.find(item => item.invoice.outputAtImport === 'Totals verified');
  saveReview(getStorage, original, 'Check matches the snapshot.', true);
  assert.equal(await saveInvoiceCandidate(getStorage, pin, clean.evidence), original.id);
  const restored = restoreReviews(getStorage).items;
  assert.equal(restored.length, 3);
  assert.equal(restored[0].note, 'Check matches the snapshot.');

  const storage = getStorage();
  const raw = JSON.parse(storage.getItem(REVIEW_STORAGE_KEY));
  raw.items[0].invoice.evidence.files['results.json'] = btoa('changed bytes');
  storage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(raw));
  const item = restoreReviews(getStorage).items[0];
  assert.equal((await assessReview(item)).verdict.status, 'pass');
  await assert.rejects(assessSavedInvoice(item), /no longer match the snapshot/);
});

test('a changed pin or replaced baseline export cannot save an invoice comparison', async () => {
  const { getStorage, baseline, pin } = await savedWorkflow();
  const checked = await importInvoiceFolder(selectedFiles(folder('SANDBOX-000000000002')));
  const changed = { ...baseline, title: 'Changed baseline' };
  saveInvestigation(getStorage, changed);
  await assert.rejects(saveInvoiceCandidate(getStorage, pin, checked.evidence), /Reimport the original/);
  saveWorkflowBaseline(getStorage, pin.name, changed, await runFingerprint(changed), pin);
  await assert.rejects(saveInvoiceCandidate(getStorage, pin, checked.evidence), /pin changed/);
  assert.equal(restoreReviews(getStorage).items.length, 0);
});

test('invoice receipt failures stay open until a matching corrected folder passes after reload', async () => {
  const { getStorage, pin } = await savedWorkflow();
  const files = folder('SANDBOX-000000000002');
  const manifest = manifestFor(files);
  const missing = { ...files };
  delete missing['validation.json'];
  const altered = { ...files, 'results.json': files['results.json'] + '\n' };
  const corrected = await importInvoiceFolder(selectedFiles(files, manifest));
  for (const original of [missing, altered]) {
    const failed = await importInvoiceFolder(selectedFiles(original, manifest));
    const id = await saveInvoiceCandidate(getStorage, pin, failed.evidence);
    const read = () => restoreReviews(getStorage).items.find(item => item.id === id);
    const assess = async () => assessFollowUp(read(), await assessReview(read()));
    assert.equal((await assessReview(read())).verdict.status, 'pass');
    assert.equal((await assess()).flagged, true);
    assert.equal((await assess()).canResolve, false);
    saveReviewDecision(getStorage, read(), 'fix-required', 'Restore the original receipt.');
    await assert.rejects(attachReviewFollowUp(getStorage, read(), '{}'), /Attach an invoice folder/);
    await attachInvoiceFollowUp(getStorage, read(), failed.evidence);
    assert.equal((await assess()).invoice.checked.output.label, failed.output.label);
    await assert.rejects(resolveReviewCase(getStorage, read()), /passing invoice follow-up/);

    const failingExecution = { ...files, 'execution.json': JSON.stringify({
      status: 'failed', exit_code: 1, input_unchanged: true, cleaned: true,
    }) };
    const execution = await importInvoiceFolder(selectedFiles(failingExecution));
    await attachInvoiceFollowUp(getStorage, read(), execution.evidence);
    assert.equal((await assess()).invoice.checked.execution.label, 'Execution needs review');
    await assert.rejects(resolveReviewCase(getStorage, read()), /passing invoice follow-up/);

    await attachInvoiceFollowUp(getStorage, read(), corrected.evidence);
    const ready = await assess();
    assert.equal(ready.canResolve, true);
    assert.equal(ready.resolved, false);
    await resolveReviewCase(getStorage, read());
    assert.equal((await assess()).resolved, true);
    assert.equal(read().followUp.report.baselineFingerprint, pin.fingerprint);
    const exported = JSON.parse(await createReviewCase(read()));
    assert.equal(exported.followUp, undefined);
    assert.equal(exported.resolution, undefined);

    const storage = getStorage();
    const saved = JSON.parse(storage.getItem(REVIEW_STORAGE_KEY));
    const entry = saved.items.find(item => item.id === id);
    entry.followUp.invoice.evidence.files['results.json'] = btoa('altered after closure');
    storage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(saved));
    assert.equal((await assess()).resolved, false);
    assert.match((await assess()).invoice.error, /no longer match/);
  }
});

test('a different pin cannot attach or close an invoice follow-up', async () => {
  const { getStorage, baseline, pin } = await savedWorkflow();
  const files = folder('SANDBOX-000000000002');
  const manifest = manifestFor(files);
  const missing = { ...files };
  delete missing['validation.json'];
  const original = await importInvoiceFolder(selectedFiles(missing, manifest));
  const corrected = await importInvoiceFolder(selectedFiles(files, manifest));
  const id = await saveInvoiceCandidate(getStorage, pin, original.evidence);
  const read = () => restoreReviews(getStorage).items.find(item => item.id === id);
  saveReviewDecision(getStorage, read(), 'evidence-needed', 'Supply validation.');
  await attachInvoiceFollowUp(getStorage, read(), corrected.evidence);
  const changed = { ...baseline, title: 'Different evidence under the baseline ID' };
  saveInvestigation(getStorage, changed);
  saveWorkflowBaseline(getStorage, pin.name, changed, await runFingerprint(changed), pin);
  await assert.rejects(attachInvoiceFollowUp(getStorage, read(), corrected.evidence), /different baseline/);
  await assert.rejects(resolveReviewCase(getStorage, read()), /different baseline/);
  const rechecked = await assessFollowUp(read(), await assessReview(read()), getStorage);
  assert.equal(rechecked.pinChanged, true);
  assert.equal(rechecked.canResolve, false);
  assert.equal(rechecked.resolved, false);
});

test('a folder for a different case or a changed investigation under the same ID cannot be a correction', async () => {
  const { getStorage, pin } = await savedWorkflow();
  const files = folder('SANDBOX-000000000002');
  const manifest = manifestFor(files);
  const missing = { ...files };
  delete missing['validation.json'];
  const original = await importInvoiceFolder(selectedFiles(missing, manifest));
  const id = await saveInvoiceCandidate(getStorage, pin, original.evidence);
  const read = () => restoreReviews(getStorage).items.find(item => item.id === id);
  saveReviewDecision(getStorage, read(), 'evidence-needed', 'Supply validation.');
  const unrelated = await importInvoiceFolder(selectedFiles(files, { ...manifest, case: 'invoice-c' }));
  await assert.rejects(attachInvoiceFollowUp(getStorage, read(), unrelated.evidence), /same invoice case/);
  const changed = JSON.parse(files['investigation.json']);
  changed.chain.title = 'Modified investigation';
  const replacement = await importInvoiceFolder(selectedFiles({ ...files, 'investigation.json': JSON.stringify(changed) }));
  await assert.rejects(attachInvoiceFollowUp(getStorage, read(), replacement.evidence), /changed the investigation/);
  assert.equal(read().followUp, undefined);
});
