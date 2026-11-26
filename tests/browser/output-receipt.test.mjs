import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { browserSession, disposition, importCase, kit, profile, savedPin, savePin } from './dashboard.mjs';

test('keyboard navigation opens after.md for the selected stage and restores that receipt after reload', async t => {
  const browser = await browserSession(t);
  const page = await profile(browser, t);
  await savePin(page, join(kit, 'pins/matching'));
  const pin = await savedPin(page);
  const caseFile = join(kit, 'cases/history-on.json');
  const bundle = JSON.parse(await readFile(caseFile, 'utf8'));
  await importCase(page, caseFile);
  const id = new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('item');
  for (const stage of ['original', 'follow-up']) {
    const label = stage === 'original' ? 'Original' : 'Follow-up';
    const record = stage === 'original' ? bundle : bundle.followUp;
    const expected = Buffer.from(record.codex.evidence.files['after.md'], 'base64');
    const digest = createHash('sha256').update(expected).digest('hex');
    const control = page.getByRole('button', { name: 'Inspect ' + stage + ' output receipt · after.md', exact: true });
    assert.equal(await control.count(), 1);
    await control.focus();
    await page.keyboard.press('Enter');
    const target = page.locator('#codex-' + stage + '-output-receipt');
    const summary = target.locator('summary');
    for (const reload of [false, true]) {
      if (reload) await page.reload();
      await summary.waitFor({ state: 'visible' });
      assert.equal(await summary.innerText(), label + ' output receipt · after.md · Rechecked from saved bytes');
      assert.equal(await target.getAttribute('data-codex-side'), stage);
      assert.equal(await target.locator('.receipt-digest').innerText(), 'SHA-256 ' + digest);
      await target.locator('pre').filter({ hasText: expected.toString('utf8').trim() }).waitFor();
      assert.equal(await summary.evaluate(node => node === document.activeElement), true);
      const params = new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
      assert.equal(params.get('item'), id);
      assert.equal(params.get('receipt'), stage);
      assert.equal(params.has('capture'), stage === 'follow-up');
      assert.equal(await savedPin(page), pin);
      assert.deepEqual(await disposition(page), { state: 'Resolved', ready: false });
    }
  }
  const stale = new URL(page.url());
  const params = new URLSearchParams(stale.hash.split('?')[1]);
  params.set('capture', 'replaced-follow-up');
  stale.hash = 'review?' + params;
  await page.goto(stale.href);
  await page.reload();
  await disposition(page);
  assert.equal(await page.locator('#codex-follow-up-output-receipt').evaluate(node => node.open), false);
  assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).has('receipt'), false);
  const digestOnly = page.locator('.codex-digest-only').filter({ hasText: 'quickstart.diff' }).first();
  assert.match(await digestOnly.textContent(), /Verified at import only/);
  assert.doesNotMatch(await digestOnly.textContent(), /Rechecked from saved bytes/);
});

test('failed receipt stages never offer a checked output', async t => {
  const browser = await browserSession(t);
  for (const scenario of ['altered-original', 'altered-follow-up', 'unreadable-original']) {
    const stage = scenario === 'altered-follow-up' ? 'follow-up' : 'original';
    const page = await profile(browser, t);
    await savePin(page, join(kit, 'pins/matching'));
    if (scenario === 'unreadable-original') {
      const bundle = JSON.parse(await readFile(join(kit, 'cases/history-on.json'), 'utf8'));
      bundle.codex.evidence.files['after.md'] = 'invalid base64!';
      await importCase(page, { name: 'unreadable.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)) });
    } else await importCase(page, join(kit, 'cases/' + scenario + '.json'));
    await page.reload();
    assert.deepEqual(await disposition(page), { state: 'Open', ready: false });
    assert.match(await page.locator('#codex-closure-reasons').innerText(), /after\.md/);
    assert.equal(await page.getByRole('button', { name: 'Inspect ' + stage + ' output receipt · after.md' }).count(), 0);
    assert.equal(await page.locator('#codex-' + stage + '-output-receipt').count(), 0);
    if (stage === 'follow-up') assert.equal(await page.getByRole('button', { name: 'Inspect original output receipt · after.md' }).count(), 1);
  }
});

test('explicit closure refreshes the current case immediately while viewing a receipt', async t => {
  const browser = await browserSession(t);
  const page = await profile(browser, t);
  await savePin(page, join(kit, 'pins/matching'));
  await importCase(page, join(kit, 'cases/open-follow-up.json'));
  assert.deepEqual(await disposition(page), { state: 'Open', ready: true });
  await page.getByRole('button', { name: 'Inspect follow-up output receipt · after.md' }).click();
  await page.getByRole('button', { name: 'Close as resolved' }).click();
  await page.locator('#review-detail .review-case .badge').filter({ hasText: /^Resolved$/ }).waitFor();
  assert.deepEqual(await disposition(page), { state: 'Resolved', ready: false });
  const params = new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
  assert.equal(params.get('receipt'), 'follow-up');
  assert.equal(await page.locator('#codex-follow-up-output-receipt').evaluate(node => node.open), true);
  const oldRoute = page.url();
  await page.locator('#review-follow-up-file').setInputFiles(join(kit, 'pins/conflicting'));
  await page.getByText('Follow-up saved.', { exact: true }).waitFor();
  await page.waitForURL(url => !url.hash.includes('receipt='));
  assert.deepEqual(await disposition(page), { state: 'Open', ready: true });
  assert.equal(await page.locator('#codex-follow-up-output-receipt').evaluate(node => node.open), false);
  await page.goto(oldRoute);
  await page.reload();
  await page.waitForURL(url => !url.hash.includes('receipt='));
  assert.equal(await page.locator('#codex-follow-up-output-receipt').evaluate(node => node.open), false);
});
