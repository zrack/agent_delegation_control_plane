import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { browserSession, kit, pinImportedRun, profile, savedPin } from './dashboard.mjs';

const workflow = 'Follow-up review';
const json = async file => JSON.parse(await readFile(file, 'utf8'));

async function importReceiver(page, pin) {
  const expected = await json(join(kit, 'receiver-baselines', pin, 'pin.json'));
  await page.locator('#codex-folder').setInputFiles(join(kit, 'pins', pin));
  await page.locator('#imported-pin-run').filter({ hasText: expected.runId }).waitFor();
  return { name: workflow, runId: expected.runId, fingerprint: expected.fingerprint };
}

async function saveReceiver(page, pin) {
  const expected = await importReceiver(page, pin);
  await pinImportedRun(page, workflow);
  const status = page.locator('#imported-pin-status');
  await status.filter({ hasText: expected.runId }).filter({ hasText: workflow }).waitFor();
  assert.deepEqual(JSON.parse(await savedPin(page)).baselines, [expected]);
  return expected;
}

test('pinning an eligible imported run persists across reload and preserves an existing identical pin', async t => {
  const page = await profile(await browserSession(t), t);
  assert.equal(await page.locator('#imported-pin-form').isVisible(), false, 'Built-in examples use Compare runs');
  const expected = await saveReceiver(page, 'matching');
  const initial = await savedPin(page);
  await page.reload();
  await page.locator('#imported-pin-run').filter({ hasText: expected.runId }).waitFor();
  await pinImportedRun(page, workflow);
  await page.locator('#imported-pin-status').filter({ hasText: expected.runId }).waitFor();
  assert.equal(await page.locator('#baseline-replacement').isVisible(), false);
  assert.equal(await savedPin(page), initial);

  const missingGrant = new URL('../../docs/producer/examples/missing-grant.json', import.meta.url);
  await page.locator('#investigation-file').setInputFiles({
    name: 'missing-grant.json', mimeType: 'application/json', buffer: await readFile(missingGrant),
  });
  await page.waitForURL(url => url.hash.startsWith('#GUIDE-01'));
  assert.equal(await page.locator('#imported-pin-form').isVisible(), false);
  assert.equal(await savedPin(page), initial);
});

test('a reimport with the same run ID and different evidence requires approval of the new fingerprint', async t => {
  const page = await profile(await browserSession(t), t);
  const original = await saveReceiver(page, 'matching');
  const revised = await json(join(kit, 'receiver-baselines/matching/investigation.json'));
  revised.chain.title = 'Revised fictional investigation';
  const fingerprint = createHash('sha256').update(JSON.stringify(revised.chain)).digest('hex');
  assert.notEqual(fingerprint, original.fingerprint);
  await page.locator('#investigation-file').setInputFiles({
    name: 'revised.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(revised)),
  });
  await page.locator('#investigation').getByText(revised.chain.title, { exact: true }).first().waitFor();
  const dialog = page.locator('#baseline-replacement');
  await pinImportedRun(page, workflow);
  await dialog.waitFor();
  const preview = await dialog.innerText();
  for (const value of [workflow, original.runId, original.fingerprint, fingerprint]) {
    assert.ok(preview.includes(value), 'Replacement should identify ' + value);
  }
  assert.deepEqual(JSON.parse(await savedPin(page)).baselines, [original]);
  await page.locator('#cancel-baseline-replacement').click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(JSON.parse(await savedPin(page)).baselines, [original]);
  await pinImportedRun(page, workflow);
  await page.locator('#confirm-baseline-replacement').click();
  await page.locator('#imported-pin-status').filter({ hasText: original.runId }).waitFor();
  assert.deepEqual(JSON.parse(await savedPin(page)).baselines, [{ ...original, fingerprint }]);
});

test('a replacement preview cannot apply after switching runs or after another tab removes the pin', async t => {
  const page = await profile(await browserSession(t), t);
  const original = await saveReceiver(page, 'matching');
  const replacement = await importReceiver(page, 'conflicting');
  await pinImportedRun(page, workflow);
  const dialog = page.locator('#baseline-replacement');
  await dialog.waitFor();
  const preview = await dialog.innerText();
  for (const value of [workflow, original.runId, replacement.runId]) assert.ok(preview.includes(value));
  await page.goBack();
  await page.locator('#imported-pin-run').filter({ hasText: original.runId }).waitFor();
  assert.equal(await dialog.isVisible(), false);
  assert.deepEqual(JSON.parse(await savedPin(page)).baselines, [original]);

  await page.goForward();
  await page.locator('#imported-pin-run').filter({ hasText: replacement.runId }).waitFor();
  await pinImportedRun(page, workflow);
  await dialog.waitFor();
  const other = await page.context().newPage();
  const comparison = new URL(page.url());
  comparison.hash = 'compare?' + new URLSearchParams({ workflow: workflow.toLowerCase() });
  await other.goto(comparison.href);
  await other.locator('#remove-workflow-baseline').click();
  await other.locator('#workflow-status').filter({ hasText: 'Removed the saved baseline' }).waitFor();
  if (await dialog.isVisible()) await page.locator('#confirm-baseline-replacement').click();
  await page.locator('#imported-pin-status').filter({ hasText: /changed|again|updated/i }).waitFor();
  assert.deepEqual(JSON.parse(await savedPin(page)).baselines, []);
  await other.close();
});
