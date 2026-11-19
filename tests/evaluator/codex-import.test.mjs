import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { assessCodexEvidence, importCodexFolder } from '../../src/codex-import.mjs';
import { evaluateChain } from '../../src/evaluator.mjs';
import { assessFollowUp, assessReview, attachCodexFollowUp, attachInvoiceFollowUp, attachReviewFollowUp, createReviewCase, importReviewPackage,
  resolveReviewCase, restoreReviews, REVIEW_STORAGE_KEY, saveCodexCandidate, saveReview, saveReviewDecision } from '../../src/review.mjs';
import { runFingerprint, saveInvestigation, saveWorkflowBaseline, WORKFLOW_BASELINE_KEY } from '../../src/storage.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const jsonl = records => records.map(record => JSON.stringify(record) + '\n').join('');

function capture() {
  const at = '2026-01-01T00:01:00Z';
  const owner = 'fictional-owner';
  const resource = 'repo://fixture/docs/quickstart.md';
  const before = 'Old quickstart.\n';
  const after = 'New quickstart.\n';
  const capabilities = ['file:read', 'file:write'].map(action => ({ action, resource }));
  const grant = (id, parentGrantId, issuer, subject, canDelegate) => ({
    id, parentGrantId, issuer, subject, principal: owner, capabilities, canDelegate,
    validFrom: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T00:02:00Z',
  });
  const action = (id, parentEventId, actor, authorityId, capability, tool, artifact) => ({
    id, parentEventId, actor, authorityId, action: { ...capability, at, outcome: 'completed' },
    evidence: { tool, callId: 'call-' + id, artifactSha256: sha(artifact) },
  });
  const grants = [grant('root', null, owner, 'coordinator', true), grant('edit', 'root', 'coordinator', 'agent', false)];
  const actions = [
    action('fixture-inspect', null, 'coordinator', 'root', capabilities[0], 'preflight_read', before),
    action('fixture-read', 'fixture-inspect', 'agent', 'edit', capabilities[0], 'read_quickstart', before),
    action('fixture-write', 'fixture-inspect', 'agent', 'edit', capabilities[1], 'update_preview_paragraph', after),
  ];
  return {
    'actions.jsonl': jsonl(actions),
    'grants.jsonl': jsonl(grants),
    'attempts.jsonl': jsonl(actions.slice(1).map(({ evidence }) => ({
      tool: evidence.tool, callId: evidence.callId, at, status: 'completed',
    }))),
    'before.md': before,
    'after.md': after,
    'quickstart.diff': '-Old quickstart.\n+New quickstart.\n',
    'codex-events.jsonl': '{"type":"turn.completed"}\n',
  };
}

function manifest(files) {
  return JSON.stringify(Object.fromEntries(Object.entries(files).map(([name, contents]) => [name, sha(contents)])));
}

function selection(files, originalManifest = manifest(files), root = 'fixture') {
  return Object.entries({ ...files, 'manifest.json': originalManifest }).map(([name, contents]) =>
    Object.assign(new Blob([contents]), { webkitRelativePath: root + '/' + name }));
}

test('checks every listed capture file and imports the action and grant evidence', async () => {
  const files = capture();
  const selected = selection(files);
  selected.push({ webkitRelativePath: 'fixture/codex-stderr.log' });
  selected.push({ webkitRelativePath: 'fixture/nested/after.md' });
  const { chain, verifiedFileCount } = await importCodexFolder(selected);
  assert.equal(verifiedFileCount, 7);
  assert.equal(chain.principal.id, 'fictional-owner');
  assert.equal(chain.events[2].evidence.artifactSha256, sha(files['after.md']));
  assert.equal(evaluateChain(chain).status, 'valid');
  assert.equal((await importCodexFolder(selection(files, manifest(files), 'renamed'))).chain.id, chain.id);
  assert.equal(chain.before, undefined);
});

test('preserves the missing grant as uncertainty at both affected hops and a separate run', async () => {
  const files = capture();
  const complete = await importCodexFolder(selection(files));
  files['grants.jsonl'] = files['grants.jsonl'].split('\n')[0] + '\n';
  const { chain } = await importCodexFolder(selection(files));
  assert.notEqual(chain.id, complete.chain.id);
  const result = evaluateChain(chain);
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.findings.filter(item => item.code === 'GRANT_MISSING').map(item => item.eventId),
    ['fixture-read', 'fixture-write']);
  files['grants.jsonl'] = '';
  assert.equal(evaluateChain((await importCodexFolder(selection(files))).chain).status, 'unknown');
});

test('rejects an altered receipt before import even if its manifest entry was refreshed', async () => {
  const files = capture();
  const originalManifest = manifest(files);
  files['after.md'] += 'Altered bytes.\n';
  await assert.rejects(importCodexFolder(selection(files, originalManifest)), /after\.md hash mismatch/);
  await assert.rejects(importCodexFolder(selection(files)), /after\.md does not match the digest recorded by its action/);
});

test('rejects missing or inconsistent completion receipts', async () => {
  const files = capture();
  files['attempts.jsonl'] = files['attempts.jsonl'].replace('call-fixture-write', 'call-different-action');
  await assert.rejects(importCodexFolder(selection(files)), /does not match its tool receipt/);
  files['attempts.jsonl'] += files['attempts.jsonl'];
  await assert.rejects(importCodexFolder(selection(files)), /invalid or duplicate tool call/);
});

test('rejects ambiguous, missing, or oversized evidence without reading unrelated files', async () => {
  const files = capture();
  const originalManifest = manifest(files);
  const duplicate = originalManifest.replace('{', '{"after.md":"' + sha(files['after.md']) + '",');
  await assert.rejects(importCodexFolder(selection(files, duplicate)), /exactly the seven/);
  await assert.rejects(importCodexFolder(selection(files).filter(file => !file.webkitRelativePath.endsWith('/grants.jsonl'))),
    /Missing grants\.jsonl/);
  await assert.rejects(importCodexFolder([...selection(files), { webkitRelativePath: 'different/manifest.json' }]), /Choose one/);
  files['before.md'] = ' '.repeat(128 * 1024 + 1);
  await assert.rejects(importCodexFolder(selection(files)), /before\.md exceeds/);
});

test('keeps receipt bytes only on request and rechecks a saved case after serialization', async () => {
  const files = capture();
  assert.equal((await importCodexFolder(selection(files))).evidence, undefined);
  const imported = await importCodexFolder(selection(files), { retainEvidence: true });
  const snapshot = JSON.parse(JSON.stringify(imported.evidence));
  assert.deepEqual(snapshot.hashes, JSON.parse(manifest(files)));
  const retained = ['actions.jsonl', 'grants.jsonl', 'attempts.jsonl', 'before.md', 'after.md'];
  assert.deepEqual(Object.keys(snapshot.files), retained);
  for (const name of retained) assert.deepEqual(Buffer.from(snapshot.files[name], 'base64'), Buffer.from(files[name]));

  const checked = await assessCodexEvidence(snapshot);
  assert.equal(imported.verifiedFileCount, 7);
  assert.equal(checked.verifiedFileCount, 5);
  assert.deepEqual(checked.chain, imported.chain);
  assert.deepEqual(checked.evidence, snapshot);

  files['grants.jsonl'] = files['grants.jsonl'].split('\n')[0] + '\n';
  const missing = await importCodexFolder(selection(files), { retainEvidence: true });
  const { chain } = await assessCodexEvidence(JSON.parse(JSON.stringify(missing.evidence)));
  assert.deepEqual(evaluateChain(chain).findings.filter(item => item.code === 'GRANT_MISSING').map(item => item.eventId),
    ['fixture-read', 'fixture-write']);
});

test('rejects changed receipt bytes, malformed or oversized snapshots, and refreshed hashes that conflict with the action', async () => {
  const { evidence } = await importCodexFolder(selection(capture()), { retainEvidence: true });
  const recheckFile = (name, contents) => assessCodexEvidence({ ...evidence, files: { ...evidence.files, [name]: contents } });
  await assert.rejects(recheckFile('after.md', '%%%'), /Invalid or oversized saved Codex receipt/);
  await assert.rejects(recheckFile('after.md', 'A'.repeat(175000)), /Invalid or oversized saved Codex receipt/);
  const altered = 'Changed output bytes.\r\n';
  const changedFiles = { ...evidence.files, 'after.md': Buffer.from(altered).toString('base64') };
  await assert.rejects(assessCodexEvidence({ ...evidence, files: changedFiles }), /after\.md hash mismatch/);
  await assert.rejects(assessCodexEvidence({ hashes: { ...evidence.hashes, 'after.md': sha(altered) }, files: changedFiles }),
    /after\.md does not match the digest recorded by its action/);
  await assert.rejects(recheckFile('codex-events.jsonl', ''), /snapshot is invalid/);
  const missing = structuredClone(evidence);
  delete missing.hashes['quickstart.diff'];
  await assert.rejects(assessCodexEvidence(missing), /snapshot is invalid/);
  await assert.rejects(assessCodexEvidence({ ...evidence, unrelated: 'extra data' }), /snapshot is invalid/);
});

async function savedCodexWorkflow() {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const getStorage = () => storage;
  const baseline = await importCodexFolder(selection(capture()), { retainEvidence: true });
  saveInvestigation(getStorage, baseline.chain);
  const [pin] = saveWorkflowBaseline(getStorage, 'Quickstart edits', baseline.chain, await runFingerprint(baseline.chain));
  return { storage, getStorage, baseline, pin };
}

function nextCapture() {
  const files = capture();
  for (const name of ['actions.jsonl', 'attempts.jsonl']) {
    files[name] = files[name].replaceAll('call-fixture-', 'next-call-');
  }
  return files;
}

test('Codex inbox saves each verdict against the exact pin and rechecks the saved receipts and hop findings', async () => {
  const { getStorage, pin } = await savedCodexWorkflow();
  const missing = nextCapture();
  missing['grants.jsonl'] = missing['grants.jsonl'].split('\n')[0] + '\n';
  const violation = nextCapture();
  const grants = violation['grants.jsonl'].trim().split('\n').map(line => JSON.parse(line));
  grants[1].capabilities.push({ action: 'file:write', resource: 'repo://fixture/docs/other.md' });
  violation['grants.jsonl'] = jsonl(grants);

  for (const [files, expected] of [[nextCapture(), 'pass'], [violation, 'regression'], [missing, 'review']]) {
    const candidate = await importCodexFolder(selection(files), { retainEvidence: true });
    const id = await saveCodexCandidate(getStorage, pin, candidate.evidence);
    const item = restoreReviews(getStorage).items.find(record => record.id === id);
    const checked = await assessReview(item);
    assert.equal(item.report.status, expected);
    assert.equal(item.report.baselineId, pin.runId);
    assert.equal(item.report.baselineFingerprint, pin.fingerprint);
    assert.equal(checked.verdict.status, expected);
    assert.equal(checked.codex.verifiedFileCount, 5);
    assert.deepEqual(checked.codex.chain, candidate.chain);
    if (expected === 'review') {
      const affected = checked.candidateResult.findings.filter(finding => finding.code === 'GRANT_MISSING');
      assert.deepEqual(affected.map(finding => finding.eventId), ['fixture-read', 'fixture-write']);
      const [withNote] = saveReview(getStorage, item, 'Checked both missing-grant hops.', true);
      const [decided] = saveReviewDecision(getStorage, withNote, 'evidence-needed', 'Provide the editor grant.');
      assert.equal(await saveCodexCandidate(getStorage, pin, candidate.evidence), id);
      const snapshot = restoreReviews(getStorage).items[0];
      assert.equal(snapshot.note, decided.note);
      assert.deepEqual(snapshot.decision, decided.decision);
      await assert.rejects(attachReviewFollowUp(getStorage, snapshot, '{}'), /Codex folder cases/);
      await assert.rejects(resolveReviewCase(getStorage, snapshot), /Resolution requires/);
      assert.equal((await assessFollowUp(snapshot, checked)).canResolve, false);
      const exported = await createReviewCase(snapshot, undefined, { includeInvoiceReceipts: true });
      assert.equal(JSON.parse(exported).codex, undefined);
      assert(!exported.includes(candidate.evidence.files['actions.jsonl']));
      const imported = await importReviewPackage(getStorage, exported);
      assert.notEqual(imported.id, id);
      assert.equal(restoreReviews(getStorage).items.length, 4);
    }
  }
});

test('Codex inbox preserves existing cases and pins on duplicate baseline, changed pin, altered receipt or write failure', async () => {
  const { storage, getStorage, baseline, pin } = await savedCodexWorkflow();
  const { evidence } = await importCodexFolder(selection(nextCapture()), { retainEvidence: true });
  await saveCodexCandidate(getStorage, pin, evidence);
  const original = storage.getItem(REVIEW_STORAGE_KEY);
  const savedPin = storage.getItem(WORKFLOW_BASELINE_KEY);
  const altered = structuredClone(evidence);
  altered.files['after.md'] = btoa('Changed after the snapshot.');
  await assert.rejects(saveCodexCandidate(getStorage, pin, altered), /after\.md hash mismatch/);
  await assert.rejects(saveCodexCandidate(getStorage, pin, baseline.evidence), /different run ID/);
  const fullStorage = () => ({ getItem: storage.getItem, setItem() { throw new Error('quota exceeded'); } });
  await assert.rejects(saveCodexCandidate(fullStorage, pin, evidence), /quota exceeded/);
  assert.equal(storage.getItem(WORKFLOW_BASELINE_KEY), savedPin);
  assert.equal(storage.getItem(REVIEW_STORAGE_KEY), original);

  const changed = { ...baseline.chain, title: 'Same ID and different baseline content' };
  saveInvestigation(getStorage, changed);
  await assert.rejects(saveCodexCandidate(getStorage, pin, evidence), /Reimport the original/);
  saveWorkflowBaseline(getStorage, pin.name, changed, await runFingerprint(changed), pin);
  const newPin = storage.getItem(WORKFLOW_BASELINE_KEY);
  await assert.rejects(saveCodexCandidate(getStorage, pin, evidence), /pin changed/);
  assert.equal(storage.getItem(REVIEW_STORAGE_KEY), original);
  assert.equal(storage.getItem(WORKFLOW_BASELINE_KEY), newPin);

  const saved = JSON.parse(original);
  saved.items[0].codex.evidence = altered;
  storage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(saved));
  await assert.rejects(assessReview(restoreReviews(getStorage).items[0]), /after\.md hash mismatch/);
});

const evidenceFor = async files => (await importCodexFolder(selection(files), { retainEvidence: true })).evidence;

async function flaggedCodexCase() {
  const workflow = await savedCodexWorkflow();
  const missing = nextCapture();
  missing['grants.jsonl'] = missing['grants.jsonl'].split('\n')[0] + '\n';
  const evidence = await evidenceFor(missing);
  const id = await saveCodexCandidate(workflow.getStorage, workflow.pin, evidence);
  const read = () => restoreReviews(workflow.getStorage).items.find(item => item.id === id);
  return { ...workflow, read, evidence, corrected: await evidenceFor(nextCapture()) };
}

test('matching Codex correction needs a decision and explicit closure, then rechecks both sets of receipts after reload', async () => {
  const { getStorage, read, evidence, baseline, corrected, pin } = await flaggedCodexCase();
  await assert.rejects(attachCodexFollowUp(getStorage, read(), corrected), /Save a Codex review decision/);
  saveReviewDecision(getStorage, read(), 'evidence-needed', 'Supply the missing editor grant.');
  await assert.rejects(attachReviewFollowUp(getStorage, read(), '{}'), /Codex folder cases/);
  await assert.rejects(attachInvoiceFollowUp(getStorage, read(), {}), /invoice review/);
  await assert.rejects(attachCodexFollowUp(getStorage, read(), evidence), /own candidate run ID/);
  await assert.rejects(attachCodexFollowUp(getStorage, read(), baseline.evidence), /different run ID/);

  const assess = async () => assessFollowUp(read(), await assessReview(read()), getStorage);
  // A successfully verified second capture can still be missing its authority.
  const stillMissing = nextCapture();
  stillMissing['grants.jsonl'] = stillMissing['grants.jsonl'].split('\n')[0] + '\n';
  stillMissing['codex-events.jsonl'] += '{"type":"turn.started"}\n';
  await attachCodexFollowUp(getStorage, read(), await evidenceFor(stillMissing));
  assert.equal((await assess()).assessment.verdict.status, 'review');
  await assert.rejects(resolveReviewCase(getStorage, read()), /passing follow-up/);

  const stale = read();
  await attachCodexFollowUp(getStorage, read(), corrected);
  assert.equal((await assess()).canResolve, true);
  assert.equal((await assess()).resolved, false);
  await assert.rejects(attachCodexFollowUp(getStorage, stale, corrected), /changed. Reopen/);
  await resolveReviewCase(getStorage, read());
  const original = await assessReview(read());
  const reloaded = await assessFollowUp(read(), original, getStorage);
  assert.equal(reloaded.resolved, true);
  assert.equal(original.codex.verifiedFileCount, 5);
  assert.equal(reloaded.assessment.codex.verifiedFileCount, 5);
  assert.equal(reloaded.assessment.verdict.status, 'pass');
  assert.equal(read().followUp.report.baselineFingerprint, pin.fingerprint);

  const exported = JSON.parse(await createReviewCase(read(), undefined, { includeInvoiceReceipts: true }));
  assert.deepEqual(exported.decision, read().decision);
  for (const key of ['codex', 'followUp', 'resolution']) assert.equal(exported[key], undefined);
  saveReviewDecision(getStorage, read(), 'fix-required', 'Record a new decision.');
  assert.equal((await assess()).resolved, false);
});

test('changed Codex inputs cannot replace a correction; changed pins or saved receipts block closure after reload', async () => {
  const { getStorage, storage, baseline, pin, read, corrected } = await flaggedCodexCase();
  saveReviewDecision(getStorage, read(), 'evidence-needed', 'Attach a matching grant.');
  await attachCodexFollowUp(getStorage, read(), corrected);
  await resolveReviewCase(getStorage, read());
  const resolved = storage.getItem(REVIEW_STORAGE_KEY);
  const originalPin = storage.getItem(WORKFLOW_BASELINE_KEY);

  const changed = nextCapture();
  const before = sha(changed['before.md']);
  changed['before.md'] = 'A different starting document.\n';
  changed['actions.jsonl'] = changed['actions.jsonl'].replaceAll(before, sha(changed['before.md']));
  const otherWork = await evidenceFor(changed);
  await assert.rejects(attachCodexFollowUp(getStorage, read(), otherWork), /same preflight actor, resource and starting document/);
  const invalid = structuredClone(corrected);
  invalid.files['after.md'] = btoa('Changed bytes.');
  await assert.rejects(attachCodexFollowUp(getStorage, read(), invalid), /after\.md hash mismatch/);
  assert.equal(storage.getItem(REVIEW_STORAGE_KEY), resolved);
  // The other starting document has a passing baseline comparison on its own.
  const unrelated = await saveCodexCandidate(getStorage, pin, otherWork);
  const passing = restoreReviews(getStorage).items.find(item => item.id === unrelated);
  assert.equal((await assessReview(passing)).verdict.status, 'pass');
  const swapped = { ...read(), followUp: {
    id: passing.id, report: passing.report, candidate: passing.candidate, codex: passing.codex,
  } };
  const swappedCheck = await assessFollowUp(swapped, await assessReview(swapped), getStorage);
  assert.equal(swappedCheck.incompatible, 'candidate');
  assert.equal(swappedCheck.canResolve, false);
  assert.equal(swappedCheck.resolved, false);

  const replacement = { ...baseline.chain, title: 'Altered baseline snapshot' };
  saveInvestigation(getStorage, replacement);
  saveWorkflowBaseline(getStorage, pin.name, replacement, await runFingerprint(replacement), pin);
  const conflict = storage.getItem(WORKFLOW_BASELINE_KEY);
  for (const [pinState, value] of [['conflict', conflict], ['missing', JSON.stringify({ schemaVersion: 1, baselines: [] })]]) {
    storage.setItem(WORKFLOW_BASELINE_KEY, value);
    const beforeFailure = storage.getItem(REVIEW_STORAGE_KEY);
    const checked = await assessFollowUp(read(), await assessReview(read()), getStorage);
    assert.equal(checked.pinState.status, pinState);
    assert.equal(checked.canResolve, false);
    assert.equal(checked.resolved, false);
    await assert.rejects(attachCodexFollowUp(getStorage, read(), corrected), /different baseline or is unavailable/);
    await assert.rejects(resolveReviewCase(getStorage, read()), /different baseline or is unavailable/);
    assert.equal(storage.getItem(REVIEW_STORAGE_KEY), beforeFailure);
    assert.equal(storage.getItem(WORKFLOW_BASELINE_KEY), value);
  }

  saveInvestigation(getStorage, baseline.chain);
  storage.setItem(WORKFLOW_BASELINE_KEY, originalPin);
  const raw = JSON.parse(resolved);
  raw.items[0].followUp.codex.evidence = invalid;
  storage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(raw));
  const badFollowUp = await assessFollowUp(read(), await assessReview(read()), getStorage);
  assert.equal(badFollowUp.canResolve, false);
  assert.equal(badFollowUp.resolved, false);
  assert.match(badFollowUp.error, /after\.md hash mismatch/);

  raw.items[0].followUp.codex.evidence = corrected;
  raw.items[0].codex.evidence.files['after.md'] = invalid.files['after.md'];
  storage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(raw));
  await assert.rejects(assessReview(read()), /after\.md hash mismatch/);
  await assert.rejects(resolveReviewCase(getStorage, read()), /after\.md hash mismatch/);
});
