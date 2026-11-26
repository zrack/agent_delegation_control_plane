import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { MAX_REVIEW_PACKAGE_BYTES, REVIEW_STORAGE_KEY } from '../../src/review.mjs';
import { browserSession, importCase, kit, profile, savePin } from './dashboard.mjs';

test('a full mixed inbox keeps the selected case and filters while closure follows the current pin', async t => {
  const browser = await browserSession(t);
  const page = await profile(browser, t);
  await savePin(page, join(kit, 'pins', 'matching'));
  await importCase(page, join(kit, 'cases', 'history-on.json'));
  const selectedUrl = page.url();
  const cards = page.locator('#review-list .review-card');
  const count = page.locator('#review-filter-count');
  await cards.getByText('Verified resolved', { exact: true }).waitFor();
  const savedDecision = await page.locator('#review-decision').inputValue();
  const reason = await page.locator('#review-decision-reason').inputValue();
  await page.locator('#review-note').fill('Reviewed the fictional quickstart repair.');
  await page.getByRole('button', { name: 'Save review', exact: true }).click();
  await page.locator('#review-status').filter({ hasText: 'Review saved.' }).waitFor();

  // Same allegation and evidence, independent named workflow and no receiver pin.
  const open = JSON.parse(await readFile(join(kit, 'cases', 'open-follow-up.json'), 'utf8'));
  open.codex.workflow = open.followUp.codex.workflow = 'Documentation review';
  delete open.senderHistory;
  const upload = async (bundle, total) => {
    await page.locator('#review-package-file').setInputFiles({
      name: 'fictional-case.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)),
    });
    await count.filter({ hasText: 'Showing ' + total + ' of ' + total + ' saved cases.' }).waitFor();
  };
  await upload(open, 2);
  for (let number = 3; number <= 20; number++) {
    // Cover both storage limits in the same real-browser queue. All payload text is fictional.
    const reasons = Array.from({ length: 185 }, (_, index) => ({ impact: 'review',
      message: `Fictional review ${number} has no evidence for record ${index}.`.padEnd(550, '.') }));
    const report = { schemaVersion: 1, status: 'review', reasons };
    await upload({ schemaVersion: 1, kind: 'adcp-review-package', report }, number);
  }
  assert.equal(await cards.count(), 20);
  const bytes = await page.evaluate(key => new TextEncoder().encode(localStorage.getItem(key)).length, REVIEW_STORAGE_KEY);
  assert.ok(bytes > MAX_REVIEW_PACKAGE_BYTES * 0.90 && bytes <= MAX_REVIEW_PACKAGE_BYTES, 'Fixture must exercise 90–100% of the inbox budget');
  const workflow = page.getByLabel('Workflow', { exact: true });
  const decision = page.getByLabel('Decision', { exact: true }).and(page.locator('#review-decision-filter'));
  const closure = page.getByLabel('Closure', { exact: true });
  await workflow.selectOption({ label: 'No recorded workflow' });
  assert.equal(await cards.count(), 18);
  await workflow.selectOption({ label: 'Documentation review' });
  assert.equal(await cards.count(), 1);
  await cards.getByText(/Baseline needed/).waitFor();
  await workflow.selectOption({ label: 'Follow-up review' });
  await decision.selectOption(savedDecision);
  await closure.selectOption('resolved');
  await cards.getByText('Verified resolved', { exact: true }).click();
  await page.waitForURL(selectedUrl);
  await page.reload();
  await count.filter({ hasText: 'Showing 1 of 20 saved cases.' }).waitFor();
  assert.equal(await decision.inputValue(), savedDecision);
  assert.equal(await closure.inputValue(), 'resolved');
  assert.equal(await workflow.locator('option:checked').innerText(), 'Follow-up review');
  assert.equal(await page.locator('#review-note').inputValue(), 'Reviewed the fictional quickstart repair.');

  const other = await page.context().newPage();
  await other.goto(new URL(selectedUrl).origin);
  await savePin(other, join(kit, 'pins', 'conflicting'), { replace: true });
  await count.filter({ hasText: 'Showing 0 of 20 saved cases. The selected case is outside these filters.' }).waitFor();
  await page.locator('.review-case .badge').filter({ hasText: /^Open$/ }).waitFor();
  assert.equal(await cards.count(), 0);
  await page.reload();
  await count.filter({ hasText: 'Showing 0 of 20 saved cases.' }).waitFor();
  assert.equal(page.url(), selectedUrl);
  assert.equal(await page.locator('#review-decision-reason').inputValue(), reason);
  assert.equal(await page.locator('#review-decision').inputValue(), savedDecision);
  assert.equal(await page.locator('#review-note').inputValue(), 'Reviewed the fictional quickstart repair.');
  await closure.selectOption('blocked');
  assert.equal(await cards.count(), 1);
  await cards.getByText(/Conflicting baseline/).waitFor();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  assert.equal(await cards.count(), 20);
  await other.close();
});
