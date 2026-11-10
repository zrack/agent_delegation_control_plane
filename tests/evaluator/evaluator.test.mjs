import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateChain, EVALUATION_LIMITS } from '../../src/evaluator.mjs';
import { chains } from '../../src/fixtures.mjs';
import { parseInvestigation, MAX_IMPORT_BYTES } from '../../src/import.mjs';

// Independent immutable contract fixture; not copied from the mutable demo module.
const pair = (action = 'read', resource = 'record:A') => ({ action, resource });
const base = () => ({
  id: 'test-chain', principal: { id: 'owner' }, rootGrantId: 'root',
  grants: [
    { id: 'root', parentGrantId: null, issuer: 'owner', subject: 'agent:one', principal: 'owner', capabilities: [pair(), pair('write', 'record:B')], canDelegate: true, validFrom: '2026-09-13T10:00:00Z', expiresAt: '2026-09-13T11:00:00Z' },
    { id: 'child', parentGrantId: 'root', issuer: 'agent:one', subject: 'agent:two', principal: 'owner', capabilities: [pair()], canDelegate: false, validFrom: '2026-09-13T10:01:00Z', expiresAt: '2026-09-13T10:30:00Z' },
  ],
  events: [
    { id: 'event:one', parentEventId: null, actor: 'agent:one', authorityId: 'root', action: { ...pair(), at: '2026-09-13T10:02:00Z' } },
    { id: 'event:two', parentEventId: 'event:one', actor: 'agent:two', authorityId: 'child', action: { ...pair(), at: '2026-09-13T10:03:00Z' } },
  ],
});
const has = (result, code, eventId, grantId) => result.findings.some(f => f.code === code && (!eventId || f.eventId === eventId) && (!grantId || f.grantId === grantId));

test('three demo scenarios have distinct outcomes and exact affected hops', () => {
  assert.equal(chains.length, 3);
  const result = id => evaluateChain(chains.find(c => c.id === id));
  assert.deepEqual(result('CH-001').events.map(e => e.status), ['valid', 'valid', 'valid']);
  assert.deepEqual(result('CH-002').events.map(e => e.status), ['valid', 'valid', 'violation']);
  assert.ok(has(result('CH-002'), 'SCOPE_EXPANSION', 'CH-002-e3', 'CH-002-g3'));
  assert.deepEqual(result('CH-003').events.map(e => e.status), ['valid', 'unknown', 'unknown']);
  assert.equal(result('CH-003').completeness, 'incomplete');
});
test('valid attenuation preserves identity, capabilities and action time', () => {
  const chain = base(); const copy = structuredClone(chain);
  assert.deepEqual(evaluateChain(chain), { status: 'valid', completeness: 'complete', findings: [], events: [{ id: 'event:one', status: 'valid' }, { id: 'event:two', status: 'valid' }] });
  assert.deepEqual(chain, copy, 'evaluation must not mutate evidence');
});
test('capabilities are pairs, not the Cartesian product of actions/resources', () => {
  const chain = base(); chain.grants[1].capabilities = [pair('write', 'record:A')];
  chain.events[1].action.action = 'write';
  const result = evaluateChain(chain);
  assert.equal(result.status, 'violation');
  assert.ok(has(result, 'SCOPE_EXPANSION', 'event:two', 'child'));
  assert.ok(has(result, 'ACTION_OUTSIDE_SCOPE', 'event:two', 'root'));
});
test('a middle grant expansion stays visible even when a leaf narrows again', () => {
  const chain = base(); chain.grants[1].capabilities.push(pair('delete')); chain.grants[1].canDelegate = true;
  chain.grants.push({ ...chain.grants[1], id: 'leaf', parentGrantId: 'child', issuer: 'agent:two', subject: 'agent:three', capabilities: [pair()], canDelegate: false });
  chain.events.push({ ...chain.events[1], id: 'event:three', parentEventId: 'event:two', actor: 'agent:three', authorityId: 'leaf' });
  assert.ok(has(evaluateChain(chain), 'SCOPE_EXPANSION', 'event:three', 'child'));
});
test('leaf action can violate a correctly narrowed grant', () => {
  const chain = base(); chain.events[1].action = { ...chain.events[1].action, ...pair('write', 'record:B') };
  const result = evaluateChain(chain);
  assert.ok(has(result, 'ACTION_OUTSIDE_SCOPE', 'event:two', 'child'));
  assert.ok(!has(result, 'SCOPE_EXPANSION'));
});
test('expiry is exclusive and start is inclusive', () => {
  const chain = base(); chain.events[1].action.at = chain.grants[1].expiresAt;
  assert.ok(has(evaluateChain(chain), 'ACTION_OUTSIDE_LIFETIME', 'event:two', 'child'));
  chain.events[1].action.at = '2026-09-13T10:29:59.999Z';
  assert.equal(evaluateChain(chain).status, 'valid');
  chain.events[0].action.at = chain.grants[0].validFrom;
  chain.events[1].action.at = chain.grants[1].validFrom;
  assert.equal(evaluateChain(chain).status, 'valid');
});
test('ancestor expiry and child lifetime expansion are both evaluated', () => {
  const chain = base(); chain.grants[0].expiresAt = '2026-09-13T10:04:00Z'; chain.events[1].action.at = '2026-09-13T10:05:00Z';
  const result = evaluateChain(chain);
  assert.ok(has(result, 'ACTION_OUTSIDE_LIFETIME', 'event:two', 'root'));
  assert.ok(has(result, 'LIFETIME_EXPANSION', 'event:two', 'child'));
});
test('a known scope violation survives an unrelated missing ancestor', () => {
  const chain = base(); chain.grants[0].parentGrantId = 'absent'; chain.events[1].action.action = 'delete';
  const result = evaluateChain(chain);
  assert.equal(result.status, 'violation'); assert.equal(result.completeness, 'incomplete');
  assert.ok(has(result, 'ACTION_OUTSIDE_SCOPE')); assert.ok(has(result, 'GRANT_MISSING'));
});
test('missing root, missing grant and missing required capability evidence are unknown', () => {
  for (const mutate of [c => c.grants.shift(), c => c.grants.pop(), c => delete c.grants[1].capabilities, c => delete c.grants[1].canDelegate]) {
    const chain = base(); mutate(chain);
    assert.equal(evaluateChain(chain).status, 'unknown');
  }
});
test('duplicate grants/events do not silently select one record', () => {
  for (const kind of ['grants', 'events']) {
    const chain = base(); chain[kind].push(structuredClone(chain[kind][1]));
    assert.equal(evaluateChain(chain).status, 'unknown');
  }
});
test('cycles terminate and are unverifiable', () => {
  for (const kind of ['grants', 'events']) {
    const chain = base();
    if (kind === 'grants') chain.grants[0].parentGrantId = 'child';
    else chain.events[0].parentEventId = 'event:two';
    const result = evaluateChain(chain);
    assert.equal(result.completeness, 'incomplete');
    assert.ok(has(result, kind === 'grants' ? 'GRANT_CYCLE' : 'EVENT_CYCLE'));
  }
});
test('issuer, principal and acting subject mismatches cannot appear valid', () => {
  for (const mutate of [c => c.grants[1].issuer = 'stranger', c => c.grants[1].principal = 'stranger', c => c.events[1].actor = 'stranger']) {
    const chain = base(); mutate(chain); assert.equal(evaluateChain(chain).status, 'unknown');
  }
});
test('cannot delegate when parent forbids delegation', () => {
  const chain = base(); chain.grants[0].canDelegate = false;
  assert.ok(has(evaluateChain(chain), 'DELEGATION_FORBIDDEN', 'event:two', 'child'));
});
test('empty capability lists deny; wildcards and prefixes have no special meaning', () => {
  for (const capabilities of [[], [pair('*')], [pair('read', 'record:')]]) {
    const chain = base(); chain.grants[1].capabilities = capabilities;
    assert.equal(evaluateChain(chain).status, 'violation');
  }
});
test('malformed and reversed intervals are unknown', () => {
  for (const value of [null, 'yesterday', '2026-09-13', '2026-09-13T12:00:00Z']) {
    const chain = base(); chain.grants[1].validFrom = value;
    assert.equal(evaluateChain(chain).status, 'unknown');
  }
});
test('broken event parent, reversed event time and unanchored roots are unknown', () => {
  for (const mutate of [c => c.events[1].parentEventId = 'absent', c => c.events[1].action.at = '2026-09-13T10:01:30Z', c => c.grants[0].issuer = 'stranger', c => c.grants[1].parentGrantId = null]) {
    const chain = base(); mutate(chain); assert.equal(evaluateChain(chain).status, 'unknown');
  }
});
test('input order does not substitute for explicit parent links', () => {
  const chain = base(); chain.events.reverse(); chain.grants.reverse();
  assert.equal(evaluateChain(chain).status, 'valid');
});
test('malformed chains return uncertainty rather than throwing', () => {
  for (const chain of [null, {}, [], { events: [] }, { ...base(), events: [null] }, { ...base(), grants: [null] }]) {
    assert.equal(evaluateChain(chain).status, 'unknown');
  }
});

test('impossible calendar dates are never normalized into valid evidence', () => {
  const chain = base();
  for (const grant of chain.grants) { grant.validFrom = '2026-02-01T10:00:00Z'; grant.expiresAt = '2026-03-03T10:00:00Z'; }
  for (const event of chain.events) event.action.at = '2026-02-30T10:03:00Z';
  assert.equal(evaluateChain(chain).status, 'unknown');
});
test('malformed time fields preserve independently provable scope violations', () => {
  for (const mutate of [c => delete c.grants[1].expiresAt, c => c.events[2].action.at = 'malformed']) {
    const chain = structuredClone(chains.find(c => c.id === 'CH-002')); mutate(chain);
    const result = evaluateChain(chain);
    assert.equal(result.status, 'violation'); assert.equal(result.completeness, 'incomplete');
    assert.ok(has(result, 'SCOPE_EXPANSION', 'CH-002-e3', 'CH-002-g3'));
    assert.ok(has(result, 'ACTION_OUTSIDE_SCOPE', 'CH-002-e3', 'CH-002-g2'));
  }
});
test('malformed action still permits inspection of grant attenuation', () => {
  const chain = structuredClone(chains.find(c => c.id === 'CH-002'));
  delete chain.events[2].action;
  const result = evaluateChain(chain);
  assert.equal(result.status, 'violation'); assert.equal(result.completeness, 'incomplete');
  assert.ok(has(result, 'SCOPE_EXPANSION'));
});

// Within the file/record limits: many events reuse long authority paths.
function workload({ count = 200, capabilities = [], denies = true } = {}) {
  const grants = Array.from({ length: count }, (_, i) => ({
    id: `g${i}`, parentGrantId: i ? `g${i - 1}` : null,
    issuer: i ? `a${i - 1}` : 'p', subject: `a${i}`, principal: 'p',
    capabilities, canDelegate: !denies,
    validFrom: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z',
  }));
  const events = Array.from({ length: count }, (_, i) => ({
    id: `e${i}`, parentEventId: i ? 'e0' : null,
    actor: i ? `a${count - 1}` : 'a0', authorityId: i ? `g${count - 1}` : 'g0',
    action: { action: 'read', resource: 'r', at: '2026-06-01T00:00:00Z', outcome: 'completed' },
  }));
  return { id: 'IMPORT-work', principal: { id: 'p' }, rootGrantId: 'g0', grants, events };
}
const limited = result => {
  assert.equal(result.completeness, 'incomplete');
  assert.ok(has(result, 'EVALUATION_LIMIT'));
  assert.ok(result.findings.length <= EVALUATION_LIMITS.findings + 1);
  assert.ok(result.events.every(event => event.status !== 'valid'), 'unassessed evidence cannot appear permitted');
};

test('accepted 200-by-200 import has bounded findings and preserves proven violations', { timeout: 2000 }, () => {
  const chain = workload();
  const json = JSON.stringify({ schemaVersion: 1, chain });
  assert.ok(Buffer.byteLength(json) < MAX_IMPORT_BYTES);
  const imported = parseInvestigation(json);
  const result = evaluateChain(imported);
  limited(result);
  assert.equal(result.status, 'violation');
  assert.ok(has(result, 'ACTION_OUTSIDE_SCOPE', 'e0', 'g0'));
  assert.equal(result.events.length, 200);
  assert.equal(result.findings.length, EVALUATION_LIMITS.findings + 1, 'finding budget is independently enforced');
  assert.deepEqual(evaluateChain(imported), result, 'limits are deterministic');
  assert.deepEqual(evaluateChain(chain), result, 'direct callers use the same enforcement boundary');
});

test('capability-heavy accepted imports exhaust work rather than expanding comparison cost', { timeout: 2000 }, () => {
  const capabilities = Array.from({ length: 100 }, (_, i) => ({ action: 'read', resource: i ? `r${i}` : 'r' }));
  const chain = workload({ capabilities, denies: false });
  const result = evaluateChain(parseInvestigation(JSON.stringify({ schemaVersion: 1, chain })));
  limited(result);
  assert.equal(result.status, 'unknown');
  assert.ok(result.findings.length < EVALUATION_LIMITS.findings, 'work budget is independent of finding budget');
});

test('work exhaustion preserves earlier violations and later ordinary calls still succeed', () => {
  const chain = workload({ capabilities: Array.from({ length: 100 }, (_, i) => pair('read', `r${i}`)), denies: false });
  const result = evaluateChain(chain);
  limited(result);
  assert.equal(result.status, 'violation');
  assert.ok(has(result, 'ACTION_OUTSIDE_SCOPE', 'e0', 'g0'));
  assert.equal(evaluateChain(base()).status, 'valid', 'budget is private to each call');
});

test('direct inputs cannot bypass work limits with oversized capabilities or record arrays', () => {
  const chain = base();
  chain.grants[0].capabilities = Array(EVALUATION_LIMITS.work + 1).fill(pair());
  limited(evaluateChain(chain));
  for (const field of ['events', 'grants']) {
    const oversized = base(); oversized[field] = Array(EVALUATION_LIMITS.records + 1).fill(oversized[field][0]);
    limited(evaluateChain(oversized));
  }
});

test('ordinary evidence results and input immutability remain unchanged after limiting another call', () => {
  const chain = workload(); const copy = structuredClone(chain);
  limited(evaluateChain(chain));
  assert.deepEqual(chain, copy);
  assert.deepEqual(chains.map(chain => evaluateChain(chain).status), ['violation', 'valid', 'unknown']);
});

test('direct field sizes and unused capability metadata cannot amplify serialized findings', () => {
  for (const mutate of [
    chain => chain.events[1].action.resource = 'x'.repeat(16 * 1024),
    chain => chain.grants[0].parentGrantId = 'x'.repeat(16 * 1024),
    chain => chain.grants[0].issuer = { nested: 'unsupported' },
  ]) {
    const chain = workload(); mutate(chain);
    const result = evaluateChain(chain);
    limited(result);
    assert.ok(JSON.stringify(result).length < 20_000, 'oversized direct input produces only bounded diagnostics');
  }
  const chain = base();
  chain.grants[1].capabilities = [{ ...pair(), unused: { large: 'x'.repeat(16 * 1024) } }];
  chain.events[1].action.action = 'delete';
  const result = evaluateChain(chain);
  assert.equal(result.status, 'violation');
  assert.ok(!JSON.stringify(result).includes('unused'), 'only compared action/resource fields enter findings');
});
