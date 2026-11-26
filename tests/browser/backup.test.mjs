import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { browserSession, disposition, expand, importCase, kit, profile, savedPin, savePin, work } from './dashboard.mjs';

test('selectively back up and restore a case, accept the pin separately and preserve duplicate reviews', async t => {
  const browser = await browserSession(t);
  const sender = await profile(browser, t);
  await savePin(sender, join(kit, 'pins/matching'));
  await importCase(sender, join(kit, 'cases/history-on.json'));
  await expand(sender, 'Back up or restore selected cases');
  await sender.locator('#backup-source input[data-kind=case]').check();
  await sender.locator('#backup-source input[data-kind=pin]').check();
  await sender.locator('#backup-receipts').check();
  const pending = sender.waitForEvent('download');
  await sender.locator('#backup-export').click();
  const backup = join(work, 'selected-review-backup.json');
  await (await pending).saveAs(backup);
  for (const option of ['receipts', 'notes', 'history']) assert.equal(await sender.locator('#backup-' + option).isChecked(), false);
  const receiver = await profile(browser, t);
  await receiver.goto(new URL('/#review?', receiver.url()).href);
  await expand(receiver, 'Back up or restore selected cases');
  await receiver.locator('#backup-file').setInputFiles(backup);
  const dest = receiver.locator('#backup-destination');
  await dest.locator('input[data-kind=case]').waitFor();
  assert.equal(await dest.locator('input[data-kind=pin]').isChecked(), false);
  const other = await receiver.context().newPage();
  await other.goto(receiver.url());
  await receiver.locator('#backup-preview').click();
  await receiver.locator('#backup-result').filter({ hasText: 'Open' }).waitFor();
  assert.equal(await savedPin(receiver), null);
  await dest.locator('input[data-kind=pin]').check();
  assert.equal(await receiver.locator('#backup-apply').isVisible(), false);
  await receiver.locator('#backup-preview').click();
  await receiver.locator('#backup-result').filter({ hasText: 'Resolved' }).waitFor();
  await receiver.locator('#backup-apply').click();
  await receiver.locator('#backup-status').filter({ hasText: 'restored' }).waitFor();
  await receiver.locator('#review-list a').first().waitFor();
  await other.locator('#review-list a').first().waitFor();
  await other.locator('#review-list a').first().click();
  assert.deepEqual(await disposition(other), { state: 'Resolved', ready: false });
  await receiver.reload();
  await receiver.locator('#review-list a').first().click();
  assert.deepEqual(await disposition(receiver), { state: 'Resolved', ready: false });
  assert.equal(await receiver.locator('#codex-local-history .codex-history-entry').count(), 0);
  assert.equal(await receiver.locator('#codex-sender-history .codex-history-entry').count(), 0);
  await expand(receiver, 'Back up or restore selected cases');
  await receiver.locator('#backup-file').setInputFiles(backup);
  await receiver.locator('#backup-destination').filter({ hasText: 'already saved' }).waitFor();
  assert.equal(await dest.locator('input[data-kind=case]').isDisabled(), true);
  assert.equal(await dest.locator('input[data-kind=pin]').isDisabled(), true);
  await other.locator('#compare-link').click();
  await other.getByText('Save or replace a workflow baseline', { exact: true }).click();
  await other.locator('#saved-workflow').selectOption('follow-up review');
  await other.locator('#remove-workflow-baseline').click();
  await receiver.locator('#codex-closure-reasons').filter({ hasText: 'Baseline needed' }).waitFor();
  assert.equal(await savedPin(receiver) === null || JSON.parse(await savedPin(receiver)).baselines.length === 0, true);
  await receiver.reload();
  assert.deepEqual(await disposition(receiver), { state: 'Open', ready: false });
  await receiver.locator('#investigate-link').click();
  await receiver.locator('#codex-folder').setInputFiles(join(kit, 'pins/matching'));
  await receiver.waitForURL(url => url.hash.startsWith('#CODEX-'));
  await receiver.locator('#clear-imports').click();
  await receiver.locator('#import-status').filter({ hasText: 'Imported runs cleared' }).waitFor();
  const separate = { kind: 'adcp-review-case', schemaVersion: 1,
    report: { schemaVersion: 1, status: 'review', reasons: [{ impact: 'review', message: 'Another fictional result.' }] } };
  await importCase(receiver, { name: 'another.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(separate)) });
  await receiver.locator('#review-list a').nth(1).waitFor();
  await receiver.reload();
  await receiver.locator('#review-list a').nth(1).waitFor();
  assert.equal(await receiver.evaluate(() => localStorage.getItem('adcp.investigations.v1')), null);
});

test('restore and an ordinary edit from another tab serialize without dropping either case', async t => {
  const browser = await browserSession(t);
  const page = await profile(browser, t);
  const existing = { kind: 'adcp-review-case', schemaVersion: 1,
    report: { schemaVersion: 1, status: 'review', reasons: [{ impact: 'review', message: 'A separate fictional case.' }] } };
  await importCase(page, { name: 'first.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(existing)) });
  const editor = await page.context().newPage();
  await editor.goto(page.url());
  await editor.locator('#review-note').fill('Fictional concurrent note');
  const incoming = structuredClone(existing);
  incoming.report.reasons[0].message = 'New fictional backup entry.';
  const backup = { kind: 'adcp-inbox-backup', schemaVersion: 1, cases: [incoming], pins: [] };
  await expand(page, 'Back up or restore selected cases');
  await page.locator('#backup-file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await page.locator('#backup-preview').click();
  await page.locator('#backup-apply').waitFor();
  const key = 'adcp.pending-backup-restore.v1';
  await page.evaluate(key => {
    navigator.locks.request(key, () => new Promise(release => { window.releaseTestLock = release; }));
  }, key);
  await page.waitForFunction(() => typeof window.releaseTestLock === 'function');
  await page.locator('#backup-apply').click();
  await page.waitForFunction(async key => (await navigator.locks.query()).pending.filter(p => p.name === key).length === 1, key);
  await editor.locator('#review-note-form button[type=submit]').click();
  await page.waitForFunction(async key => (await navigator.locks.query()).pending.filter(p => p.name === key).length === 2, key);
  await page.evaluate(() => window.releaseTestLock());
  await page.locator('#backup-status').filter({ hasText: 'restored' }).waitFor();
  await editor.locator('#review-status').filter({ hasText: 'Review saved' }).waitFor();
  await editor.reload();
  assert.equal(await editor.locator('#review-note').inputValue(), 'Fictional concurrent note');
  assert.equal(await editor.locator('#review-list a').count(), 2);
});


test('a failed restore keeps the receiver inbox and replaying an interrupted journal rolls back on reload', async t => {
  const browser = await browserSession(t);
  const page = await profile(browser, t);
  const base = { kind: 'adcp-review-case', schemaVersion: 1,
    report: { schemaVersion: 1, status: 'review', reasons: [{ impact: 'review', message: 'Receiver report.' }] } };
  await importCase(page, { name: 'keep.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(base)) });
  const next = structuredClone(base);
  next.report.reasons[0].message = 'Backup entry.';
  const backup = { name: 'append.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    kind: 'adcp-inbox-backup', schemaVersion: 1, cases: [next], pins: [],
  })) };
  await expand(page, 'Back up or restore selected cases');
  async function preview() {
    await page.locator('#backup-file').setInputFiles(backup);
    await page.locator('#backup-preview').click();
    await page.locator('#backup-apply').waitFor();
  }
  await preview();
  await page.locator('#review-note').fill('Receiver note after preview');
  await page.locator('#review-note-form button[type=submit]').click();
  await page.locator('#review-status').filter({ hasText: 'Review saved' }).waitFor();
  await page.locator('#backup-apply').click();
  await page.locator('#backup-status').filter({ hasText: 'changed since preview' }).waitFor();
  await preview();
  await page.evaluate(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'adcp.pending-backup-restore.v1') window.recoveryRecord = value;
      if (key === 'adcp.regression-reviews.v1' && window.rejectNextReviewWrite) {
        window.rejectNextReviewWrite = false;
        throw new DOMException('Storage is full', 'QuotaExceededError');
      }
      write.call(this, key, value);
    };
    window.rejectNextReviewWrite = true;
  });
  await page.locator('#backup-apply').click();
  await page.locator('#backup-status').filter({ hasText: 'previous inbox' }).waitFor();
  assert.equal(await page.locator('#review-list a').count(), 1);
  assert.equal(await page.locator('#review-note').inputValue(), 'Receiver note after preview');
  await preview();
  await page.locator('#backup-apply').click();
  await page.locator('#review-list a').nth(1).waitFor();
  await page.evaluate(() => localStorage.setItem('adcp.pending-backup-restore.v1', window.recoveryRecord));
  await page.reload();
  await page.locator('#review-note-form').waitFor();
  assert.equal(await page.locator('#review-list a').count(), 1);
  assert.equal(await page.locator('#review-note').inputValue(), 'Receiver note after preview');
  assert.equal(await page.evaluate(() => localStorage.getItem('adcp.pending-backup-restore.v1')), null);
});
