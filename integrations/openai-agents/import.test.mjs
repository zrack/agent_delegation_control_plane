import test from 'node:test';
import assert from 'node:assert/strict';
import { chains } from '../../src/fixtures.mjs';
import { evaluateChain } from '../../src/evaluator.mjs';
import { MAX_IMPORT_BYTES, parseInvestigation, mergeInvestigation } from '../../src/import.mjs';

function exported(index = 1) {
  const chain = structuredClone(chains[index]);
  chain.id = 'IMPORT-test';
  return { schemaVersion: 1, chain };
}

test('import preserves findings and uncertainty while keeping examples and literal source text', () => {
  const envelope = exported();
  envelope.chain.title = '<img src=x onerror=alert(1)>';
  const imported = parseInvestigation(JSON.stringify(envelope));
  assert.equal(evaluateChain(imported).status, 'valid');
  assert.equal(imported.title, envelope.chain.title); // Rendering escapes this literal text.
  const merged = mergeInvestigation(chains, imported);
  assert.equal(merged.length, 4);
  assert.equal(mergeInvestigation(merged, imported).length, 4);
  assert.equal(merged[0], chains[0]);
  assert.equal(evaluateChain(parseInvestigation(JSON.stringify(exported(0)))).status, 'violation');
  assert.equal(evaluateChain(parseInvestigation(JSON.stringify(exported(2)))).status, 'unknown');
});

test('import rejects unsupported shapes, duplicate IDs, non-completed actions and resource exhaustion', () => {
  assert.throws(() => parseInvestigation('{'), /valid JSON/);
  assert.throws(() => parseInvestigation(JSON.stringify(chains[0])), /version 1/);
  assert.throws(() => parseInvestigation(' '.repeat(MAX_IMPORT_BYTES + 1)), /smaller than 1 MB/);
  const envelope = exported();
  envelope.chain.id = 'CH-001';
  assert.throws(() => parseInvestigation(JSON.stringify(envelope)), /built-in/);
  envelope.chain.id = 'IMPORT-test';
  envelope.chain.events.push(envelope.chain.events[0]);
  assert.throws(() => parseInvestigation(JSON.stringify(envelope)), /Duplicate event/);
  envelope.chain.events.pop();
  envelope.chain.events[0].action.outcome = 'failed';
  assert.throws(() => parseInvestigation(JSON.stringify(envelope)), /completed/);
  envelope.chain.events[0].action.outcome = 'completed';
  envelope.chain.events[0].action.at = null;
  assert.throws(() => parseInvestigation(JSON.stringify(envelope)), /Action time/);
  envelope.chain.events = Array(201).fill(envelope.chain.events[1]);
  assert.throws(() => parseInvestigation(JSON.stringify(envelope)), /Events/);
});
