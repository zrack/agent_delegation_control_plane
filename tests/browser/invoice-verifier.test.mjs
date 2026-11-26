import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { invoiceCases } from '../fixtures/invoice-case.mjs';
import { browserSession, disposition, importCase, profile, savedPin, work } from './dashboard.mjs';

async function pinInvoice(page, directory) {
  const investigation = join(directory, 'investigation.json');
  const { chain } = JSON.parse(await readFile(investigation, 'utf8'));
  await page.locator('#investigation-file').setInputFiles(investigation);
  await page.waitForURL(url => url.hash.startsWith('#' + chain.id));
  await page.locator('#compare-link').click();
  await page.locator('#baseline-run').selectOption(chain.id);
  await page.getByText('Save or replace a workflow baseline', { exact: true }).click();
  await page.locator('#workflow-name').fill('Invoices');
  await page.locator('#save-workflow-baseline').click();
  await page.locator('#workflow-status').filter({ hasText: 'Saved baseline ' + chain.id }).waitFor();
}

test('portable invoice verifier and dashboard agree across corrected cases, changed receipts and receiver pins', async t => {
  const dir = await mkdtemp(join(work, 'invoice-verify-'));
  await invoiceCases(dir);
  const browser = await browserSession(t);
  for (const [name, pin, expected, blocker] of [
    ['repairedMissing', 'matching', 'resolved'],
    ['repairedOutput', undefined, 'resolved'],
    ['repairedOutput', 'conflict', 'open-blocked', 'uses a different baseline'],
    ['changedBaseline', 'matching', 'open-blocked', 'Baseline mismatch'],
    ['damaged', undefined, 'open-blocked', 'results.json · Hash mismatch'],
    ['damagedOriginal', 'matching', 'open-blocked', 'Saved invoice snapshot could not be verified'],
    ['failedExecution', 'matching', 'open-blocked', 'Execution needs review'],
    ['unclosed', 'matching', 'open-ready', 'Ready to close'],
    ['unclosed', undefined, 'open-blocked', 'is not pinned in this browser'],
  ]) {
    await t.test(name + ' with ' + (pin ?? 'no') + ' pin', async child => {
      const file = join(dir, name + '.json');
      const args = ['scripts/verify-case.mjs', '--case', file, '--json'];
      if (pin) args.push('--workflow', 'Invoices', '--baseline-dir', join(dir, pin));
      const command = spawnSync(process.execPath, args, { encoding: 'utf8' });
      assert.equal(command.status, expected === 'resolved' ? 0 : 1);
      const result = JSON.parse(command.stdout);
      assert.equal(result.disposition, expected);
      const page = await profile(browser, child);
      if (pin) await pinInvoice(page, join(dir, pin));
      const before = await savedPin(page);
      await importCase(page, file);
      await page.reload();
      assert.deepEqual(await disposition(page), {
        state: result.disposition === 'resolved' ? 'Resolved' : 'Open', ready: result.disposition === 'open-ready',
      });
      if (blocker) assert.ok((await page.locator('.closure-checklist').innerText()).includes(blocker));
      assert.equal(await savedPin(page), before);
    });
  }
});
