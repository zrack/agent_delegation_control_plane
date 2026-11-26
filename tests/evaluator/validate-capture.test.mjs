import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const examples = join(root, 'docs/producer/examples');
const inputMarker = 'fictional-private-content-must-stay-in-input';
function run(...args) {
  const result = spawnSync(process.execPath, ['scripts/validate-capture.mjs', ...args, '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.stderr, '');
  assert(!result.stdout.includes(inputMarker) && !result.stdout.includes(root));
  return { output: JSON.parse(result.stdout), exit: result.status };
}
const sha = value => createHash('sha256').update(value).digest('hex');

test('producer examples reproduce all input fields and distinguish missing authority from a malformed record', async () => {
  const input = name => run('--investigation', join(examples, name));
  const { chain } = JSON.parse(await readFile(join(examples, 'investigation.json')));
  const source = JSON.parse(await readFile(join(examples, 'source-records.json')));
  assert.equal(chain.events[0].evidence.artifactSha256, sha(source.observedArtifactUtf8));
  assert.equal(chain.events[0].authorityId, source.issuedGrant.id);
  assert.equal(input('investigation.json').exit, 0);
  const missing = input('missing-grant.json');
  assert.equal(missing.exit, 1);
  assert.equal(missing.output.status, 'unverifiable');
  assert(missing.output.diagnostics.some(issue => issue.code === 'GRANT_MISSING'
    && issue.grantId === 'guide-read' && issue.field === 'chain.events[0].authorityId'));
  const malformed = input('malformed.json');
  assert.equal(malformed.exit, 2);
  assert.equal(malformed.output.diagnostics[0].field, 'chain.events[0].action.resource');
});

test('offline Codex checks identify source files and indices, validate hashes, bound input, and suppress receipt contents', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'adcp-producer-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const files = JSON.parse(await readFile(join(root, 'docs/codex-handoff/fixtures/matching-capture.json')));
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(folder, name), bytes);
  const invoke = () => run('--codex-folder', folder);
  assert.equal(invoke().output.verifiedFileCount, 7);
  const manifest = JSON.parse(files['manifest.json']);
  const replace = async (name, text) => {
    await writeFile(join(folder, name), text);
    await writeFile(join(folder, 'manifest.json'), JSON.stringify({ ...manifest, [name]: sha(text) }));
  };
  await writeFile(join(folder, 'after.md'), inputMarker);
  const mismatch = invoke();
  assert.equal(mismatch.exit, 1);
  assert.equal(mismatch.output.status, 'receipt-mismatch');
  assert.equal(mismatch.output.diagnostics[0].file, 'after.md');
  await replace('after.md', inputMarker);
  assert.equal(invoke().output.diagnostics[0].code, 'ACTION_RECEIPT_MISMATCH');
  await replace('after.md', files['after.md']);
  const grants = files['grants.jsonl'].trimEnd().split('\n');
  await replace('grants.jsonl', grants[0] + '\n');
  const missing = invoke();
  assert.equal(missing.output.receipts, 'verified');
  assert.equal(missing.output.status, 'unverifiable');
  assert(missing.output.diagnostics.some(issue => issue.file === 'actions.jsonl' && issue.field === 'records[1].authorityId'));
  await replace('grants.jsonl', grants[0] + '\n' + inputMarker + '\n');
  assert.deepEqual(invoke().output.diagnostics[0], { code: 'INVALID_CAPTURE', file: 'grants.jsonl', field: 'records[1]',
    message: 'Expected a JSON object in grants.jsonl.' });
  const malformed = JSON.parse(grants[1]);
  malformed.subject = {};
  await replace('grants.jsonl', grants[0] + '\n' + JSON.stringify(malformed) + '\n');
  assert.equal(invoke().output.diagnostics[0].field, 'records[1].subject');
  await replace('grants.jsonl', files['grants.jsonl']);
  await writeFile(join(folder, 'after.md'), 'x'.repeat(128 * 1024 + 1));
  assert.equal(invoke().exit, 2);
  await rm(join(folder, 'after.md'));
  await symlink('before.md', join(folder, 'after.md'));
  assert.equal(invoke().output.diagnostics[0].code, 'UNREADABLE_INPUT');
});

test('two branches with one missing ancestor identify their own referring grant', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'adcp-branch-source-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const input = JSON.parse(await readFile(join(examples, 'investigation.json')));
  const { chain } = input;
  const original = chain.grants[0];
  const rootEvent = chain.events[0];
  for (const suffix of ['first', 'second']) {
    const grant = { ...original, id: 'grant-' + suffix, parentGrantId: 'missing-ancestor' };
    chain.grants.push(grant);
    chain.events.push({ ...rootEvent, id: 'read-' + suffix, parentEventId: rootEvent.id, authorityId: grant.id });
  }
  const path = join(temp, 'branches.json');
  await writeFile(path, JSON.stringify(input));
  const checked = run('--investigation', path).output;
  const gaps = checked.diagnostics.filter(finding => finding.code === 'GRANT_MISSING' && finding.grantId === 'missing-ancestor');
  assert.deepEqual(gaps.map(({ eventId, field }) => [eventId, field]), [
    ['read-first', 'chain.grants[1].parentGrantId'], ['read-second', 'chain.grants[2].parentGrantId'],
  ]);
});
