import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parseInvestigation } from '../../src/import.mjs';
import { runFingerprint } from '../../src/storage.mjs';
import { browserSession, disposition, expand, importCase, kit, profile, savedPin, savePin, work } from './dashboard.mjs';

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
  await page.getByRole('link', { name: 'Return to this action', exact: true }).click();
  const focused = page.locator('#review-action-directory a:focus');
  await focused.waitFor();
  return focused;
}
const field = (page, label) => page.locator('#review-grant-lookup dt').filter({ hasText: new RegExp('^' + label + '$') }).locator('+ dd').innerText();
const recordLink = (group, side, id) => group.locator('a[data-grant-side="' + side + '"][data-grant-event="' + id + '"]');

async function checkFindingFocus(page, finding, side, id) {
  const link = recordLink(finding, side, id);
  await link.waitFor();
  assert.equal(await link.evaluate(node => node === document.activeElement), true, side + ' ' + id + ' should have keyboard focus');
  assert.equal(await finding.evaluate(node => node.open), true);
  assert.equal(await page.locator('#review-action-directory').evaluate(node => node.open), false);
}

test('keyboard review returns to the exact missing-grant link for each baseline and candidate action', async t => {
  const browser = await browserSession(t);
  const page = await profile(browser, t);
  await savePin(page, join(kit, 'pins/matching'));
  const pin = await savedPin(page);
  const caseFile = join(kit, 'cases/altered-follow-up.json');
  const bundle = JSON.parse(await readFile(caseFile, 'utf8'));
  await importCase(page, caseFile);
  await page.reload();
  assert.deepEqual(await disposition(page), { state: 'Open', ready: false });
  const grantId = 'CODING-FICTIONAL-PREVIEW-01-edit';
  const events = bundle.candidate.chain.events.filter(event => event.authorityId === grantId);
  assert.deepEqual(events.map(event => event.action.action), ['file:read', 'file:write']);
  const finding = page.locator('#review-detail details.grant-finding');
  assert.equal(await finding.count(), 1);
  const heading = finding.locator('summary');
  const headline = await heading.innerText();
  for (const text of ['Missing grant ' + grantId, events[0].actor, events[0].action.resource, 'file:read', 'file:write']) {
    assert.ok(headline.includes(text), 'Grouped finding must identify ' + text);
  }
  await heading.press('Enter');
  assert.equal(await finding.getByRole('link').count(), 4);
  for (const event of events) {
    for (const side of ['baseline', 'candidate']) {
      await page.keyboard.press('Tab');
      await checkFindingFocus(page, finding, side, event.id);
      await page.keyboard.press('Enter');
      await page.locator('#grant-lookup-title:focus').waitFor();
      await page.locator('#review-grant-lookup').getByText(bundle[side].chain.id, { exact: true }).waitFor();
      assert.equal(await field(page, 'Action record'), event.id);
      assert.equal(await field(page, 'Recorded action'), event.action.action);
      assert.equal(await field(page, 'Resource'), event.action.resource);
      assert.equal(await field(page, 'Referenced grant'), grantId);
      if (side === 'candidate') {
        assert.equal(await page.locator('#review-grant-lookup .import-error').innerText(), 'Missing grant ' + grantId);
      } else {
        await page.getByRole('heading', { name: 'Grant ' + grantId, exact: true }).waitFor();
        assert.equal(await field(page, 'Subject'), event.actor);
      }
      await page.goBack();
      await checkFindingFocus(page, finding, side, event.id);
      await page.goForward();
      await page.locator('#grant-lookup-title:focus').waitFor();
      assert.equal(await field(page, 'Action record'), event.id);
      await page.getByRole('link', { name: 'Back to grant finding', exact: true }).press('Enter');
      await checkFindingFocus(page, finding, side, event.id);
    }
  }
  assert.equal(await savedPin(page), pin);
  assert.deepEqual(await disposition(page), { state: 'Open', ready: false });
  await expand(page, 'Reasons recorded by the offline report');
  const offline = page.locator('details').filter({ has: page.getByText('Reasons recorded by the offline report', { exact: true }) });
  const reasons = offline.getByRole('listitem').filter({ hasText: 'Referenced grant supplied' });
  assert.equal(await reasons.count(), 2);
  for (const event of events) {
    const raw = await reasons.filter({ hasText: event.id }).innerText();
    assert.ok(raw.includes('baseline action ' + event.id));
    assert.ok(raw.includes('candidate action ' + event.id));
  }
});

test('a reopened parent grant returns to its finding and a directory lookup returns to its own link', async t => {
  const page = await profile(await browserSession(t), t);
  await savePin(page, join(kit, 'pins/matching'));
  await importCase(page, join(kit, 'cases/altered-follow-up.json'));
  const caseUrl = page.url();
  const finding = page.locator('details.grant-finding');
  const id = 'CODING-FICTIONAL-PREVIEW-01-write';
  await finding.locator('summary').click();
  await recordLink(finding, 'baseline', id).click();
  const parent = 'CODING-FICTIONAL-PREVIEW-01-root';
  await page.getByRole('link', { name: 'Parent grant · ' + parent }).click();
  const parentHeading = page.getByRole('heading', { name: 'Grant ' + parent, exact: true });
  await parentHeading.waitFor();
  const parentUrl = page.url();
  await page.reload();
  await parentHeading.waitFor();
  const freshTab = await page.context().newPage();
  await freshTab.goto(parentUrl);
  await freshTab.getByRole('link', { name: 'Back to grant finding', exact: true }).click();
  const reopenedFinding = freshTab.locator('details.grant-finding');
  await checkFindingFocus(freshTab, reopenedFinding, 'baseline', id);
  await freshTab.goBack();
  await freshTab.getByRole('heading', { name: 'Grant ' + parent, exact: true }).waitFor();
  await freshTab.goForward();
  await checkFindingFocus(freshTab, reopenedFinding, 'baseline', id);
  await freshTab.close();
  await page.goto(caseUrl);
  await disposition(page);
  assert.equal(await finding.evaluate(node => node.open), false);
  await openAction(page, 'Baseline', id);
  const back = await goBack(page);
  assert.equal(await back.getAttribute('data-grant-side'), 'baseline');
  assert.equal(await back.getAttribute('data-grant-event'), id);
  assert.equal(await finding.evaluate(node => node.open), false);
});

test('a baseline link shared by the original and follow-up findings returns only to the current comparison', async t => {
  const page = await profile(await browserSession(t), t);
  const pack = join(directory, 'grant-study/pack-A/dashboard');
  const bundle = JSON.parse(await readFile(join(pack, 'case-02.json'), 'utf8'));
  // All three captures have the same missing grant and action IDs.
  async function missingCapture(id) {
    const candidate = structuredClone(bundle.candidate);
    candidate.chain.id = id;
    const fingerprint = await runFingerprint(parseInvestigation(JSON.stringify(candidate)));
    return { candidate, report: { ...bundle.report, candidateId: id, candidateFingerprint: fingerprint } };
  }
  const asFile = (name, record) => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(record)) });
  const reviewCase = {
    ...bundle, kind: 'adcp-review-case',
    decision: { kind: 'evidence-needed', reason: 'Restore the missing grant.' },
    followUp: await missingCapture('GRANT-STUDY-A-SECOND-MISSING'),
  };
  await importCase(page, asFile('two-findings.json', reviewCase));
  const original = page.locator('#review-detail > details.grant-finding');
  const evidence = page.getByText('Inspect follow-up evidence', { exact: true }).locator('..');
  const finding = evidence.locator('details.grant-finding');
  const id = 'e2';
  await expand(page, 'Inspect follow-up evidence');
  await finding.locator('summary').click();
  await recordLink(finding, 'baseline', id).click();
  const back = page.getByRole('link', { name: 'Back to grant finding', exact: true });
  const returnUrl = await back.evaluate(node => node.href);
  await back.click();
  await checkFindingFocus(page, finding, 'baseline', id);
  assert.equal(await original.evaluate(node => node.open), false);
  assert.equal(await evidence.evaluate(node => node.open), true);

  const replacement = await missingCapture('GRANT-STUDY-A-THIRD-MISSING');
  await page.locator('#review-follow-up-file').setInputFiles(asFile('replacement.json', { ...bundle, ...replacement }));
  await page.locator('.review-case-verdicts').getByText(replacement.candidate.chain.id, { exact: true }).waitFor();
  await page.goto(returnUrl);
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    assert.deepEqual(await disposition(page), { state: 'Open', ready: false });
    assert.equal(await finding.evaluate(node => node.open), false);
    assert.equal(await original.evaluate(node => node.open), false);
    assert.equal(await page.locator('#review-action-directory').evaluate(node => node.open), false);
    assert.equal(await page.locator('[data-grant-event]:focus').count(), 0);
  }
});

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
