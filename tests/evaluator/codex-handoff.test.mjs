import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  applyCodexOriginalRepair, assessFollowUp, assessReview, createReviewCase, importReviewPackage,
  previewCodexOriginalRepair, resolveReviewCase, restoreReviews,
} from '../../src/review.mjs';
import { codexClosureSteps } from '../../src/review-view.mjs';
import { parseInvestigation } from '../../src/import.mjs';
import { runFingerprint, saveInvestigation, saveWorkflowBaseline, WORKFLOW_BASELINE_KEY } from '../../src/storage.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const kitName = 'adcp-codex-handoff-demo';
const zipName = kitName + '-v0.1.0-alpha.16.zip';
const hash = contents => createHash('sha256').update(contents).digest('hex');

async function receiver(kit, pin) {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const getStorage = () => storage;
  if (pin !== 'missing') {
    const directory = join(kit, 'receiver-baselines', pin);
    const baseline = parseInvestigation(await readFile(join(directory, 'investigation.json'), 'utf8'));
    const expected = JSON.parse(await readFile(join(directory, 'pin.json'), 'utf8'));
    assert.equal(baseline.id, expected.runId);
    assert.equal(await runFingerprint(baseline), expected.fingerprint);
    saveInvestigation(getStorage, baseline);
    saveWorkflowBaseline(getStorage, 'Follow-up review', baseline, expected.fingerprint);
  }
  return getStorage;
}

function reload(getStorage) {
  const result = restoreReviews(getStorage);
  assert.equal(result.warning, '');
  assert.equal(result.items.length, 1);
  return result.items[0];
}

async function assess(getStorage) {
  const item = reload(getStorage);
  const original = await assessReview(item).catch(error => ({ error: error.message }));
  const followUp = await assessFollowUp(item, original, getStorage);
  return { item, original, followUp, checklist: codexClosureSteps(item, original, followUp) };
}

test('the extracted release-candidate ZIP reproduces all receiver outcomes and a sender handoff', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'adcp-fictional-handoff-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const build = folder => execFileSync('python3', ['scripts/build_codex_handoff.py', '--output', join(temp, folder)], {
    cwd: root, stdio: 'pipe',
  });
  build('first');
  build('second');
  const zip = join(temp, 'first', zipName);
  const contents = await readFile(zip);
  assert.deepEqual(contents, await readFile(join(temp, 'second', zipName)));
  assert.equal(await readFile(zip + '.sha256', 'utf8'), hash(contents) + '  ' + zipName + '\n');
  assert.throws(() => build('first'), /Choose a new output directory/);
  assert.deepEqual(await readFile(zip), contents);

  // Extract our own generated archive into a directory outside either build and source.
  const extraction = join(temp, 'unpacked');
  execFileSync('python3', ['-m', 'zipfile', '-e', zip, extraction]);
  const kit = join(extraction, kitName);
  const entries = await readdir(kit, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry =>
    relative(kit, join(entry.parentPath, entry.name)).split(sep).join('/'));
  const listed = [];
  for (const row of (await readFile(join(kit, 'SHA256SUMS'), 'utf8')).trimEnd().split('\n')) {
    const [, digest, name] = /^([0-9a-f]{64})  (.+)$/.exec(row);
    assert.equal(hash(await readFile(join(kit, name))), digest, name);
    listed.push(name);
  }
  assert.deepEqual(listed.sort(), files.filter(file => file !== 'SHA256SUMS').sort());
  const load = path => readFile(join(kit, path), 'utf8');
  const matrix = JSON.parse(await load('facilitator/outcomes.json'));
  const reasons = {
    'verified-closure': null, 'missing-pin': 'Baseline needed', 'conflicting-pin': 'Conflicting baseline',
    'original-receipt-mismatch': 'Original evidence', 'follow-up-receipt-mismatch': 'Follow-up evidence',
    'explicit-closure-needed': 'Ready to close',
  };
  assert.deepEqual(matrix.scenarios.map(row => row.id),
    ['history-on', 'history-off', 'missing-pin', 'conflicting-pin', 'altered-original', 'altered-follow-up', 'open-follow-up']);
  for (const row of matrix.scenarios) {
    await t.test(row.id, async () => {
      const getStorage = await receiver(kit, row.pin);
      const originalPin = getStorage().getItem(WORKFLOW_BASELINE_KEY);
      await importReviewPackage(getStorage, await load(row.caseFile));
      const { item, followUp, checklist } = await assess(getStorage);
      const disposition = followUp.resolved ? 'resolved' : followUp.canResolve ? 'open-ready' : 'open-blocked';
      assert.equal(disposition, row.disposition);
      assert.deepEqual((item.senderHistory?.entries ?? []).map(event => event.kind), row.senderHistory);
      assert.deepEqual(item.localHistory ?? [], row.localHistory);
      assert.equal(getStorage().getItem(WORKFLOW_BASELINE_KEY), originalPin);
      assert.deepEqual(checklist.map(step => step.label), reasons[row.reason] ? [reasons[row.reason]] : []);
      if (row.id.startsWith('altered-')) assert.match(checklist[0].reason, /after\.md hash mismatch/);
    });
  }

  await t.test('sender repairs and explicitly closes, recipient verifies both downloads', async () => {
    const sender = await receiver(kit, 'matching');
    await importReviewPackage(sender, await load('cases/altered-original.json'));
    const donor = await load('donors/matching-case.json');
    assert.equal(donor, await readFile(new URL('../../docs/codex-handoff/fixtures/alpha15-case.json', import.meta.url), 'utf8'));
    await assert.rejects(previewCodexOriginalRepair(sender, reload(sender), await load('donors/mismatched-workflow.json')));
    const preview = await previewCodexOriginalRepair(sender, reload(sender), donor);
    assert.deepEqual(preview.restored, ['after.md']);
    assert.equal(reload(sender).localHistory, undefined);
    await applyCodexOriginalRepair(sender, reload(sender), donor);
    const repaired = await assess(sender);
    assert.equal(repaired.followUp.canResolve, true);
    assert.equal(repaired.followUp.resolved, false);
    await resolveReviewCase(sender, repaired.item);
    const { item, followUp } = await assess(sender);
    assert.equal(followUp.resolved, true);
    for (const share of [false, true]) {
      const received = await receiver(kit, 'matching');
      const bundle = await createReviewCase(item, undefined, {
        includeCodexReceipts: true, includeSenderHistory: share, getStorage: sender,
      });
      await importReviewPackage(received, bundle);
      const checked = await assess(received);
      assert.equal(checked.followUp.resolved, true);
      assert.deepEqual(checked.item.senderHistory?.entries, share ? item.localHistory : undefined);
      assert.equal(checked.item.localHistory, undefined);
      const forwarded = JSON.parse(await createReviewCase(checked.item, undefined, {
        includeCodexReceipts: true, includeSenderHistory: true, getStorage: received,
      }));
      assert.equal(forwarded.senderHistory, undefined);
    }
  });
});
