import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeCapture, runCapture } from './run.mjs';
import { evaluateChain } from '../../src/evaluator.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const jsonl = async path => (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));

test('captured operations, disclosed omissions and source mappings support the three outcomes', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'adcp-capture-test-'));
  try {
    const output = join(temporary, 'run');
    const result = await runCapture(output);
    assert.deepEqual(result.outcomes.map(item => item.status), ['valid', 'violation', 'unknown']);
    const manifest = await json(join(output, 'manifest.json'));
    assert.equal(sha(await readFile(join(output, 'manifest.json'))), result.manifest_sha256);
    assert.equal(manifest.implementation.runner_sha256, sha(await readFile(new URL('./run.mjs', import.meta.url))));
    assert.equal(manifest.implementation.evaluator_sha256, sha(await readFile(new URL('../../src/evaluator.mjs', import.meta.url))));
    for (const [path, expected] of Object.entries(manifest.files)) {
      assert.equal(sha(await readFile(join(output, path))), expected, path);
    }
    for (const branch of ['read', 'export-expansion', 'omitted-grant']) {
      const directory = join(output, branch);
      const events = await jsonl(join(directory, 'events.jsonl'));
      const grants = await jsonl(join(directory, 'grants.jsonl'));
      const normalized = await json(join(directory, 'normalized.json'));
      const mapping = await json(join(directory, 'mapping.json'));
      assert.equal(events.length, 3);
      assert.equal(grants.length, 3);
      const inputDigest = sha(await readFile(join(directory, 'account.json')));
      for (const event of events) assert.equal(event.input_sha256, inputDigest);
      for (const record of mapping.event_records) assert.equal(events[record.line - 1].event_id, record.normalized_id);
      for (const record of mapping.grant_records) assert.equal(grants[record.line - 1].grant_id, record.normalized_id);
      assert.equal(normalized.events.length, mapping.exported_events);
      assert.equal(normalized.grants.length, mapping.exported_grants);
      const rawReplay = normalizeCapture({ id: normalized.id, title: normalized.title, principal: normalized.principal.id },
        grants, events, mapping.deliberately_omitted_grant_ids);
      assert.deepEqual(rawReplay, normalized);
      const evaluation = await json(join(directory, 'evaluation.json'));
      assert.deepEqual(evaluateChain(normalized), evaluation);
      assert.deepEqual(evaluateChain(rawReplay), evaluation);
      if (branch === 'export-expansion') {
        assert.deepEqual(await readFile(join(directory, 'account-export.json')), await readFile(join(directory, 'account.json')));
        assert.equal(events[2].export_sha256, inputDigest);
        assert.ok(evaluation.findings.some(item => item.code === 'SCOPE_EXPANSION' && item.grantId === `${normalized.id}-g3`));
      } else await assert.rejects(stat(join(directory, 'account-export.json')), { code: 'ENOENT' });
      if (branch === 'omitted-grant') {
        assert.deepEqual(evaluation.events.map(item => item.status), ['valid', 'unknown', 'unknown']);
        assert.equal(mapping.deliberately_omitted_grant_ids[0], grants[1].grant_id);
        assert.equal(normalized.grants.length, 2);
      }
    }
    const before = await readFile(join(output, 'manifest.json'));
    await assert.rejects(runCapture(output), { code: 'EEXIST' });
    assert.deepEqual(await readFile(join(output, 'manifest.json')), before);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('normalization rejects unsupported tools, duplicate source IDs and undisclosed missing source records', () => {
  const meta = { id: 'test', principal: 'fictional-user:owner' };
  const event = { event_id: 'e1', parent_event_id: null, actor_id: 'actor', grant_id: 'g1',
    tool: 'unsupported', resource_id: 'fictional:test', finished_at: '2026-11-02T12:00:00Z', outcome: 'completed' };
  assert.throws(() => normalizeCapture(meta, [], [event]), /Unsupported controlled tool/);
  assert.throws(() => normalizeCapture(meta, [], [event, event]), /Duplicate controlled record/);
  assert.throws(() => normalizeCapture(meta, [], [], ['nonexistent']), /preserved source/);
  assert.throws(() => normalizeCapture(meta, [], [{ event_id: 'e1' }]), /missing required fields/);
});
