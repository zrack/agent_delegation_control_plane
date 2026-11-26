import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseInvestigation } from '../../src/import.mjs';
import { assessFollowUp, assessReview, importNewCodexCase, inspectCodexCaseImport, inspectCodexRunEvidence,
  importReview, MAX_REVIEW_PACKAGE_BYTES, resolveReviewCase, restoreReviews, reviewClosureState, REVIEW_STORAGE_KEY, saveReview } from '../../src/review.mjs';
import { runFingerprint, WORKFLOW_BASELINE_KEY } from '../../src/storage.mjs';
import { groupGrantFindings } from '../../src/review-view.mjs';

const raw = readFileSync(new URL('../../docs/codex-handoff/fixtures/alpha15-case.json', import.meta.url), 'utf8');

function local() {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  return { get: () => storage, values };
}

test('the checked grant finding retains both actions and keeps other grants, actors and resources distinct', async () => {
  const { get } = local();
  const { items: [item] } = await importNewCodexCase(get, raw);
  const { verdict } = await assessReview(item);
  const [read, write] = verdict.reasons.filter(reason => reason.message === 'Referenced grant supplied');
  const display = groupGrantFindings(verdict.reasons);
  const [missing] = display.filter(finding => finding.rows);
  assert.equal(missing.grantId, 'CODING-FICTIONAL-PREVIEW-01-edit');
  assert.deepEqual(missing.rows, [read.row, write.row]);
  assert.deepEqual(missing.rows.map(row => row.after.event.action.action), ['file:read', 'file:write']);
  assert.deepEqual(display.filter(finding => !finding.rows), verdict.reasons.filter(reason => reason !== read && reason !== write));

  // Each pair still has the same report wording after these changes.
  for (const field of ['authorityId', 'actor', 'resource']) {
    const other = structuredClone(write);
    for (const { event } of [other.row.before, other.row.after]) {
      if (field === 'resource') event.action.resource = 'repo://fictional-preview/other.md';
      else event[field] = 'another-' + field;
    }
    if (field === 'authorityId') other.row.after.findings.forEach(f => { f.grantId = other.row.after.event.authorityId; });
    assert.deepEqual(groupGrantFindings([read, other]).map(finding => finding.rows), [[read.row], [other.row]]);
  }

  for (const change of [
    reason => { reason.row.before.event.authorityId = 'different-baseline-grant'; },
    reason => { reason.row.eventLinks[1] = 'different-action'; },
    reason => { reason.row.after.findings = []; },
    reason => { reason.message += ' · Tool'; },
    reason => { Object.assign(reason.row.changes.find(field => field.label === reason.message), { before: false, after: true }); },
  ]) {
    const other = structuredClone(write);
    change(other);
    assert.deepEqual(groupGrantFindings([read, other]), [groupGrantFindings([read])[0], other]);
  }
});

test('inspection preserves receiver records and catches a duplicate or changed pin at confirmation', async () => {
  const { get, values } = local();
  const p = await inspectCodexCaseImport(get, raw);
  assert.equal(p.pinState.status, 'missing');
  assert.equal(p.originalReceipts.length, 5);
  assert.equal(p.followUpReceipts.length, 5);
  assert.equal(p.disposition, 'Open');
  assert.equal(values.size, 0);
  const pin = JSON.stringify({ schemaVersion: 1, baselines: [{ name: p.workflow, runId: p.baselineId, fingerprint: p.fingerprint }] });
  values.set(WORKFLOW_BASELINE_KEY, pin);
  await assert.rejects(importNewCodexCase(get, raw, p.pinState), /pin changed/);
  assert.equal(values.has(REVIEW_STORAGE_KEY), false);
  const matched = await inspectCodexCaseImport(get, raw);
  assert.equal(matched.disposition, 'Resolved');
  const { items } = await importNewCodexCase(get, raw, matched.pinState);
  saveReview(get, items[0], 'Fictional receiver note', true);
  const original = new Map(values);
  await assert.rejects(importNewCodexCase(get, raw, matched.pinState), /already in the inbox/);
  await assert.rejects(inspectCodexCaseImport(get, raw), /already in the inbox/);
  await assert.rejects(inspectCodexCaseImport(get, '{'), /JSON/);
  await assert.rejects(inspectCodexCaseImport(get, ' '.repeat(MAX_REVIEW_PACKAGE_BYTES + 1)), /2 MiB/);
  assert.deepEqual(values, original);
});

test('a full inbox refuses a new case on preview and on confirmation after a racing import', async () => {
  const { get, values } = local();
  const makeReport = i => JSON.stringify({ schemaVersion: 1, status: 'review', reasons: [{ impact: 'review', message: 'Fictional report ' + i }] });
  for (let i = 0; i < 19; i++) await importReview(get, makeReport(i), {});
  const preview = await inspectCodexCaseImport(get, raw);
  await importReview(get, makeReport(19), {});
  const full = new Map(values);
  await assert.rejects(inspectCodexCaseImport(get, raw), /20 reports or 2 MiB/);
  await assert.rejects(importNewCodexCase(get, raw, preview.pinState), /20 reports or 2 MiB/);
  assert.deepEqual(values, full);
});

test('damaged Codex handoffs keep the original and follow-up claims and receiver digest checks separate after reload', async () => {
  const changed = 'Different fictional output.\r\n';
  for (const damaged of ['original', 'follow-up']) {
    const { get, values } = local();
    const bundle = JSON.parse(raw);
    const altered = damaged === 'original' ? bundle : bundle.followUp;
    altered.codex.evidence.files['after.md'] = Buffer.from(changed).toString('base64');
    values.set(WORKFLOW_BASELINE_KEY, JSON.stringify({ schemaVersion: 1, baselines: [{
      name: bundle.codex.workflow, runId: bundle.report.baselineId, fingerprint: bundle.report.baselineFingerprint,
    }] }));
    await importNewCodexCase(get, JSON.stringify(bundle));
    const saved = new Map(values);
    const [item] = restoreReviews(get).items;
    for (const stage of ['original', 'follow-up']) {
      const inspection = await inspectCodexRunEvidence(item, stage);
      const record = stage === 'original' ? bundle : bundle.followUp;
      assert.equal(inspection.stage, stage);
      assert.equal(inspection.runId, record.report.candidateId);
      const outputs = inspection.claims.filter(claim => claim.receipt === 'after.md');
      assert.deepEqual(outputs, [{
        eventId: 'CODING-FICTIONAL-PREVIEW-01-write', actor: 'fictional-codex-editor', action: 'file:write',
        target: 'repo://fictional-preview/docs/quickstart.md', grantId: 'CODING-FICTIONAL-PREVIEW-01-edit',
        grant: stage === 'original' ? undefined : { issuer: 'fictional-coordinator', subject: 'fictional-codex-editor' },
        receipt: 'after.md',
      }]);
      assert.deepEqual(inspection.checks.map(check => check.name), ['actions.jsonl', 'grants.jsonl', 'attempts.jsonl', 'before.md', 'after.md']);
      assert(inspection.checks.slice(0, -1).every(check => check.status === 'matched' && check.actual === check.expected));
      const expected = record.codex.evidence.hashes['after.md'];
      const actual = stage === damaged ? createHash('sha256').update(changed).digest('hex') : expected;
      assert.deepEqual(inspection.checks.at(-1), { name: 'after.md', status: stage === damaged ? 'mismatch' : 'matched', expected, actual });
      assert(!JSON.stringify(inspection).includes(changed.trim()));
    }
    const original = await assessReview(item).catch(error => ({ error: error.message }));
    const followUp = await assessFollowUp(item, original, get);
    assert.match((damaged === 'original' ? original : followUp).error, /after\.md hash mismatch/);
    assert.equal(reviewClosureState(item, original, followUp), 'blocked');
    await assert.rejects(resolveReviewCase(get, item));
    assert.deepEqual(values, saved);
  }
});

test('inspection keeps unavailable candidate claims and damaged saved files explicit', async () => {
  const { get } = local();
  const bundle = JSON.parse(raw);
  delete bundle.candidate;
  bundle.codex.evidence.files['after.md'] = 'invalid base64';
  await importNewCodexCase(get, JSON.stringify(bundle));
  const [item] = restoreReviews(get).items;
  const evidence = item.codex.evidence;
  delete evidence.files['before.md'];
  delete evidence.hashes['actions.jsonl'];
  evidence.hashes['grants.jsonl'] = 'invalid digest';
  evidence.files['attempts.jsonl'] = 'A'.repeat(180000);
  evidence.files['unrelated.log'] = 'excluded';
  const inspected = await inspectCodexRunEvidence(item, 'original');
  assert.equal(inspected.claims, undefined);
  assert.equal(inspected.runId, bundle.report.candidateId);
  assert.deepEqual(inspected.checks.map(check => check.status), ['unlisted', 'invalid', 'invalid', 'missing', 'invalid']);
  assert(inspected.checks.slice(2).every(check => check.actual === undefined));
  assert(inspected.checks.slice(0, 2).every(check => check.expected === undefined));
  item.candidate = item.followUp.candidate;
  assert.equal((await inspectCodexRunEvidence(item, 'original')).claims, undefined);
  assert.equal(await inspectCodexRunEvidence(item, 'baseline'), undefined);
  item.followUp.id = item.id;
  assert.equal(await inspectCodexRunEvidence(item, 'follow-up'), undefined);
  delete item.followUp;
  assert.equal(await inspectCodexRunEvidence(item, 'follow-up'), undefined);
  item.id = '0'.repeat(64);
  assert.equal(await inspectCodexRunEvidence(item, 'original'), undefined);
});

test('each recognized output action is attributed to its own sender record, irrespective of order or label', async () => {
  const { get } = local();
  const bundle = JSON.parse(raw);
  const write = bundle.candidate.chain.events.at(-1);
  const second = structuredClone(write);
  second.id = 'opaque-event-2';
  second.label = 'Unrelated label';
  second.action.resource = 'repo://fictional-preview/docs/second.md';
  second.authorityId = bundle.candidate.chain.rootGrantId;
  const unmapped = { ...second, id: 'misleading-write', label: 'Output', evidence: { tool: 'unrecognized' } };
  bundle.candidate.chain.events.unshift(second, unmapped);
  bundle.report.candidateFingerprint = await runFingerprint(parseInvestigation(JSON.stringify(bundle.candidate)));
  bundle.codex.evidence.files['after.md'] = '';
  await importNewCodexCase(get, JSON.stringify(bundle));
  const [item] = restoreReviews(get).items;
  const { claims } = await inspectCodexRunEvidence(item, 'original');
  assert.deepEqual(claims.filter(c => c.receipt === 'after.md').map(c => [c.eventId, c.target, c.grantId]),
    [[second.id, second.action.resource, second.authorityId], [write.id, write.action.resource, write.authorityId]]);
  assert.equal(claims.find(c => c.eventId === unmapped.id).receipt, undefined);
});
