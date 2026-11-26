import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { browserSession, expand, profile, work } from './dashboard.mjs';
import { editTestFiles, expectedOutput, expectedRevision, privateMarker, writeFolder } from '../fixtures/edit-test.mjs';

test('review the two grants and test receipt and identify the exact blocker when switching captures', async t => {
  const page = await profile(await browserSession(t), t);
  await expand(page, 'Inspect an edit-and-test folder');
  const input = page.getByLabel('Edit-and-test run folder', { exact: true });
  const results = page.locator('#edit-test-results');
  const panel = name => results.locator('section').filter({ has: page.getByRole('heading', { name, exact: true }) }).first();
  const field = (area, label) => area.getByText(label, { exact: true }).locator('xpath=following-sibling::dd[1]');
  const gate = [
    ['passing', 'verified', null], ['missing-grant', 'open', 'MISSING_VERIFIER_GRANT'],
    ['altered-receipt', 'open', 'RECEIPT_HASH_MISMATCH'], ['altered-output', 'open', 'OUTPUT_HASH_MISMATCH'],
    ['attempt-only', 'open', 'NO_COMPLETED_VERIFICATION'], ['invalid', 'invalid-input', null],
  ];
  for (const [scenario, state, reason] of gate) {
    await t.test(scenario, async () => {
      const files = scenario === 'invalid' ? { 'setup.json': '{' } : editTestFiles(scenario);
      const directory = await writeFolder(join(work, 'edit-test-ui', scenario), files);
      await input.setInputFiles(directory);
      if (reason) await results.getByText(new RegExp(reason)).waitFor();
      await page.locator('#edit-test-results[data-status="' + state + '"]').waitFor({ state: 'attached' });
      if (state === 'invalid-input') {
        assert.equal(await results.getByRole('heading', { name:'Test receipt', exact:true }).count(), 0);
        assert.equal(await results.getByText(expectedRevision, { exact:true }).count(), 0);
        return;
      }
      const editor = panel('Editor'), verifier = panel('Verifier'), receipt = panel('Test receipt');
      assert.equal(await field(editor, 'Subject').innerText(), 'demo-editor');
      assert.equal(await field(editor, 'Authority').innerText(), 'Within scope');
      if (scenario === 'passing') {
        assert.equal(await field(verifier, 'Subject').innerText(), 'demo-tester');
        assert.equal(await field(verifier, 'Parent grant').innerText(), 'root');
        assert.equal(await field(verifier, 'Issuer').innerText(), 'demo-coordinator');
        assert.equal(await field(receipt, 'Tested revision').innerText(), expectedRevision);
        assert.equal(await field(receipt, 'Recorded test command').innerText(), 'python3 -I -B -m unittest discover -s tests -v');
        assert.equal(await field(receipt, 'Recorded exit code').innerText(), '0');
        assert.ok((await panel('Test output digests').innerText()).includes(expectedOutput));
      } else if (scenario === 'missing-grant') {
        assert.equal(await field(verifier, 'Authority').innerText(), 'Unverifiable');
        assert.equal(await field(receipt, 'Receipt check').innerText(), 'Verified');
      } else if (scenario === 'attempt-only') {
        assert.equal(await field(verifier, 'Recorded outcome').innerText(), 'No completed action recorded');
        assert.equal(await field(receipt, 'Receipt check').innerText(), 'No completed test to verify');
      } else {
        assert.equal(await field(receipt, 'Receipt check').innerText(), 'Mismatch');
      }
      assert.ok(!(await results.innerText()).includes(privateMarker));
    });
  }
});
