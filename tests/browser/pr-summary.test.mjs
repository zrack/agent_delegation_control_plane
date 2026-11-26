import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { browserSession, profile, expand, importCase, kit, savePin } from './dashboard.mjs';
import { WORKFLOW_BASELINE_KEY } from '../../src/storage.mjs';

test('reviewer previews the exact copied case summary, and a changed pin requires a fresh preview', async t => {
  const browser = await browserSession(t);
  const page = await profile(browser, t);
  await savePin(page, join(kit, 'pins/matching'));
  await importCase(page, join(kit, 'cases/history-on.json'));
  const note = '@fictional-team #777 private reviewer note';
  await page.locator('#review-note').fill(note);
  await page.getByRole('button', { name: 'Save review', exact: true }).click();
  await expand(page, 'Preview PR summary');
  const preview = page.locator('#review-summary-text');
  const copy = page.getByRole('button', { name: 'Copy summary' });
  const resolved = await preview.inputValue();
  assert.match(resolved, /Verified resolved/);
  assert.match(resolved, /missing grant `CODING-FICTIONAL-PREVIEW-01-edit`/);
  assert.match(resolved, /Follow-up verified output receipt: after\.md SHA-256 `[0-9a-f]{64}`/);
  assert.ok(!resolved.includes(note));
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
  await copy.click();
  await page.getByText('Summary copied.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), resolved);

  // Simulate local site storage changing before the browser delivers a new render.
  await page.evaluate(key => localStorage.removeItem(key), WORKFLOW_BASELINE_KEY);
  await copy.click();
  await page.getByText('The evidence changed. Review the updated summary before copying.', { exact: true }).waitFor();
  const blocked = await preview.inputValue();
  assert.match(blocked, /Disposition: Open, blocked/);
  assert.match(blocked, /Receiver pin: absent/);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), resolved);
  await copy.click();
  await page.getByText('Summary copied.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), blocked);

  await page.reload();
  await expand(page, 'Preview PR summary');
  assert.equal(await preview.inputValue(), blocked);
});

test('altered original keeps a copyable blocked summary and supports manual selection', async t => {
  const browser = await browserSession(t);
  const page = await profile(browser, t);
  await importCase(page, join(kit, 'cases/altered-original.json'));
  await expand(page, 'Preview PR summary');
  const preview = page.locator('#review-summary-text');
  const value = await preview.inputValue();
  assert.match(value, /Original receipts: after\.md failed verification/);
  assert.doesNotMatch(value, /Original verified output receipt/);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: undefined }));
  await page.getByRole('button', { name: 'Copy summary' }).click();
  await page.getByText('Summary selected. Use your device’s Copy command.', { exact: true }).waitFor();
  assert.deepEqual(await preview.evaluate(el => [el.selectionStart, el.selectionEnd]), [0, value.length]);
});
