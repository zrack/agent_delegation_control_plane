import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { REVIEW_STORAGE_KEY } from '../../src/review.mjs';
import { browserSession, disposition, kit, profile, savedPin, savePin } from './dashboard.mjs';

const inbox = page => page.evaluate(key => localStorage.getItem(key), REVIEW_STORAGE_KEY);

test('preview, cancel and inspect duplicate or invalid transfers without overwriting a saved case', async t => {
  const browser = await browserSession(t);
  const page = await profile(browser, t);
  await savePin(page, join(kit, 'pins/matching'));
  const pin = await savedPin(page);
  await page.locator('#review-link').click();
  const panel = page.locator('#codex-import-inspector');
  const picker = panel.locator('#codex-inspect-file');
  const result = panel.locator('#codex-inspect-result');
  const save = panel.locator('#codex-inspect-save');
  const cancel = panel.locator('#codex-inspect-cancel');
  const filename = join(kit, 'cases/history-on.json');
  const packet = JSON.parse(await readFile(filename, 'utf8'));
  const field = label => result.getByText(label, { exact: true }).locator('xpath=following-sibling::dd[1]');

  async function openInspector() {
    if (!(await panel.evaluate(el => el.open))) await panel.locator(':scope > summary').click();
  }
  await openInspector();
  const before = await inbox(page);
  await picker.setInputFiles(filename);
  await result.getByText('after.md', { exact: false }).first().waitFor();
  assert.equal(await field('Workflow').innerText(), 'Follow-up review');
  const baseline = await field('Required receiver baseline').innerText();
  assert.ok(baseline.includes(packet.report.baselineId));
  assert.ok(baseline.includes(packet.report.baselineFingerprint));
  assert.equal(await field('Receiver pin').innerText(), 'matched');
  assert.equal(await field('Sender history entries').innerText(), '2');
  assert.equal(await field('Case after import').innerText(), 'Resolved');
  assert.ok((await field('Follow-up receipts').innerText()).includes('after.md'));
  assert.equal(await save.isEnabled(), true);
  assert.equal(await savedPin(page), pin);
  assert.equal(await inbox(page), before, 'Inspection must leave existing storage untouched');
  await cancel.click();
  assert.equal(await inbox(page), before);
  assert.equal(await savedPin(page), pin);

  await openInspector();
  await picker.setInputFiles(filename);
  await save.click();
  await page.waitForURL(url => url.hash.startsWith('#review?item='));
  assert.deepEqual(await disposition(page), { state: 'Resolved', ready: false });
  const note = 'Second reviewer verified the fictional handoff.';
  await page.locator('#review-note').fill(note);
  await page.getByRole('button', { name: 'Save review', exact: true }).click();
  await page.waitForFunction(({ key, value }) => localStorage.getItem(key)?.includes(value), { key: REVIEW_STORAGE_KEY, value: note });
  await page.reload();
  assert.deepEqual(await disposition(page), { state: 'Resolved', ready: false });
  const saved = await inbox(page);
  assert.equal(JSON.parse(saved).items.length, 1);
  assert.equal(JSON.parse(saved).items[0].note, note);
  assert.deepEqual(JSON.parse(saved).items[0].decision, packet.decision);

  await openInspector();
  await picker.setInputFiles(filename);
  await panel.getByText(/already.*inbox|already.*saved|already.*exists|duplicate/i).first().waitFor();
  assert.equal(await save.isVisible(), false);
  assert.equal(await inbox(page), saved);
  await picker.setInputFiles({ name: 'malformed-fictional-case.json', mimeType: 'application/json', buffer: Buffer.from('{') });
  await panel.locator('#codex-inspect-status').filter({ hasText: /invalid|malformed|choose|could not|cannot|json/i }).waitFor();
  assert.equal(await save.isVisible(), false);
  assert.equal(await inbox(page), saved);
  await picker.setInputFiles({
    name: 'oversize-fictional-case.json', mimeType: 'application/json', buffer: Buffer.alloc(2 * 1024 * 1024 + 1, ' '),
  });
  await panel.locator('#codex-inspect-status').filter({ hasText: 'no larger than 2 MiB' }).waitFor();
  assert.equal(await save.isVisible(), false);
  assert.equal(await inbox(page), saved);
  assert.equal(await savedPin(page), pin);
  await page.reload();
  assert.deepEqual(await disposition(page), { state: 'Resolved', ready: false });
  assert.equal(await page.locator('#review-note').inputValue(), note);
});
