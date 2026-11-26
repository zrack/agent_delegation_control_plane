import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importNewCodexCase, inspectCodexCaseImport, importReview, MAX_REVIEW_PACKAGE_BYTES,
  REVIEW_STORAGE_KEY, saveReview } from '../../src/review.mjs';
import { WORKFLOW_BASELINE_KEY } from '../../src/storage.mjs';

const raw = readFileSync(new URL('../../docs/codex-handoff/fixtures/alpha15-case.json', import.meta.url), 'utf8');

function local() {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  return { get: () => storage, values };
}

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
