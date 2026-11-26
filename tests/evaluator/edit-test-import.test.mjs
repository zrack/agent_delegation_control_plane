import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { editTestFolderLimits, importEditTestFolder } from '../../src/edit-test-import.mjs';
import { editTestFiles, expectedOutput, expectedRevision, manifest, privateMarker, selectedFiles, sha, writeFolder } from '../fixtures/edit-test.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const inspect = files => importEditTestFolder(selectedFiles(files));
const codes = result => result.diagnostics.map(d => d.code);

// The disposable capture's read-only replay defines these four independent outcomes.
const blocked = [
  ['missing-grant', 'MISSING_VERIFIER_GRANT', 'unverifiable', 'verified'],
  ['altered-receipt', 'RECEIPT_HASH_MISMATCH', 'within-scope', 'mismatch'],
  ['altered-output', 'OUTPUT_HASH_MISMATCH', 'within-scope', 'mismatch'],
  ['attempt-only', 'NO_COMPLETED_VERIFICATION', null, 'not-applicable'],
];

test('passing capture independently links both grants, the edited revision and the saved output bytes', async () => {
  const files = editTestFiles();
  const result = await inspect(files);
  assert.equal(result.status, 'verified');
  assert.deepEqual(codes(result), []);
  assert.deepEqual([result.editor.grant.id, result.verifier.grant.id], ['edit', 'verify']);
  assert.deepEqual([result.editor.grant.issuer, result.verifier.grant.parentGrantId], ['demo-coordinator', 'root']);
  assert.equal(result.editor.grant.subject, 'demo-editor');
  assert.equal(result.verifier.grant.subject, 'demo-tester');
  assert.equal(result.editor.authority, 'within-scope'); assert.equal(result.verifier.authority, 'within-scope');
  assert.equal(result.receipt.status, 'verified');
  assert.equal(result.receipt.testedRevision, expectedRevision);
  assert.equal(result.receipt.exitCode, 0);
  assert.equal(result.receipt.expectedSha256, sha(files['test-receipt.json']));
  assert.equal(result.receipt.actualSha256, result.receipt.expectedSha256);
  const stderr = result.receipt.outputs.find(o => o.file === 'test-stderr.txt');
  assert.equal(stderr.expectedSha256, expectedOutput); assert.equal(stderr.actualSha256, expectedOutput);
  assert.ok(!JSON.stringify(result).includes(privateMarker));
});

for (const [scenario, reason, authority, receipt] of blocked) {
  test(scenario + ' remains open for its specific reason with a refreshed outer manifest', async () => {
    const result = await inspect(editTestFiles(scenario));
    assert.equal(result.status, 'open');
    assert.ok(codes(result).includes(reason), JSON.stringify(codes(result)));
    assert.equal(result.editor.authority, 'within-scope');
    if (authority) assert.equal(result.verifier.authority, authority);
    assert.equal(result.receipt.status, receipt);
    if (scenario === 'attempt-only') assert.equal(result.verifier.completed, false);
    if (scenario === 'altered-output') {
      const stderr = result.receipt.outputs.find(o => o.file === 'test-stderr.txt');
      assert.equal(stderr.expectedSha256, expectedOutput);
      assert.equal(stderr.actualSha256, sha(Buffer.from([0xff, 0x00, 0x61])));
    }
  });
}

test('a test can have a verified receipt and still fail', async () => {
  const result = await inspect(editTestFiles('failed-test'));
  assert.equal(result.status, 'open'); assert.equal(result.receipt.status, 'verified');
  assert.equal(result.receipt.exitCode, 1);
});

test('a matching receipt digest cannot substitute for the right edit or test attempt', async () => {
  for (const field of ['testedRevision', 'testedSourceSha256', 'testSha256', 'attemptId']) {
    const files = editTestFiles();
    const receipt = JSON.parse(files['test-receipt.json']);
    receipt[field] = field === 'attemptId' ? 'attempt-edit' : '0'.repeat(receipt[field].length);
    files['test-receipt.json'] = JSON.stringify(receipt);
    const events = files['actions.jsonl'].trim().split('\n').map(JSON.parse);
    events[1].evidence.receiptSha256 = sha(files['test-receipt.json']);
    files['actions.jsonl'] = events.map(JSON.stringify).join('\n') + '\n';
    files.SHA256SUMS = manifest(files);
    assert.notEqual((await inspect(files)).status, 'verified', field);
  }
});

test('attempt only also works without any test receipt or output files', async () => {
  const files = editTestFiles('attempt-only');
  for (const name of ['test-receipt.json', 'test-stdout.bin', 'test-stderr.txt']) delete files[name];
  files.SHA256SUMS = manifest(files);
  const result = await inspect(files);
  assert.equal(result.status, 'open');
  assert.ok(codes(result).includes('NO_COMPLETED_VERIFICATION'));
  assert.equal(result.receipt.status, 'not-applicable');
});

test('the checksum list and the verifier give independent, attributable digest findings', async () => {
  const clean = editTestFiles();
  for (const [scenario, file, linkage] of [
    ['altered-receipt', 'test-receipt.json', 'RECEIPT_HASH_MISMATCH'],
    ['altered-output', 'test-stderr.txt', 'OUTPUT_HASH_MISMATCH'],
  ]) {
    const damaged = editTestFiles(scenario);
    damaged.SHA256SUMS = clean.SHA256SUMS;
    const reasons = result => result.diagnostics.filter(d => d.file === file).map(d => d.code);
    assert.deepEqual(reasons(await inspect(damaged)), ['MANIFEST_HASH_MISMATCH', linkage]);
    const wrongManifest = { ...clean, SHA256SUMS: manifest(editTestFiles(scenario)) };
    assert.deepEqual(reasons(await inspect(wrongManifest)), ['MANIFEST_HASH_MISMATCH']);
  }
});

test('a receipt with an absent tree or contradictory extra claim cannot verify, even when the action cites its new hash', async () => {
  for (const [change, code] of [[{ tree: '0'.repeat(40) }, 'TESTED_CONTENT_MISMATCH'],
    [{ outcome: 'failed' }, 'INVALID_TEST_RECEIPT']]) {
    const files = editTestFiles();
    files['test-receipt.json'] = JSON.stringify({ ...JSON.parse(files['test-receipt.json']), ...change });
    const events = files['actions.jsonl'].trim().split('\n').map(JSON.parse);
    events[1].evidence.receiptSha256 = sha(files['test-receipt.json']);
    files['actions.jsonl'] = events.map(JSON.stringify).join('\n') + '\n';
    files.SHA256SUMS = manifest(files);
    const result = await inspect(files);
    assert.equal(result.status, 'open');
    assert.deepEqual(codes(result), [code]);
  }
});

test('unittest discovery must cover the granted test resource in the recorded command', async () => {
  const files = editTestFiles();
  for (const name of ['actions.jsonl', 'attempts.jsonl', 'grants.jsonl', 'test-receipt.json']) {
    files[name] = files[name].replaceAll('tests/test_packing.py', 'src/test_packing.py');
  }
  const setup = JSON.parse(files['setup.json']);
  setup.grantFileSha256 = sha(files['grants.jsonl']);
  files['setup.json'] = JSON.stringify(setup);
  const events = files['actions.jsonl'].trim().split('\n').map(JSON.parse);
  events[1].evidence.receiptSha256 = sha(files['test-receipt.json']);
  files['actions.jsonl'] = events.map(JSON.stringify).join('\n') + '\n';
  files.SHA256SUMS = manifest(files);
  const result = await inspect(files);
  assert.equal(result.status, 'open');
  assert.deepEqual(codes(result), ['TEST_DISCOVERY_TARGET_MISMATCH']);
});

test('only bounded top-level files are read, and escaped duplicate JSON fields cannot replace an earlier claim', async () => {
  const files = editTestFiles();
  let read = false;
  const extra = name => ({ webkitRelativePath: 'capture/' + name, size: 1,
    arrayBuffer: () => { read = true; throw new Error(); } });
  const selected = selectedFiles(files);
  const ignored = ['capture_action.py', 'repository.bundle', 'subdir/test-stderr.txt'].map(extra);
  assert.equal((await importEditTestFolder([...selected, ...ignored])).status, 'verified');
  assert.equal(read, false);

  const name = 'test-stderr.txt';
  const remaining = selected.filter(file => file.webkitRelativePath !== 'capture/' + name);
  const oversized = { ...extra(name), size: editTestFolderLimits[name] + 1 };
  await assert.rejects(importEditTestFolder([...remaining, oversized]), error => error.file === name);
  assert.equal(read, false);
  oversized.size = 1;
  oversized.arrayBuffer = async () => new ArrayBuffer(editTestFolderLimits[name] + 1);
  await assert.rejects(importEditTestFolder([...remaining, oversized]), error => error.file === name);
  files['actions.jsonl'] = files['actions.jsonl'].replace('"afterSha256":', '"aft\\u0065rSha256":"ignored","afterSha256":');
  files.SHA256SUMS = manifest(files);
  await assert.rejects(inspect(files), error => error.file === 'actions.jsonl' && /Duplicate JSON fields/.test(error.message));
});

test('CLI reads only fixed local files and reports the domain errors without dumping raw output', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fictional-edit-test-'));
  t.after(() => rm(dir, { recursive:true, force:true }));
  const run = (path, args = ['--json']) => spawnSync(process.execPath,
    ['scripts/validate-capture.mjs', '--edit-test-folder', path, ...args], { cwd:root, encoding:'utf8' });
  for (const [scenario, reason] of [['passing', null], ...blocked]) {
    const path = await writeFolder(join(dir, scenario), editTestFiles(scenario));
    const before = await readFile(join(path, 'test-receipt.json'));
    const cli = run(path);
    assert.equal(cli.status, reason ? 1 : 0, cli.stderr || cli.stdout);
    assert.equal(cli.stderr, '');
    assert.ok(!cli.stdout.includes(privateMarker) && !cli.stdout.includes(dir));
    const result = JSON.parse(cli.stdout);
    assert.equal(result.inputKind, 'edit-test-folder');
    if (reason) assert.ok(codes(result).includes(reason));
    assert.deepEqual(await readFile(join(path, 'test-receipt.json')), before);
  }
  const human = run(join(dir,'passing'), []);
  assert.match(human.stdout, /Editor.*demo-editor/); assert.match(human.stdout, /Verifier.*demo-tester/);
  assert.match(human.stdout, /Test receipt/); assert.ok(!human.stdout.includes(privateMarker));
  assert.match(human.stdout, /Recorded test command · python3 -I -B -m unittest discover -s tests -v/);
  await symlink(join(dir,'passing'), join(dir,'linked'));
  assert.equal(run(join(dir,'linked')).status, 2);
  const file = join(dir, 'passing', 'test-stderr.txt');
  await rm(file); await symlink(join(dir,'missing-grant','test-stderr.txt'), file);
  assert.equal(run(join(dir,'passing')).status, 2);
});
