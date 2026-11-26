import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseInvestigation } from '../../src/import.mjs';
import { REVIEW_STORAGE_KEY } from '../../src/review.mjs';
import { runFingerprint } from '../../src/storage.mjs';
import { browserSession, disposition, expand, importCase, kit, profile, savedPin, savePin } from './dashboard.mjs';

const receiptButton = (page, stage) => page.getByRole('button', { name: 'Go to ' + stage + ' receipt for after.md', exact: true });
const reviewParams = url => new URLSearchParams(new URL(url).hash.slice('#review?'.length));

async function savedSelection(page) {
  return page.evaluate(key => {
    const id = new URLSearchParams(location.hash.slice('#review?'.length)).get('item');
    const item = JSON.parse(localStorage.getItem(key)).items.find(record => record.id === id);
    return { item: item.id, capture: item.followUp.id };
  }, REVIEW_STORAGE_KEY);
}

async function inspectVerifiedOutput(page, stage, record, selection) {
  const targetId = 'codex-' + stage + '-output-receipt';
  const control = receiptButton(page, stage);
  assert.equal(await control.count(), 1);
  assert.equal(await control.evaluate(node => node.tagName), 'BUTTON');
  assert.equal(await control.getAttribute('aria-controls'), targetId);
  const description = page.locator('#' + await control.getAttribute('aria-describedby'));
  assert.equal(await description.isVisible(), true);
  assert.equal(await description.innerText(), 'Opens the saved file contents and SHA-256 in this case.');
  await control.focus();
  await page.keyboard.press('Enter');

  const target = page.locator('#' + targetId);
  const summary = target.locator('summary:focus');
  const label = stage === 'original' ? 'Original' : 'Follow-up';
  const expected = Buffer.from(record.codex.evidence.files['after.md'], 'base64');
  const digest = createHash('sha256').update(expected).digest('hex');
  assert.equal(digest, record.codex.evidence.hashes['after.md']);
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await summary.waitFor();
    assert.equal(await summary.innerText(), label + ' output receipt · after.md · Rechecked from saved bytes');
    assert.equal(await target.getAttribute('data-codex-side'), stage);
    assert.equal(await target.locator('.receipt-digest').innerText(), 'SHA-256 ' + digest);
    const content = target.locator('pre').filter({ hasText: expected.toString('utf8').trim() });
    await content.waitFor();
    assert.equal(await content.textContent(), expected.toString('utf8'));
    const params = reviewParams(page.url());
    assert.equal(params.get('item'), selection.item);
    assert.equal(params.get('receipt'), stage);
    assert.equal(params.get('capture'), stage === 'follow-up' ? selection.capture : null);
  }
}

async function rejectedReceiptRoute(page, stage, selection) {
  const url = new URL(page.url());
  const params = new URLSearchParams({ item: selection.item, receipt: stage });
  if (stage === 'follow-up') params.set('capture', selection.capture);
  url.hash = 'review?' + params;
  await page.goto(url.href);
  await page.reload();
  await page.waitForURL(url => !reviewParams(url).has('receipt'));
  assert.equal(reviewParams(page.url()).get('item'), selection.item);
}

test('keyboard navigation opens after.md for the selected stage and restores that receipt after reload', async t => {
  const browser = await browserSession(t);
  const page = await profile(browser, t);
  await savePin(page, join(kit, 'pins/matching'));
  const pin = await savedPin(page);
  const caseFile = join(kit, 'cases/history-on.json');
  const bundle = JSON.parse(await readFile(caseFile, 'utf8'));
  await importCase(page, caseFile);
  const selection = await savedSelection(page);
  for (const stage of ['original', 'follow-up']) {
    const record = stage === 'original' ? bundle : bundle.followUp;
    await inspectVerifiedOutput(page, stage, record, selection);
    assert.equal(await savedPin(page), pin);
    assert.deepEqual(await disposition(page), { state: 'Resolved', ready: false });
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

async function checkStageEvidence(page, label, record, damaged) {
  const section = page.getByRole('region', { name: label + ' run evidence', exact: true });
  await section.getByText(record.report.candidateId, { exact: true }).waitFor();
  const sender = section.getByRole('region', { name: 'Sender-reported action and grant', exact: true });
  const field = name => sender.getByText(name, { exact: true }).locator('+ dd').innerText();
  assert.equal(await field('Action'), 'file:write by fictional-codex-editor');
  assert.equal(await field('Target'), 'repo://fictional-preview/docs/quickstart.md');
  assert.equal(await field('Referenced grant'), 'CODING-FICTIONAL-PREVIEW-01-edit');
  assert.equal(await field('Action record'), 'CODING-FICTIONAL-PREVIEW-01-write');
  assert.equal(await field('Output receipt for this edit'), 'after.md');
  const grantRecord = await field('Grant record');
  if (label === 'Original') assert.match(grantRecord, /missing from the sender.s grant records/i);
  else assert.match(grantRecord, /fictional-coordinator as issuer and fictional-codex-editor as subject/);

  const receiver = section.getByRole('region', { name: 'Receiver checks', exact: true });
  const manifest = record.codex.evidence.hashes['after.md'];
  const bytes = Buffer.from(record.codex.evidence.files['after.md'], 'base64');
  const actual = createHash('sha256').update(bytes).digest('hex');
  const output = receiver.getByRole('listitem').filter({ has: page.getByText('after.md', { exact: true }) });
  if (damaged) {
    assert.notEqual(actual, manifest);
    const explanation = await receiver.innerText();
    assert.ok(explanation.includes(label + ' verification failed.'));
    assert.match(explanation, /after\.md hash mismatch against manifest\.json/);
    assert.match(explanation, label === 'Original' ? /reproduce the original finding/ : /verified passing follow-up/);
    assert.match(await output.innerText(), /after\.md · Hash mismatch/);
  } else {
    assert.equal(actual, manifest);
    assert.ok((await receiver.innerText()).includes(label + ' comparison rechecked'));
    await receiver.getByText(/^Matching receipts/).click();
    assert.match(await output.innerText(), /after\.md · Matches manifest/);
  }
  assert.ok((await output.innerText()).includes('Manifest SHA-256 ' + manifest));
  assert.ok((await output.innerText()).includes('Received bytes SHA-256 ' + actual));
}

test('altered receipts keep the sender’s account inspectable and closure blocked after reload', async t => {
  const browser = await browserSession(t);
  for (const stage of ['original', 'follow-up']) {
    await t.test('altered-' + stage, async child => {
      const page = await profile(browser, child);
      await savePin(page, join(kit, 'pins/matching'));
      const pin = await savedPin(page);
      const caseFile = join(kit, 'cases/altered-' + stage + '.json');
      const bundle = JSON.parse(await readFile(caseFile, 'utf8'));
      await importCase(page, caseFile);
      await page.reload();
      assert.deepEqual(await disposition(page), { state: 'Open', ready: false });
      await checkStageEvidence(page, 'Original', bundle, stage === 'original');
      await checkStageEvidence(page, 'Follow-up', bundle.followUp, stage === 'follow-up');
      const label = stage === 'original' ? 'Original' : 'Follow-up';
      const blocker = page.locator('#codex-closure-reasons li').filter({ hasText: label + ' evidence' });
      assert.match(await blocker.innerText(), /after\.md hash mismatch against manifest\.json/);
      assert.equal(await receiptButton(page, stage).count(), 0);
      assert.equal(await page.locator('#codex-' + stage + '-output-receipt').count(), 0);
      assert.equal(await page.locator('[data-grant-side="' + (stage === 'original' ? 'candidate' : 'follow-up') + '"]').count(), 0);
      if (stage === 'original') {
        assert.equal(await page.locator('#review-detail details.grant-finding').count(), 0);
        const decision = await page.locator('#codex-blocked-decision').innerText();
        assert.match(decision, /Previously saved decision/);
        assert.ok(decision.includes(bundle.decision.reason));
        await expand(page, 'Restore original Codex receipts');
        assert.equal(await page.locator('#codex-restore-file').isEnabled(), true);
      } else {
        const verdict = await page.locator('.review-case-verdicts .compare-run')
          .filter({ has: page.getByRole('heading', { name: 'Follow-up run', exact: true }) }).innerText();
        assert.match(verdict, /Sender-reported[^\n]*No regression found/);
        assert.match(verdict, /Receiver check failed[^\n]*after\.md hash mismatch against manifest\.json/);
        assert.doesNotMatch(verdict, /Evidence check unavailable/);
        assert.equal(await page.locator('#review-follow-up-file').isEnabled(), true);
      }
      const selection = await savedSelection(page);
      const healthy = stage === 'original' ? 'follow-up' : 'original';
      const region = page.getByRole('region', { name: (healthy === 'original' ? 'Original' : 'Follow-up') + ' run evidence' });
      assert.equal(await receiptButton(region.getByRole('region', { name: 'Receiver checks' }), healthy).count(), 1);
      await inspectVerifiedOutput(page, healthy, healthy === 'original' ? bundle : bundle.followUp, selection);
      assert.deepEqual(await disposition(page), { state: 'Open', ready: false });

      // Even a route for the exact saved capture cannot open the damaged file.
      await rejectedReceiptRoute(page, stage, selection);
      assert.equal(await page.locator('#codex-' + stage + '-output-receipt').count(), 0);
      assert.equal(await page.locator('#codex-' + healthy + '-output-receipt').evaluate(node => node.open), false);
      assert.equal(await page.locator('#codex-local-history .codex-history-entry').count(), 0);
      await expand(page, 'Preview PR summary');
      const summary = await page.locator('#review-summary-text').inputValue();
      assert.match(summary, /Disposition: Open, blocked/);
      assert.ok(summary.includes(label + ' receipts: after.md failed verification'));
      assert.ok(!summary.includes(label + ' verified output receipt'));
      assert.equal(await savedPin(page), pin);
      assert.deepEqual(await disposition(page), { state: 'Open', ready: false });
    });
  }
});

test('a verified follow-up cannot open as this case’s output without a matching original task', async t => {
  const browser = await browserSession(t);
  for (const reason of ['missing original investigation', 'different starting document']) {
    await t.test(reason, async child => {
      const page = await profile(browser, child);
      await savePin(page, join(kit, 'pins/matching'));
      const bundle = JSON.parse(await readFile(join(kit, 'cases/altered-original.json'), 'utf8'));
      if (reason === 'missing original investigation') {
        delete bundle.candidate;
      } else {
        const preflight = bundle.candidate.chain.events.find(event => event.evidence.tool === 'preflight_read');
        preflight.evidence.artifactSha256 = createHash('sha256').update('Another fictional starting document').digest('hex');
        bundle.report.candidateFingerprint = await runFingerprint(parseInvestigation(JSON.stringify(bundle.candidate)));
      }
      await importCase(page, { name: 'different-task.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)) });
      await page.reload();
      assert.deepEqual(await disposition(page), { state: 'Open', ready: false });
      await checkStageEvidence(page, 'Follow-up', bundle.followUp, false);
      assert.equal(await receiptButton(page, 'follow-up').count(), 0);
      await rejectedReceiptRoute(page, 'follow-up', await savedSelection(page));
      assert.equal(await page.locator('#codex-follow-up-output-receipt').count(), 0);
      assert.deepEqual(await disposition(page), { state: 'Open', ready: false });
    });
  }
});

test('unreadable original evidence never offers a checked output', async t => {
  const browser = await browserSession(t);
  const page = await profile(browser, t);
  await savePin(page, join(kit, 'pins/matching'));
  const bundle = JSON.parse(await readFile(join(kit, 'cases/history-on.json'), 'utf8'));
  bundle.codex.evidence.files['after.md'] = 'invalid base64!';
  await importCase(page, { name: 'unreadable.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)) });
  await page.reload();
  assert.deepEqual(await disposition(page), { state: 'Open', ready: false });
  assert.match(await page.locator('#codex-closure-reasons').innerText(), /after\.md/);
  assert.equal(await receiptButton(page, 'original').count(), 0);
  assert.equal(await page.locator('#codex-original-output-receipt').count(), 0);
});

test('explicit closure refreshes the current case immediately while viewing a receipt', async t => {
  const browser = await browserSession(t);
  const page = await profile(browser, t);
  await savePin(page, join(kit, 'pins/matching'));
  await importCase(page, join(kit, 'cases/open-follow-up.json'));
  assert.deepEqual(await disposition(page), { state: 'Open', ready: true });
  await receiptButton(page, 'follow-up').click();
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
