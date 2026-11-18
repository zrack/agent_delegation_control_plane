import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { importCodexFolder } from '../../src/codex-import.mjs';
import { evaluateChain } from '../../src/evaluator.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const jsonl = records => records.map(record => JSON.stringify(record) + '\n').join('');

function capture() {
  const at = '2026-01-01T00:01:00Z';
  const owner = 'fictional-owner';
  const resource = 'repo://fixture/docs/quickstart.md';
  const before = 'Old quickstart.\n';
  const after = 'New quickstart.\n';
  const capabilities = ['file:read', 'file:write'].map(action => ({ action, resource }));
  const grant = (id, parentGrantId, issuer, subject, canDelegate) => ({
    id, parentGrantId, issuer, subject, principal: owner, capabilities, canDelegate,
    validFrom: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T00:02:00Z',
  });
  const action = (id, parentEventId, actor, authorityId, capability, tool, artifact) => ({
    id, parentEventId, actor, authorityId, action: { ...capability, at, outcome: 'completed' },
    evidence: { tool, callId: 'call-' + id, artifactSha256: sha(artifact) },
  });
  const grants = [grant('root', null, owner, 'coordinator', true), grant('edit', 'root', 'coordinator', 'agent', false)];
  const actions = [
    action('fixture-inspect', null, 'coordinator', 'root', capabilities[0], 'preflight_read', before),
    action('fixture-read', 'fixture-inspect', 'agent', 'edit', capabilities[0], 'read_quickstart', before),
    action('fixture-write', 'fixture-inspect', 'agent', 'edit', capabilities[1], 'update_preview_paragraph', after),
  ];
  return {
    'actions.jsonl': jsonl(actions),
    'grants.jsonl': jsonl(grants),
    'attempts.jsonl': jsonl(actions.slice(1).map(({ evidence }) => ({
      tool: evidence.tool, callId: evidence.callId, at, status: 'completed',
    }))),
    'before.md': before,
    'after.md': after,
    'quickstart.diff': '-Old quickstart.\n+New quickstart.\n',
    'codex-events.jsonl': '{"type":"turn.completed"}\n',
  };
}

function manifest(files) {
  return JSON.stringify(Object.fromEntries(Object.entries(files).map(([name, contents]) => [name, sha(contents)])));
}

function selection(files, originalManifest = manifest(files), root = 'fixture') {
  return Object.entries({ ...files, 'manifest.json': originalManifest }).map(([name, contents]) =>
    Object.assign(new Blob([contents]), { webkitRelativePath: root + '/' + name }));
}

test('checks every listed capture file and imports the action and grant evidence', async () => {
  const files = capture();
  const selected = selection(files);
  selected.push({ webkitRelativePath: 'fixture/codex-stderr.log' });
  selected.push({ webkitRelativePath: 'fixture/nested/after.md' });
  const { chain, verifiedFileCount } = await importCodexFolder(selected);
  assert.equal(verifiedFileCount, 7);
  assert.equal(chain.principal.id, 'fictional-owner');
  assert.equal(chain.events[2].evidence.artifactSha256, sha(files['after.md']));
  assert.equal(evaluateChain(chain).status, 'valid');
  assert.equal((await importCodexFolder(selection(files, manifest(files), 'renamed'))).chain.id, chain.id);
  assert.equal(chain.before, undefined);
});

test('preserves the missing grant as uncertainty at both affected hops and a separate run', async () => {
  const files = capture();
  const complete = await importCodexFolder(selection(files));
  files['grants.jsonl'] = files['grants.jsonl'].split('\n')[0] + '\n';
  const { chain } = await importCodexFolder(selection(files));
  assert.notEqual(chain.id, complete.chain.id);
  const result = evaluateChain(chain);
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.findings.filter(item => item.code === 'GRANT_MISSING').map(item => item.eventId),
    ['fixture-read', 'fixture-write']);
  files['grants.jsonl'] = '';
  assert.equal(evaluateChain((await importCodexFolder(selection(files))).chain).status, 'unknown');
});

test('rejects an altered receipt before import even if its manifest entry was refreshed', async () => {
  const files = capture();
  const originalManifest = manifest(files);
  files['after.md'] += 'Altered bytes.\n';
  await assert.rejects(importCodexFolder(selection(files, originalManifest)), /after\.md hash mismatch/);
  await assert.rejects(importCodexFolder(selection(files)), /after\.md does not match the digest recorded by its action/);
});

test('rejects missing or inconsistent completion receipts', async () => {
  const files = capture();
  files['attempts.jsonl'] = files['attempts.jsonl'].replace('call-fixture-write', 'call-different-action');
  await assert.rejects(importCodexFolder(selection(files)), /does not match its tool receipt/);
  files['attempts.jsonl'] += files['attempts.jsonl'];
  await assert.rejects(importCodexFolder(selection(files)), /invalid or duplicate tool call/);
});

test('rejects ambiguous, missing, or oversized evidence without reading unrelated files', async () => {
  const files = capture();
  const originalManifest = manifest(files);
  const duplicate = originalManifest.replace('{', '{"after.md":"' + sha(files['after.md']) + '",');
  await assert.rejects(importCodexFolder(selection(files, duplicate)), /exactly the seven/);
  await assert.rejects(importCodexFolder(selection(files).filter(file => !file.webkitRelativePath.endsWith('/grants.jsonl'))),
    /Missing grants\.jsonl/);
  await assert.rejects(importCodexFolder([...selection(files), { webkitRelativePath: 'different/manifest.json' }]), /Choose one/);
  files['before.md'] = ' '.repeat(128 * 1024 + 1);
  await assert.rejects(importCodexFolder(selection(files)), /before\.md exceeds/);
});
