import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { browserSession, disposition, expand, importCase, kit, profile, savedPin, savePin } from './dashboard.mjs';

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
      assert.equal(await page.getByRole('button', { name: 'Inspect ' + stage + ' output receipt · after.md' }).count(), 0);
      assert.equal(await page.locator('#codex-' + stage + '-output-receipt').count(), 0);
      assert.equal(await page.locator('[data-grant-side="' + (stage === 'original' ? 'candidate' : 'follow-up') + '"]').count(), 0);
      if (stage === 'original') {
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
        await page.getByRole('button', { name: 'Inspect original output receipt · after.md' }).click();
        assert.match(await page.locator('#codex-original-output-receipt summary').innerText(), /Rechecked from saved bytes/);
        assert.equal(await page.locator('#review-follow-up-file').isEnabled(), true);
      }
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
  assert.equal(await page.getByRole('button', { name: 'Inspect original output receipt · after.md' }).count(), 0);
  assert.equal(await page.locator('#codex-original-output-receipt').count(), 0);
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
