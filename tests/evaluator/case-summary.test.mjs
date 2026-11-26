import assert from 'node:assert/strict';
import test from 'node:test';
import { caseSummary } from '../../src/case-summary.mjs';

const hash = 'a'.repeat(64);
const inputMarker = '@fictional-team #777 https://example.invalid/private <em>private</em>';
const run = { id: 'run-1', events: [{ id: 'e1', authorityId: 'g1' }], grants: [{ id: 'g1' }] };
const report = { status: 'review', baselineId: 'baseline', candidateId: 'candidate', candidateFingerprint: hash, baselineFingerprint: hash,
  reasons: [{ message: inputMarker }] };
const item = { id: hash, report, candidate: run, note: inputMarker, decision: { kind: 'fix-required', reason: inputMarker } };
const original = { states: { baseline: 'matched', candidate: 'matched' },
  verdict: { status: 'review' }, candidateResult: { findings: [] } };

test('unverifiable evidence and missing evidence have distinct summaries without untrusted text', () => {
  const summary = caseSummary(item, { states: { baseline: 'missing', candidate: 'unavailable' } }, {}, 'blocked');
  assert.match(summary, /Original baseline: `baseline`, missing/);
  assert.match(summary, /Original candidate: `candidate`, no recorded fingerprint/);
  assert.match(summary, /Rechecked: unverifiable/);
  assert.doesNotMatch(summary, /fictional-team|example\.invalid|#777|<em>|grant references|SHA-256/);
});

test('only receiver-verified receipt digests are copied, and findings identify a missing grant', () => {
  const invoice = { evidence: { hashes: { 'results.json': hash }, files: { 'validation.json': inputMarker } } };
  const invoiceCase = { ...item, invoice };
  const assessment = { ...original, candidateResult: { findings: [{ eventId: 'e1', grantId: 'g-absent' }] } };
  const receiptStates = Object.fromEntries(['investigation.json', 'expected.json', 'results.json', 'validation.json', 'execution.json', 'attempts.json'].map(n => [n, 'matched']));
  const follow = { originalInvoice: { checked: { receiptStates } }, pinState: { status: 'matched' } };
  assert.match(caseSummary(invoiceCase, assessment, follow, 'blocked'), /verified output receipt: results\.json SHA-256/);
  receiptStates['results.json'] = 'mismatch';
  const summary = caseSummary(invoiceCase, assessment, follow, 'blocked');
  assert.match(summary, /missing grant `g-absent` for action `e1`/);
  assert.match(summary, /results\.json digest mismatch/);
  assert.doesNotMatch(summary, /verified output receipt|fictional-team/);
});

test('a broken Codex receipt names the checked file without echoing errors or unchecked digest values', () => {
  const altered = { ...item, codex: { workflow: inputMarker } };
  const summary = caseSummary(altered, { error: 'after.md hash mismatch ' + inputMarker }, { pinState: { status: 'matched' } }, 'blocked');
  assert.match(summary, /after\.md failed verification/);
  assert.match(summary, /Restore matching original receipts/);
  assert.doesNotMatch(summary, /fictional-team|#777|SHA-256/);
});

test('references are displayed as safe literal tokens and a ready case remains open', () => {
  const changed = { ...item, candidate: { ...run, events: [{ id: 'e', authorityId: 'www.example.invalid' }], grants: [{ id: 'www.example.invalid' }] },
    report: { ...report, candidateId: inputMarker } };
  const summary = caseSummary(changed, original, {}, 'ready');
  assert.match(summary, /Disposition: Open, ready to close/);
  assert.match(summary, /grant `www\.example\.invalid`/);
  assert.match(summary, /Original candidate: unavailable/);
  assert.doesNotMatch(summary, /@|<em>|#777/);
});
