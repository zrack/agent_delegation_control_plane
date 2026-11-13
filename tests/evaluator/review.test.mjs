import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chains } from '../../src/fixtures.mjs';
import { parseInvestigation } from '../../src/import.mjs';
import { assessFollowUp, assessReview, attachReviewFollowUp, createReviewCase, createReviewPackage, importReview, importReviewPackage,
  removeReview, resolveReviewCase, restoreReviews, REVIEW_STORAGE_KEY, saveReview, saveReviewDecision } from '../../src/review.mjs';
import { runFingerprint } from '../../src/storage.mjs';

const [overreach, valid, missing] = chains;
const normalize = (chain, id = `offline-${chain.id}`) => parseInvestigation(JSON.stringify({ schemaVersion: 1, chain: { ...chain, id } }));
const baseline = normalize(valid);
const reportFor = async (candidate, status, pinned = baseline) => JSON.stringify({
  schemaVersion: 1, status, reasons: [], baselineId: pinned.id, baselineFingerprint: await runFingerprint(pinned),
  candidateId: candidate.id, candidateFingerprint: await runFingerprint(candidate),
});
const memory = () => {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
};

test('inbox restores snapshots and recomputes all three verdicts independently of imported claims', async () => {
  const storage = memory();
  const getStorage = () => storage;
  const pass = { ...baseline, id: 'offline-candidate-pass' };
  const cases = [[pass, 'pass'], [normalize(overreach), 'regression'], [normalize(missing), 'review']];
  for (const [candidate, verdict] of cases) {
    const claimed = verdict === 'regression' ? 'pass' : verdict;
    const { id } = await importReview(getStorage, await reportFor(candidate, claimed), { baseline, candidate });
    const saved = restoreReviews(getStorage).items.find(item => item.id === id);
    assert.equal(saved.report.status, claimed);
    const assessed = await assessReview(saved);
    assert.deepEqual(assessed.states, { baseline: 'matched', candidate: 'matched' });
    assert.equal(assessed.verdict.status, verdict);
    if (verdict === 'regression') assert.equal(assessed.verdict.reasons[0].eventId, 'CH-002-e3');
    if (verdict === 'review') assert.equal(assessed.verdict.reasons[0].eventId, 'CH-003-e2');
  }
  assert.equal(restoreReviews(getStorage).items.length, 3);
});

test('changed same-ID evidence cannot replace a matching snapshot and missing evidence can be attached later', async () => {
  const storage = memory();
  const getStorage = () => storage;
  const candidate = normalize(missing);
  const report = await reportFor(candidate, 'review');
  const changed = { ...candidate, summary: 'Different evidence under the same ID' };
  const { id, items, mismatches } = await importReview(getStorage, report, { candidate: changed });
  assert.deepEqual(mismatches, ['candidate']);
  assert.deepEqual((await assessReview(items[0])).states, { baseline: 'missing', candidate: 'mismatch' });
  saveReview(getStorage, items[0], 'Request original evidence.', true);
  await importReview(getStorage, report, { baseline, candidate });
  await importReview(getStorage, report, { candidate: changed });
  const [restored] = restoreReviews(getStorage).items;
  assert.equal(restored.id, id);
  assert.equal(restored.note, 'Request original evidence.');
  assert.equal(restored.reviewed, true);
  assert.equal((await assessReview(restored)).verdict.status, 'review');
  const persisted = JSON.parse(storage.getItem(REVIEW_STORAGE_KEY));
  assert.equal(persisted.items[0].candidate.summary, candidate.summary);
  persisted.items[0].candidate.summary = changed.summary;
  storage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(persisted));
  const assessment = await assessReview(restoreReviews(getStorage).items[0]);
  assert.equal(assessment.states.candidate, 'mismatch');
  assert.equal(assessment.verdict, undefined);
});

test('report-only review preserves separate notes and stale writes cannot overwrite a newer review', async () => {
  const storage = memory();
  const getStorage = () => storage;
  const text = JSON.stringify({ schemaVersion: 1, status: 'review', comparisonHash: 'javascript:evil()',
    reasons: [{ impact: 'review', message: 'The offline check could not complete.' }] });
  const { items: [item] } = await importReview(getStorage, text, {});
  assert.equal(item.report.comparisonHash, undefined);
  assert.deepEqual((await assessReview(item)).states, { baseline: 'unavailable', candidate: 'unavailable' });
  const [saved] = saveReview(getStorage, item, 'Check the baseline pin.', true);
  assert.throws(() => saveReview(getStorage, item, 'Stale draft.', false), /changed in another tab/);
  assert.throws(() => removeReview(getStorage, item), /changed/);
  assert.deepEqual(removeReview(getStorage, saved), []);
  assert.deepEqual(restoreReviews(getStorage).items, []);
});

test('review packages round-trip matching evidence and include notes only by choice', async () => {
  const candidate = normalize(overreach);
  const report = JSON.parse(await reportFor(candidate, 'regression'));
  const evidence = { baseline, candidate, note: 'Local draft', reviewed: true };
  const withoutNote = await createReviewPackage(report, evidence);
  assert.equal(JSON.parse(withoutNote).note, undefined);
  assert.equal(JSON.parse(withoutNote).reviewed, undefined);
  const withNote = await createReviewPackage(report, evidence, 'Export was outside scope.');
  const storage = memory();
  const getStorage = () => storage;
  const { items: [received] } = await importReviewPackage(getStorage, withNote);
  assert.equal(received.note, 'Export was outside scope.');
  assert.equal(received.reviewed, false);
  assert.equal((await assessReview(received)).verdict.status, 'regression');
  saveReview(getStorage, received, 'My local review.', true);
  await importReviewPackage(getStorage, withNote);
  const [saved] = restoreReviews(getStorage).items;
  assert.equal(saved.note, 'My local review.');
  assert.equal(saved.reviewed, true);
});

test('altered package evidence is excluded and partial packages retain the reported verdict', async () => {
  const candidate = normalize(missing);
  const report = JSON.parse(await reportFor(candidate, 'review'));
  const changed = { ...candidate, summary: 'Altered after packaging' };
  const partial = JSON.parse(await createReviewPackage(report, { baseline, candidate: changed }));
  assert.equal(partial.candidate, undefined);
  const storage = memory();
  const getStorage = () => storage;
  const { items: [received], mismatches } = await importReviewPackage(getStorage, JSON.stringify({ ...partial,
    candidate: { schemaVersion: 1, chain: changed },
  }));
  assert.deepEqual(mismatches, ['candidate']);
  assert.equal(received.report.status, 'review');
  const assessment = await assessReview(received);
  assert.deepEqual(assessment.states, { baseline: 'matched', candidate: 'mismatch' });
  assert.equal(assessment.verdict, undefined);
  assert.throws(() => importReviewPackage(getStorage, JSON.stringify({ ...partial, note: { text: 'invalid' } })), /note/);
  assert.equal(restoreReviews(getStorage).items.length, 1);
});

test('corrected export and restored grant resolve only after review of a passing follow-up', async () => {
  const corrected = structuredClone(overreach);
  corrected.events[2].actor = valid.events[2].actor;
  corrected.events[2].action.action = valid.events[2].action.action;
  corrected.grants[2].subject = valid.grants[2].subject;
  corrected.grants[2].capabilities = valid.grants[2].capabilities;
  const restored = structuredClone(missing);
  restored.grants.splice(1, 0, { ...valid.grants[1], id: 'CH-003-g2', parentGrantId: 'CH-003-g1' });
  for (const [original, fixed, status, decision] of [[overreach, corrected, 'regression', 'fix-required'],
    [missing, restored, 'review', 'evidence-needed']]) {
    const storage = memory();
    const getStorage = () => storage;
    const candidate = normalize(original);
    const followCandidate = normalize(fixed, `offline-${original.id}-follow-up`);
    const { items: [item] } = await importReview(getStorage, await reportFor(candidate, status), { baseline, candidate });
    const [decided] = saveReviewDecision(getStorage, item, decision, 'Inspect the corrected evidence.');
    await assert.rejects(resolveReviewCase(getStorage, decided), /passing follow-up/);
    const bundle = await createReviewPackage(JSON.parse(await reportFor(followCandidate, 'pass')), { baseline, candidate: followCandidate });
    const [attached] = await attachReviewFollowUp(getStorage, decided, bundle);
    const assessment = await assessFollowUp(attached, await assessReview(attached));
    assert.equal(assessment.assessment.verdict.status, 'pass');
    assert.equal(assessment.resolved, false);
    await resolveReviewCase(getStorage, attached);
    const [saved] = restoreReviews(getStorage).items;
    assert.equal(saved.decision.kind, decision);
    assert.equal((await assessReview(saved)).verdict.status, status);
    assert.equal((await assessFollowUp(saved, await assessReview(saved))).resolved, true);
    const persisted = JSON.parse(storage.getItem(REVIEW_STORAGE_KEY));
    persisted.items[0].followUp.candidate.summary = 'Evidence changed after resolution.';
    storage.setItem(REVIEW_STORAGE_KEY, JSON.stringify(persisted));
    const [changed] = restoreReviews(getStorage).items;
    const rechecked = await assessFollowUp(changed, await assessReview(changed));
    assert.equal(rechecked.resolved, false);
    assert.equal(rechecked.canResolve, false);
  }
});

test('different pins, altered exports and a claimed pass cannot resolve a case', async () => {
  const storage = memory();
  const getStorage = () => storage;
  const candidate = normalize(overreach);
  const { items: [item] } = await importReview(getStorage, await reportFor(candidate, 'regression'), { baseline, candidate });
  const [decided] = saveReviewDecision(getStorage, item, 'expected-change', 'Record the intended difference.');
  const clean = normalize(valid, 'offline-clean-follow-up');
  const changedPin = { ...baseline, summary: 'A different snapshot with the original ID.' };
  const otherBaseline = await createReviewPackage(JSON.parse(await reportFor(clean, 'pass', changedPin)), { baseline: changedPin, candidate: clean });
  await assert.rejects(attachReviewFollowUp(getStorage, decided, otherBaseline), /different baseline/);
  const bundle = JSON.parse(await createReviewPackage(JSON.parse(await reportFor(clean, 'pass')), { baseline, candidate: clean }));
  bundle.candidate.chain.summary = 'Altered after the check.';
  await assert.rejects(attachReviewFollowUp(getStorage, decided, JSON.stringify(bundle)), /missing or altered/);
  assert.equal(restoreReviews(getStorage).items[0].followUp, undefined);
  await assert.rejects(resolveReviewCase(getStorage, decided), /passing follow-up/);

  const overreachAgain = normalize(overreach, 'offline-overreach-follow-up');
  const claimedPass = await createReviewPackage(JSON.parse(await reportFor(overreachAgain, 'pass')), { baseline, candidate: overreachAgain });
  const [attached] = await attachReviewFollowUp(getStorage, decided, claimedPass);
  assert.equal((await assessFollowUp(attached, await assessReview(attached))).assessment.verdict.status, 'regression');
  await assert.rejects(resolveReviewCase(getStorage, attached), /passing follow-up/);
  assert.equal(restoreReviews(getStorage).items[0].resolution, undefined);
});

async function resolvedCase() {
  const candidate = normalize(overreach);
  const corrected = { ...baseline, id: 'offline-corrected' };
  const storage = memory();
  const getStorage = () => storage;
  const { items: [item] } = await importReview(getStorage, await reportFor(candidate, 'regression'), { baseline, candidate });
  const [decided] = saveReviewDecision(getStorage, item, 'fix-required', 'Export exceeds the read-only grant.');
  const packageText = await createReviewPackage(JSON.parse(await reportFor(corrected, 'pass')), { baseline, candidate: corrected });
  const [attached] = await attachReviewFollowUp(getStorage, decided, packageText);
  const [resolved] = await resolveReviewCase(getStorage, attached);
  return resolved;
}

test('a complete case restores the decision and independently verified closure without the optional note', async () => {
  const resolved = await resolvedCase();
  const raw = await createReviewCase({ ...resolved, note: 'Opt in to share this note.', reviewed: true });
  const bundle = JSON.parse(raw);
  assert.equal(bundle.note, undefined);
  assert.equal(bundle.resolution, await runFingerprint({
    original: resolved.id, decision: resolved.decision, followUp: resolved.followUp.id,
  }));
  assert.equal(JSON.parse(await createReviewCase(resolved, 'Share this note.')).note, 'Share this note.');
  const storage = memory();
  const getStorage = () => storage;
  const { caseWarnings } = await importReviewPackage(getStorage, raw);
  assert.deepEqual(caseWarnings, []);
  const [saved] = restoreReviews(getStorage).items;
  assert.deepEqual(saved.decision, resolved.decision);
  assert.equal(saved.reviewed, false);
  assert.deepEqual(saved.followUp, resolved.followUp);
  assert.equal((await assessFollowUp(saved, await assessReview(saved))).resolved, true);

  saveReviewDecision(getStorage, saved, 'evidence-needed', 'My local decision.');
  const [edited] = restoreReviews(getStorage).items;
  await importReviewPackage(getStorage, raw);
  assert.deepEqual(restoreReviews(getStorage).items[0], edited);
});

test('altered evidence and a different pin cannot restore closure from a complete case', async () => {
  const raw = await createReviewCase(await resolvedCase());
  const edits = [
    bundle => { bundle.candidate.chain.summary = 'Changed original evidence'; },
    bundle => { bundle.followUp.candidate.chain.summary = 'Changed follow-up evidence'; },
    bundle => { bundle.followUp.report.baselineFingerprint = '0'.repeat(64); },
  ];
  for (const edit of edits) {
    const bundle = JSON.parse(raw);
    edit(bundle);
    const storage = memory();
    const getStorage = () => storage;
    const { caseWarnings } = await importReviewPackage(getStorage, JSON.stringify(bundle));
    assert.ok(caseWarnings.includes('Closure could not be verified.'));
    const [saved] = restoreReviews(getStorage).items;
    assert.equal(saved.decision.kind, 'fix-required');
    assert.equal(saved.resolution, undefined);
    const { resolved, canResolve } = await assessFollowUp(saved, await assessReview(saved));
    assert.equal(resolved, false);
    assert.equal(canResolve, false);
  }
});

test('a different passing follow-up does not inherit the exported resolution', async () => {
  const bundle = JSON.parse(await createReviewCase(await resolvedCase()));
  const differentCandidate = { ...baseline, id: 'offline-another-correction' };
  bundle.followUp.candidate.chain = differentCandidate;
  bundle.followUp.report = JSON.parse(await reportFor(differentCandidate, 'pass'));
  const storage = memory();
  const getStorage = () => storage;
  const { caseWarnings } = await importReviewPackage(getStorage, JSON.stringify(bundle));
  assert.deepEqual(caseWarnings, ['Closure could not be verified.']);
  const [saved] = restoreReviews(getStorage).items;
  assert.equal(saved.resolution, undefined);
  const assessment = await assessFollowUp(saved, await assessReview(saved));
  assert.equal(assessment.canResolve, true);
  assert.equal(assessment.resolved, false);
});
