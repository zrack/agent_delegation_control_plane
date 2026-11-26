import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { browserSession, expand, importCase, profile, work } from './dashboard.mjs';

const directory = join(work, 'grant-rehearsal');
execFileSync(process.execPath, ['scripts/alpha-rehearsal.mjs', '--output', directory]);

async function openAction(page, side, eventId) {
  await expand(page, 'Actions and supporting grants');
  const link = page.locator('#review-action-directory').locator('a').filter({ hasText: new RegExp('^' + side + ' · .* · ' + eventId + '$') });
  await link.focus();
  await link.press('Enter');
  await page.locator('#grant-lookup-title').waitFor();
}
async function goBack(page) {
  await page.getByRole('link', { name: 'Return to this action' }).click();
  const focused = page.locator('#review-action-directory a:focus');
  await focused.waitFor();
  return focused;
}
const field = (page, label) => page.locator('#review-grant-lookup dt').filter({ hasText: new RegExp('^' + label + '$') }).locator('+ dd').innerText();

test('worksheet supports lookup, repaired follow-ups and explicit closure inside the dashboard', async t => {
  const browser = await browserSession(t);
  const source = join(directory, 'reviewer');
  for (const [number, eventId, grantId, parentId] of [
    ['01', 'SANDBOX-0000000000a2-e2', 'SANDBOX-0000000000a2-g2', 'SANDBOX-0000000000a2-g1'],
    ['02', 'CH-002-e3', 'CH-002-g3', 'CH-002-g2'],
    ['03', 'CH-003-e2', 'CH-003-g2', null],
  ]) {
    const page = await profile(browser, t);
    await importCase(page, join(source, 'case-' + number + '.json'));
    if (number === '02') {
      const finding = page.locator('#review-detail details[data-review-evidence]').first();
      await finding.locator('summary').click();
      await finding.getByRole('link', { name: /^Candidate · Export agent/ }).click();
      await page.locator('#grant-lookup-title').waitFor();
    } else await openAction(page, 'Candidate', eventId);
    assert.equal(await field(page, 'Referenced grant'), grantId);
    if (parentId) {
      await page.getByRole('link', { name: 'Parent grant · ' + parentId }).click();
      const parent = page.getByRole('heading', { name: 'Grant ' + parentId, exact: true });
      await parent.waitFor();
      await page.reload();
      await parent.waitFor();
      assert.equal(await field(page, 'Action record'), eventId);
    } else {
      await page.locator('#review-grant-lookup .import-error').filter({ hasText: 'Missing grant ' + grantId }).waitFor();
      await page.reload();
      await page.locator('#review-grant-lookup .import-error').filter({ hasText: 'Missing grant ' + grantId }).waitFor();
    }
    const link = await goBack(page);
    assert.equal(await link.getAttribute('data-grant-event'), eventId);
    if (number === '01') continue;
    await page.locator('#review-decision').selectOption(number === '02' ? 'fix-required' : 'evidence-needed');
    await page.locator('#review-decision-reason').fill('Check the recorded grant for ' + eventId);
    await page.getByRole('button', { name: 'Save decision' }).click();
    await page.locator('#review-follow-up-file:enabled').waitFor();
    if (number === '02') {
      await page.locator('#review-follow-up-file').setInputFiles(join(source, 'follow-up-01.json'));
      await page.locator('#review-status.import-error').waitFor();
      assert.equal(await page.locator('#resolve-review-case').isEnabled(), false);
    }
    await page.locator('#review-follow-up-file').setInputFiles(join(source, 'follow-up-' + number + '.json'));
    await page.locator('#resolve-review-case:enabled').waitFor();
    await openAction(page, 'Follow-up', eventId);
    assert.equal(await field(page, 'Referenced grant'), grantId);
    await page.getByRole('heading', { name: 'Grant ' + grantId, exact: true }).waitFor();
    const currentCaptureUrl = page.url();
    const wrongCapture = new URL(currentCaptureUrl);
    const params = new URLSearchParams(wrongCapture.hash.slice('#review?'.length));
    assert.ok(params.get('capture'), 'A replaceable follow-up needs a snapshot-bound link');
    params.set('capture', 'another-follow-up');
    wrongCapture.hash = 'review?' + params;
    await page.goto(wrongCapture.href);
    await page.getByText('No matching run snapshot is available for this selection.').waitFor();
    await page.goto(currentCaptureUrl);
    await page.getByRole('heading', { name: 'Grant ' + grantId, exact: true }).waitFor();
    await goBack(page);
    await page.locator('#resolve-review-case').click();
    await page.locator('.review-case .badge').filter({ hasText: /^Resolved$/ }).waitFor();
    await page.reload();
    await page.locator('.review-case .badge').filter({ hasText: /^Resolved$/ }).waitFor();
  }
});

test('both blind-study packs bind matching IDs to the selected run including reload and browser back', async t => {
  const browser = await browserSession(t);
  for (const [pack, kinds] of [['A', ['unchanged','missing','export']], ['B', ['export','unchanged','missing']]]) {
    for (const [index, kind] of kinds.entries()) {
      const page = await profile(browser, t);
      await importCase(page, join(directory, 'grant-study', 'pack-' + pack, 'dashboard', 'case-0' + (index + 1) + '.json'));
      const event = kind === 'missing' ? 'e2' : 'e3';
      const expectedGrant = kind === 'missing' ? 'g2' : 'g3';
      await openAction(page, 'Candidate', event);
      assert.equal(await field(page, 'Referenced grant'), expectedGrant);
      if (kind === 'missing') {
        await page.locator('#review-grant-lookup .import-error').filter({ hasText: 'Missing grant g2' }).waitFor();
      } else {
        assert.equal(await field(page, 'Subject'), kind === 'export' ? 'export-agent' : 'summary-agent');
        await page.getByRole('link', { name: 'Parent grant · g2' }).click();
        await page.getByRole('heading', { name: 'Grant g2', exact: true }).waitFor();
        await page.getByRole('link', { name: 'Parent grant · g1' }).click();
        await page.getByRole('heading', { name: 'Grant g1', exact: true }).waitFor();
        await page.goBack();
        await page.getByRole('heading', { name: 'Grant g2', exact: true }).waitFor();
        await page.reload();
        await page.getByRole('heading', { name: 'Grant g2', exact: true }).waitFor();
      }
      await goBack(page);
      await openAction(page, 'Baseline', event);
      assert.equal(await field(page, 'Referenced grant'), expectedGrant);
      assert.equal(await field(page, 'Subject'), kind === 'missing' ? 'research-agent' : 'summary-agent');
      const resource = pack === 'A' ? 'river' : 'cedar';
      assert.equal(await field(page, 'Resource'), 'crm://accounts/' + resource);
    }
  }
});
