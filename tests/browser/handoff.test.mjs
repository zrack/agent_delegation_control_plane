import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { browserSession, disposition, expand, importCase, kit, pinImportedRun, profile, savedPin, savePin, work } from './dashboard.mjs';

const json = async filename => JSON.parse(await readFile(filename, 'utf8'));
const labels = { repair: 'Original receipts repaired', closure: 'Case explicitly closed' };
const reasons = {
  'missing-pin': /Baseline needed/i,
  'conflicting-pin': /Conflicting baseline/i,
  'original-receipt-mismatch': /Original evidence[\s\S]*after\.md/i,
  'follow-up-receipt-mismatch': /Follow-up evidence[\s\S]*after\.md/i,
  'explicit-closure-needed': /Ready to close/i,
};

async function history(page, side) {
  return page.locator(`#codex-${side}-history .codex-history-entry > strong`).allTextContents();
}

async function verifyOutcome(page, row) {
  const expected = { state: row.disposition === 'resolved' ? 'Resolved' : 'Open', ready: row.disposition === 'open-ready' };
  const observed = await disposition(page);
  assert.deepEqual(observed, expected, `${row.id}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`);
  if (row.reason !== 'verified-closure') {
    assert.ok(reasons[row.reason], `Unrecognized reason: ${row.reason}`);
    assert.match(await page.locator('#codex-closure-reasons').innerText(), reasons[row.reason], row.id);
  }
  await verifySenderPanel(page, Boolean(row.senderHistory.length));
  assert.deepEqual(await history(page, 'sender'), row.senderHistory.map(kind => labels[kind]), row.id + ' sender history');
  assert.deepEqual(await history(page, 'local'), row.localHistory.map(kind => labels[kind]), row.id + ' local history');
}

async function verifySenderPanel(page, hasEvents) {
  const panel = page.getByRole('region', { name: 'Sender-reported history', exact: true });
  assert.equal(await panel.isVisible(), true);
  if (hasEvents) {
    assert.match(await panel.innerText(), /These events and prior receipt digests come from the sender/);
    assert.doesNotMatch(await panel.innerText(), /Whether the sender made a repair is unknown/);
  } else {
    assert.match(await panel.innerText(), /No sender-reported repair or closure events are available/);
    assert.match(await panel.innerText(), /Whether the sender made a repair is unknown/);
  }
}

async function download(page, name, shareHistory) {
  await expand(page, 'Export review package or case');
  const receipts = page.locator('#include-codex-receipts');
  const sender = page.locator('#include-sender-history');
  assert.equal(await receipts.isChecked(), false);
  if (await sender.count()) {
    assert.equal(await sender.isChecked(), false);
    assert.equal(await sender.isDisabled(), true);
  }
  await receipts.check();
  if (shareHistory) await sender.check();
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download review case' }).click(),
  ]);
  const path = join(work, name + '.json');
  await file.saveAs(path);
  return path;
}

test('handoff kit outcomes survive reload with baselines pinned directly from receiver imports', async t => {
  const matrix = await json(join(kit, 'facilitator/outcomes.json'));
  assert.deepEqual(new Set(matrix.scenarios.map(row => row.id)), new Set([
    'history-on', 'history-off', 'missing-pin', 'conflicting-pin', 'altered-original', 'altered-follow-up', 'open-follow-up',
  ]), 'The entire handoff matrix must run');
  const browser = await browserSession(t);
  for (const row of matrix.scenarios) {
    await t.test(row.id, async child => {
      const page = await profile(browser, child);
      if (row.pin !== 'missing') {
        const expected = await json(join(kit, 'receiver-baselines', row.pin, 'pin.json'));
        await page.locator('#codex-folder').setInputFiles(join(kit, 'pins', row.pin));
        await page.locator('#imported-pin-run').filter({ hasText: expected.runId }).waitFor();
        await pinImportedRun(page, matrix.workflow);
        await page.locator('#imported-pin-status').filter({ hasText: expected.runId }).waitFor();
        assert.deepEqual(JSON.parse(await savedPin(page)).baselines, [{
          name: matrix.workflow, runId: expected.runId, fingerprint: expected.fingerprint,
        }]);
      }
      const pin = await savedPin(page);
      await importCase(page, join(kit, row.caseFile));
      await verifyOutcome(page, row);
      await page.reload();
      await verifyOutcome(page, row);
      assert.equal(await savedPin(page), pin, 'Import or reload changed the receiver pin');
      // A deliberately wrong outcome must fail in this exact acceptance path.
      if (row.id === 'altered-original') {
        await assert.rejects(verifyOutcome(page, { ...row, disposition: 'resolved' }), /expected .*Resolved.*observed .*Open/);
      }
    });
  }
});

test('sender repairs and closes explicitly; recipients recheck both downloaded cases', async t => {
  const browser = await browserSession(t);
  const sender = await profile(browser, t);
  await sender.evaluate(() => localStorage.setItem('test-profile-marker', 'sender'));
  await savePin(sender, join(kit, 'pins/matching'));
  const pin = await savedPin(sender);
  const damagedCase = join(kit, 'cases/altered-original.json');
  const matchingDonor = join(kit, 'donors/matching-case.json');
  const original = await json(damagedCase);
  const donor = await json(matchingDonor);
  await importCase(sender, damagedCase);
  const decision = original.decision.reason;
  assert.ok((await sender.locator('#codex-blocked-decision').innerText()).includes(decision));
  await expand(sender, 'Restore original Codex receipts');
  const picker = sender.locator('#codex-restore-file');
  const apply = sender.locator('#apply-codex-restore');
  const status = sender.locator('#codex-restore-status');
  await picker.setInputFiles(join(kit, 'donors/mismatched-workflow.json'));
  await sender.locator('#codex-restore-status.import-error').waitFor();
  assert.equal(await apply.isDisabled(), true);
  await picker.setInputFiles(matchingDonor);
  await status.filter({ hasText: 'Matching original receipts' }).waitFor();
  await sender.locator('#cancel-codex-restore').click();
  assert.equal(await apply.isDisabled(), true);
  await sender.reload();
  assert.deepEqual(await disposition(sender), { state: 'Open', ready: false });
  assert.deepEqual(await history(sender, 'local'), []);
  assert.equal(await savedPin(sender), pin);
  assert.ok((await sender.locator('#codex-blocked-decision').innerText()).includes(decision));

  await expand(sender, 'Restore original Codex receipts');
  await picker.setInputFiles(matchingDonor);
  await status.filter({ hasText: 'Matching original receipts' }).waitFor();
  await apply.click();
  const localHistory = sender.locator('#codex-local-history');
  await localHistory.getByText(labels.repair).waitFor();
  await sender.reload();
  assert.deepEqual(await disposition(sender), { state: 'Open', ready: true });
  assert.deepEqual(await history(sender, 'local'), [labels.repair]);
  assert.equal(await sender.locator('#review-decision-reason').inputValue(), decision);
  const digest = record => createHash('sha256').update(Buffer.from(record.codex.evidence.files['after.md'], 'base64')).digest('hex');
  assert.notEqual(digest(original), digest(donor));
  for (const sum of [digest(original), digest(donor)]) assert.ok((await localHistory.innerText()).includes(sum));
  await expand(sender, 'Inspect follow-up evidence');
  await sender.locator('#resolve-review-case').click();
  await localHistory.getByText(labels.closure).waitFor();
  await sender.reload();
  assert.deepEqual(await disposition(sender), { state: 'Resolved', ready: false });
  assert.deepEqual(await history(sender, 'local'), [labels.repair, labels.closure]);
  assert.equal(await savedPin(sender), pin);

  for (const shareHistory of [false, true]) {
    await t.test('download and receive with history ' + (shareHistory ? 'on' : 'off'), async child => {
      const exported = await download(sender, shareHistory ? 'sender-on' : 'sender-off', shareHistory);
      const packet = await json(exported);
      assert.equal(packet.localHistory, undefined);
      assert.equal(Boolean(packet.senderHistory), shareHistory);
      const receiver = await profile(browser, child);
      assert.equal(await receiver.evaluate(() => localStorage.getItem('test-profile-marker')), null);
      await savePin(receiver, join(kit, 'pins/matching'));
      await importCase(receiver, exported);
      await receiver.reload();
      assert.deepEqual(await disposition(receiver), { state: 'Resolved', ready: false });
      assert.deepEqual(await history(receiver, 'local'), []);
      assert.deepEqual(await history(receiver, 'sender'), shareHistory ? [labels.repair, labels.closure] : []);
      await verifySenderPanel(receiver, shareHistory);
      if (shareHistory) {
        const onwardFile = await download(receiver, 'forwarded', false);
        const forwarded = await json(onwardFile);
        assert.ok(forwarded.resolution);
        assert.equal(forwarded.senderHistory, undefined);
        assert.equal(forwarded.localHistory, undefined);
        assert.equal(await receiver.locator('#include-sender-history').count(), 0);
        const nextReceiver = await profile(browser, child);
        await savePin(nextReceiver, join(kit, 'pins/matching'));
        const nextPin = await savedPin(nextReceiver);
        await importCase(nextReceiver, onwardFile);
        await nextReceiver.reload();
        assert.deepEqual(await disposition(nextReceiver), { state: 'Resolved', ready: false });
        await verifySenderPanel(nextReceiver, false);
        assert.deepEqual(await history(nextReceiver, 'local'), []);
        assert.deepEqual(await history(nextReceiver, 'sender'), []);
        assert.equal(await savedPin(nextReceiver), nextPin);
      }
    });
  }
});

test('an invalid sender record preserves the import warning alongside the empty sender panel', async t => {
  const browser = await browserSession(t);
  const receiver = await profile(browser, t);
  await savePin(receiver, join(kit, 'pins/matching'));
  const incoming = await json(join(kit, 'cases/history-on.json'));
  incoming.senderHistory.caseId = 'unrelated-case';
  await importCase(receiver, { name: 'invalid-sender-history.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(incoming)) });
  await receiver.getByText(/Sender-reported history was omitted because it was invalid/).waitFor();
  await verifySenderPanel(receiver, false);
  await receiver.reload();
  await verifySenderPanel(receiver, false);
  assert.deepEqual(await history(receiver, 'local'), []);
  assert.deepEqual(await disposition(receiver), { state: 'Resolved', ready: false });
});
