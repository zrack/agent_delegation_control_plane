import test from 'node:test';
import assert from 'node:assert/strict';
import { chains } from '../../src/fixtures.mjs';
import { parseInvestigation } from '../../src/import.mjs';
import { evaluateChain } from '../../src/evaluator.mjs';
import { STORAGE_KEY, MAX_SAVED_RUNS, MAX_STORAGE_BYTES, restoreInvestigations, saveInvestigation, clearInvestigations } from '../../src/storage.mjs';
import { WORKFLOW_BASELINE_KEY, removeWorkflowBaseline, restoreWorkflowBaselines, runFingerprint, saveWorkflowBaseline } from '../../src/storage.mjs';

function memory() {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  return { storage, get: () => storage, data };
}
function imported(index = 1, id = 'IMPORT-persistence') {
  const chain = structuredClone(chains[index]);
  chain.id = id;
  chain.events[0].evidence = { callId: 'call-fixture', tool: 'fixture_tool', artifactSha256: 'a'.repeat(64) };
  return parseInvestigation(JSON.stringify({ schemaVersion: 1, chain }));
}

test('reload restores normalized evidence and recomputes valid, violation and unknown findings', () => {
  const state = memory();
  assert.deepEqual(restoreInvestigations(state.get), { chains: [], warning: '' });
  for (let index = 0; index < 3; index++) {
    const chain = imported(index, `IMPORT-${index}`);
    chain.title = '<img src=x onerror=alert(1)>';
    saveInvestigation(state.get, chain);
  }
  const restored = restoreInvestigations(state.get);
  assert.equal(restored.warning, '');
  assert.equal(restored.chains.length, 3);
  restored.chains.forEach((chain, index) => {
    assert.equal(chain.title, '<img src=x onerror=alert(1)>');
    assert.deepEqual(chain.events[0].evidence, imported(index).events[0].evidence);
    assert.deepEqual(evaluateChain(chain), evaluateChain(imported(index)));
  });
  assert.deepEqual(restored.chains.map(chain => evaluateChain(chain).status), ['violation', 'valid', 'unknown']);
});

test('reimport replaces the same ID; separate tabs merge against the latest saved records', () => {
  const state = memory();
  const first = imported(1, 'IMPORT-one');
  saveInvestigation(state.get, first);
  saveInvestigation(state.get, imported(2, 'IMPORT-two'));
  first.summary = 'Updated export';
  saveInvestigation(state.get, first);
  const restored = restoreInvestigations(state.get).chains;
  assert.equal(restored.length, 2);
  assert.equal(restored.find(chain => chain.id === first.id).summary, 'Updated export');
  assert.equal(restored.find(chain => chain.id === 'IMPORT-two').events.length, 3);
});

test('damaged or hostile saved data cannot replace examples or erase valid records on write', () => {
  const state = memory();
  const good = { schemaVersion: 1, chain: imported() };
  const bad = { schemaVersion: 1, chain: structuredClone(chains[0]) };
  const raw = JSON.stringify({ schemaVersion: 1, runs: [bad, good, good] });
  state.data.set(STORAGE_KEY, raw);
  const restored = restoreInvestigations(state.get);
  assert.equal(restored.chains.length, 1);
  assert.match(restored.warning, /could not be restored/);
  assert.throws(() => saveInvestigation(state.get, imported()), /unreadable/);
  assert.equal(state.data.get(STORAGE_KEY), raw);
  for (const value of ['{', 'null', JSON.stringify({ schemaVersion: 2, runs: [] }), ' '.repeat(MAX_STORAGE_BYTES + 1)]) {
    state.data.set(STORAGE_KEY, value);
    assert.equal(restoreInvestigations(state.get).chains.length, 0);
    assert.match(restoreInvestigations(state.get).warning, /could not be read/);
  }
});

test('storage access and quota failures are recoverable without overwriting previous evidence', () => {
  const blocked = () => { throw new Error('SecurityError'); };
  assert.match(restoreInvestigations(blocked).warning, /unavailable/);
  assert.throws(() => saveInvestigation(blocked, imported()));
  assert.throws(() => clearInvestigations(blocked));
  const state = memory();
  saveInvestigation(state.get, imported());
  const before = state.data.get(STORAGE_KEY);
  state.storage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.throws(() => saveInvestigation(state.get, imported(2, 'IMPORT-new')), /Quota/);
  assert.equal(state.data.get(STORAGE_KEY), before);
});

test('collection count and byte budgets never silently evict an older run', () => {
  const state = memory();
  for (let index = 0; index < MAX_SAVED_RUNS; index++) saveInvestigation(state.get, imported(1, `IMPORT-${index}`));
  const before = state.data.get(STORAGE_KEY);
  assert.throws(() => saveInvestigation(state.get, imported(1, 'IMPORT-overflow')), /at most/);
  assert.equal(state.data.get(STORAGE_KEY), before);
  saveInvestigation(state.get, imported(2, 'IMPORT-0'));
  clearInvestigations(state.get);
  const large = imported();
  large.grants = Array.from({ length: 100 }, (_, index) => ({ ...large.grants[0], id: `g-${index}`, capabilities: Array.from({ length: 10 }, () => ({ action: 'a'.repeat(200), resource: 'r'.repeat(500) })) }));
  saveInvestigation(state.get, large);
  saveInvestigation(state.get, { ...large, id: 'IMPORT-large-two' });
  const twoRuns = state.data.get(STORAGE_KEY);
  assert.throws(() => saveInvestigation(state.get, { ...large, id: 'IMPORT-large-three' }), /2 MiB/);
  assert.equal(state.data.get(STORAGE_KEY), twoRuns);
});

test('clear removes only dashboard imports; original exports can be reimported', () => {
  const state = memory();
  state.storage.setItem('unrelated-preference', 'keep');
  const original = imported();
  saveInvestigation(state.get, original);
  clearInvestigations(state.get);
  assert.equal(state.storage.getItem('unrelated-preference'), 'keep');
  assert.deepEqual(restoreInvestigations(state.get), { chains: [], warning: '' });
  saveInvestigation(state.get, original);
  assert.deepEqual(restoreInvestigations(state.get).chains[0], original);
});

test('named workflows survive reload and a same-ID import cannot silently move the pin', async () => {
  const state = memory();
  const first = imported(1, 'BASELINE-A');
  const second = imported(1, 'BASELINE-B');
  saveInvestigation(state.get, first);
  saveInvestigation(state.get, second);
  const firstDigest = await runFingerprint(first);
  const secondDigest = await runFingerprint(second);
  saveWorkflowBaseline(state.get, ' Invoice validation ', first, firstDigest);
  saveWorkflowBaseline(state.get, 'Account review', second, secondDigest);
  const [invoice, account] = restoreWorkflowBaselines(state.get).baselines;
  assert.deepEqual(invoice, { name: 'Invoice validation', runId: first.id, fingerprint: firstDigest });
  assert.equal(await runFingerprint(restoreInvestigations(state.get).chains[0]), firstDigest);
  first.intent = 'Changed evidence for the same ID';
  saveInvestigation(state.get, first);
  assert.notEqual(await runFingerprint(restoreInvestigations(state.get).chains.find(chain => chain.id === first.id)), firstDigest);
  assert.equal(restoreWorkflowBaselines(state.get).baselines[0].fingerprint, firstDigest);
  assert.throws(() => saveWorkflowBaseline(state.get, 'invoice validation', second, secondDigest), /changed/);
  saveWorkflowBaseline(state.get, 'invoice validation', second, secondDigest, invoice);
  assert.equal(restoreWorkflowBaselines(state.get).baselines.length, 2);
  assert.throws(() => removeWorkflowBaseline(state.get, invoice), /changed/);
  removeWorkflowBaseline(state.get, account);
  clearInvestigations(state.get);
  assert.equal(restoreWorkflowBaselines(state.get).baselines[0].fingerprint, secondDigest);
  assert.equal(restoreInvestigations(state.get).chains.length, 0);
});

test('an unsaved run and corrupted workflow metadata cannot overwrite a pin', async () => {
  const state = memory();
  const chain = imported();
  const digest = await runFingerprint(chain);
  assert.throws(() => saveWorkflowBaseline(state.get, 'Invoice validation', chain, digest), /before pinning/);
  saveInvestigation(state.get, chain);
  state.data.set(WORKFLOW_BASELINE_KEY, '{bad');
  assert.match(restoreWorkflowBaselines(state.get).warning, /could not be read/);
  assert.throws(() => saveWorkflowBaseline(state.get, 'Invoice validation', chain, digest));
  assert.equal(state.data.get(WORKFLOW_BASELINE_KEY), '{bad');
  assert.equal(restoreInvestigations(state.get).chains.length, 1);
});
