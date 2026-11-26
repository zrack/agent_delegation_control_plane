import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { backupChoices, createBackup, inspectBackup, previewRestore, applyRestore } from '../../src/backup.mjs';
import { collectionKeys, commitBackupState, guardedStorage, JOURNAL, readBackupState, recoverBackupRestore } from '../../src/backup-storage.mjs';
import { adoptCodexBaseline, importReviewPackage, restoreReviews, saveReview } from '../../src/review.mjs';
import { chains } from '../../src/fixtures.mjs';
import { parseInvestigation } from '../../src/import.mjs';
import { removeWorkflowBaseline, restoreWorkflowBaselines, runFingerprint } from '../../src/storage.mjs';

const raw = readFileSync(new URL('../../docs/codex-handoff/fixtures/alpha15-case.json', import.meta.url), 'utf8');
const lock = job => job();
function newStorage() {
  const data = new Map();
  return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) };
}
async function source() {
  const s = newStorage(), get = () => guardedStorage(s);
  const { items: [item] } = await importReviewPackage(get, raw);
  await adoptCodexBaseline(get, item);
  saveReview(get, item, 'Fictional private note', true);
  const choice = backupChoices(get);
  const options = { caseIds: [item.id], pinNames: [choice.pins[0].name], receipts: true };
  return { s, get, item, options, data: await createBackup(s, options) };
}

test('selective Codex backup requires receipts and independently accepted pins; duplicates preserve local notes', async () => {
  const { s, options, data } = await source();
  await assert.rejects(createBackup(s, { ...options, receipts: false }), /Include folder receipts/);
  assert.ok(!data.includes('Fictional private note'));
  assert.ok((await createBackup(s, { ...options, notes: true })).includes('Fictional private note'));
  const dest = newStorage(), get = () => guardedStorage(dest);
  const report = await inspectBackup(dest, data);
  const ids = report.rows.map(r => r.id), names = report.pins.map(p => p.name);
  const unpinned = await previewRestore(dest, report, ids);
  assert.equal(unpinned.outcomes[0].disposition, 'Open');
  const pinned = await previewRestore(dest, report, ids, names);
  assert.equal(pinned.outcomes[0].disposition, 'Resolved');
  assert.deepEqual(readBackupState(dest), [null, null, null]);
  await applyRestore(dest, pinned, lock);
  const [item] = restoreReviews(get).items;
  assert.equal(item.localHistory, undefined);
  assert.equal(item.note, '');
  saveReview(get, item, 'Receiver note', true);
  const duplicate = await inspectBackup(dest, data);
  assert.equal(duplicate.rows[0].present, true);
  assert.equal(duplicate.pins[0].state, 'matched');
  await assert.rejects(previewRestore(dest, duplicate, ids), /existing case/);
  assert.equal(restoreReviews(get).items[0].note, 'Receiver note');
  removeWorkflowBaseline(get, restoreWorkflowBaselines(get).baselines[0]);
  const second = await inspectBackup(dest, data);
  const pinOnly = await previewRestore(dest, second, [], names);
  assert.equal(pinOnly.outcomes[0].previously, 'Open');
  assert.equal(pinOnly.outcomes[0].disposition, 'Resolved');
  await assert.rejects(createBackup(dest, { ...options, pinNames: [] }), /saved closure could not be verified/);
  await applyRestore(dest, pinOnly, lock);
  assert.equal(restoreReviews(get).items[0].note, 'Receiver note');
  assert.equal(dest.getItem(JOURNAL), null);
});

test('conflicts, changed evidence, unknown pin references and stale approvals cannot overwrite receiver data', async () => {
  const { data } = await source();
  const dest = newStorage();
  const r = await inspectBackup(dest, data);
  const p = await previewRestore(dest, r, [r.rows[0].id], [r.pins[0].name]);
  const alt = { ...r.pins[0], fingerprint: '0'.repeat(64) };
  dest.setItem(collectionKeys[1], JSON.stringify({ schemaVersion: 1, baselines: [{ name: alt.name, fingerprint: alt.fingerprint, runId: alt.runId }] }));
  const original = readBackupState(dest);
  await assert.rejects(applyRestore(dest, p, lock), /changed/);
  const conflict = await inspectBackup(dest, data);
  assert.equal(conflict.pins[0].state, 'conflict');
  await assert.rejects(previewRestore(dest, conflict, [conflict.rows[0].id], [alt.name]), /available pin/);
  const keep = await previewRestore(dest, conflict, [conflict.rows[0].id]);
  assert.equal(keep.outcomes[0].disposition, 'Open');
  assert.deepEqual(readBackupState(dest), original);
  const altered = JSON.parse(data);
  altered.cases[0].followUp.codex.evidence.files['after.md'] = btoa('Changed receipt');
  const t = await inspectBackup(dest, JSON.stringify(altered));
  assert.equal((await previewRestore(dest, t, [t.rows[0].id])).outcomes[0].disposition, 'Open');
  altered.pins[0].fingerprint = '1'.repeat(64);
  await assert.rejects(inspectBackup(dest, JSON.stringify(altered)), /lacks a matching/);
});

test('failed writes and interruption expose a coherent old state and preserve unrelated storage', async () => {
  const { s, data } = await source();
  const before = readBackupState(s);
  const after = before.map(s => s + ' ');
  s.setItem('unrelated', 'keep');
  const writing = s.setItem;
  for (const key of [JOURNAL, ...collectionKeys]) {
    let once = true;
    s.setItem = (k, v) => {
      if (k === key && once) { once = false; throw new Error('quota'); }
      writing(k, v);
    };
    await assert.rejects(commitBackupState(s, before, after, lock), /restore space|restore could not finish/);
    assert.deepEqual(readBackupState(s), before);
    assert.equal(s.getItem('unrelated'), 'keep');
  }
  s.setItem = writing;
  let journal;
  s.setItem = (k, v) => { if (k === JOURNAL) journal = v; writing(k, v); };
  await commitBackupState(s, before, after, lock);
  // Simulate the persisted state when a page disappears after the second native write.
  writing(JOURNAL, journal);
  writing(collectionKeys[2], before[2]);
  assert.deepEqual(collectionKeys.map(k => guardedStorage(s).getItem(k)), before);
  assert.throws(() => guardedStorage(s).removeItem(collectionKeys[1]), /recovery/i);
  assert.equal(await recoverBackupRestore(s, lock), true);
  assert.deepEqual(readBackupState(s), before);
  writing(JOURNAL, journal);
  writing(collectionKeys[2], 'a newer external edit');
  await assert.rejects(recoverBackupRestore(s, lock), /Another tab changed/);
  assert.equal(s.getItem(collectionKeys[2]), 'a newer external edit');
  await assert.rejects(inspectBackup(s, data), /pending/);
});


test('a verified report-only pass needs no closure in the selected restore', async () => {
  const asRun = id => parseInvestigation(JSON.stringify({ schemaVersion: 1, chain: { ...chains[1], id } }));
  const baseline = asRun('offline-baseline'), candidate = asRun('offline-candidate');
  const report = { schemaVersion: 1, status: 'pass', reasons: [], baselineId: baseline.id, candidateId: candidate.id,
    baselineFingerprint: await runFingerprint(baseline), candidateFingerprint: await runFingerprint(candidate) };
  const record = { kind: 'adcp-review-case', schemaVersion: 1, report,
    baseline: { schemaVersion: 1, chain: baseline }, candidate: { schemaVersion: 1, chain: candidate } };
  const source = newStorage(), target = newStorage();
  const { id } = await importReviewPackage(() => source, JSON.stringify(record));
  const transfer = await createBackup(source, { caseIds: [id] });
  const preview = await previewRestore(target, await inspectBackup(target, transfer), [id]);
  assert.equal(preview.outcomes[0].disposition, 'No closure needed');
  await applyRestore(target, preview, lock);
  assert.equal(restoreReviews(() => target).items[0].reviewed, false);
});
