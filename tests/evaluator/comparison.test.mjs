import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canPinBaseline, checkRegression, compareRuns } from '../../src/comparison.mjs';
import { evaluateChain } from '../../src/evaluator.mjs';
import { chains } from '../../src/fixtures.mjs';
import { parseInvestigation } from '../../src/import.mjs';

const fixture = id => chains.find(chain => chain.id === id);
const compare = (before, after) => compareRuns(before, after, evaluateChain(before), evaluateChain(after));
const check = (before, after) => checkRegression(compare(before, after), evaluateChain(after));

function capture(id, fixtureId = 'CH-001') {
  const source = fixture(fixtureId);
  const chain = structuredClone(source);
  const renamed = value => value === null ? null : id + value.slice(source.id.length);
  chain.id = id;
  chain.rootGrantId = renamed(chain.rootGrantId);
  for (const grant of chain.grants) {
    grant.id = renamed(grant.id);
    grant.parentGrantId = renamed(grant.parentGrantId);
  }
  for (const event of chain.events) {
    event.id = renamed(event.id);
    event.parentEventId = renamed(event.parentEventId);
    event.authorityId = renamed(event.authorityId);
  }
  return parseInvestigation(JSON.stringify({ schemaVersion: 1, chain }));
}

test('fresh capture IDs, array order and shifted dates alone leave policy and actions unchanged', () => {
  const baseline = capture('RUN-BASE');
  const candidate = capture('RUN-NEXT');
  const later = value => new Date(Date.parse(value) + 86_400_000).toISOString();
  for (const grant of candidate.grants) {
    grant.validFrom = later(grant.validFrom);
    grant.expiresAt = later(grant.expiresAt);
  }
  for (const event of candidate.events) event.action.at = later(event.action.at);
  candidate.events.reverse();
  candidate.grants.reverse();
  assert.deepEqual(compare(baseline, candidate), { permissions: [], actions: [], evidence: [] });
});

test('scope changes use exact action and resource pairs and retain evidence for inspection', () => {
  const baseline = capture('RUN-BASE');
  const candidate = capture('RUN-NEXT');
  const previous = baseline.events[1];
  const next = candidate.events[1];
  const oldGrant = baseline.grants[1];
  const newGrant = candidate.grants[1];
  previous.evidence = { tool: 'read_account', callId: 'call-before', artifactSha256: 'a'.repeat(64) };
  next.evidence = { tool: 'read_account', callId: 'call-after' };
  next.action.resource = 'crm://accounts/cedar';
  newGrant.capabilities[0].resource = next.action.resource;
  newGrant.canDelegate = false;
  newGrant.expiresAt = '2026-09-13T10:45:00Z';
  const result = compare(baseline, candidate);
  const permission = result.permissions.find(row => row.before === oldGrant);
  assert.deepEqual(permission.changes.find(field => field.capabilities), {
    label: 'Capability changes', before: oldGrant.capabilities, after: newGrant.capabilities, capabilities: true, impact: 'regression',
  });
  assert.ok(permission.changes.some(field => field.label === 'Can delegate' && field.after === false));
  assert.ok(permission.changes.some(field => field.label === 'Validity duration' && field.after === '2700 s'));
  const action = result.actions.find(row => row.before === previous);
  assert.deepEqual(action.eventLinks, [previous.id, next.id]);
  assert.equal(action.changes[0].after, next.action.resource);
  const evidence = result.evidence.find(row => row.eventLinks?.[0] === previous.id);
  assert.ok(evidence.changes.some(field => field.label === 'Artifact hash' && field.before === 'a'.repeat(64) && field.after === undefined));
  assert.ok(evidence.changes.some(field => field.label === 'Tool call ID' && field.after === 'call-after'));
  assert.ok(evidence.after.findings.some(finding => finding.code === 'SCOPE_EXPANSION'));
});

test('missing grant records and assessment gaps stay visible', () => {
  const baseline = capture('RUN-BASE');
  const candidate = capture('RUN-NEXT', 'CH-003');
  const result = compare(baseline, candidate);
  assert.equal(result.actions.length, 0);
  assert.ok(result.permissions.some(row => row.before === baseline.grants[1] && row.after === null));
  const evidence = result.evidence.find(row => row.eventLinks?.[0] === baseline.events[1].id);
  assert.ok(evidence.changes.some(field => field.label === 'Referenced grant supplied' && field.after === false));
  assert.ok(evidence.changes.some(field => field.label === 'Action assessment' && field.after === 'Unverifiable'));
  assert.ok(result.evidence[0].changes.some(field => field.label === 'Evidence completeness' && field.after === 'incomplete'));
});

test('unmatched repeated actions are displayed separately, even if record order looks similar', () => {
  const baseline = capture('RUN-BASE');
  const candidate = capture('RUN-NEXT');
  for (const chain of [baseline, candidate]) {
    chain.events.push({ ...chain.events[1], id: `${chain.id}-e4`, parentEventId: chain.events[2].id });
  }
  const result = compare(baseline, candidate);
  assert.equal(result.actions.filter(row => row.before && !row.after).length, 2);
  assert.equal(result.actions.filter(row => row.after && !row.before).length, 2);
  assert.equal(check(baseline, candidate).status, 'review');
});

test('sandbox targets match only their own run execution and result artifact', () => {
  const baseline = capture('SANDBOX-111111111111');
  const candidate = capture('SANDBOX-222222222222');
  for (const chain of [baseline, candidate]) {
    const execution = `sandbox:${chain.id}`;
    for (const event of chain.events) event.action.resource = event === chain.events[0] ? execution : execution + ':results.json';
    for (const grant of chain.grants) {
      grant.capabilities = [execution, execution + ':results.json'].map(resource => ({ action: 'account:read', resource }));
    }
  }
  assert.deepEqual(compare(baseline, candidate), { permissions: [], actions: [], evidence: [] });
  candidate.events[1].action.resource = `sandbox:${baseline.id}:results.json`;
  assert.ok(compare(baseline, candidate).actions.some(row => row.changes.some(field => field.label === 'Resource')));
});

test('export and missing-grant examples yield regression and review respectively', () => {
  const baseline = fixture('CH-001');
  const exported = check(baseline, fixture('CH-002'));
  assert.equal(exported.status, 'regression');
  assert.equal(exported.reasons[0].eventId, 'CH-002-e3');
  const missing = check(baseline, fixture('CH-003'));
  assert.equal(missing.status, 'review');
  assert.equal(missing.reasons[0].eventId, 'CH-003-e2');
  assert.ok(!canPinBaseline(fixture('CH-003'), evaluateChain(fixture('CH-003'))));
});

test('new capability is a regression even when the candidate acted within its own scope', () => {
  const baseline = capture('RUN-BASE');
  const candidate = capture('RUN-NEXT');
  candidate.grants[0].capabilities.push({ action: 'account:export', resource: 'crm://accounts/northstar' });
  assert.equal(evaluateChain(candidate).status, 'valid');
  const verdict = check(baseline, candidate);
  assert.equal(verdict.status, 'regression');
  assert.equal(verdict.reasons[0].row.after, candidate.grants[0]);
});

test('new call IDs and valid artifact hashes pass while missing or invalid required evidence needs review', () => {
  const baseline = capture('RUN-BASE');
  const candidate = capture('RUN-NEXT');
  baseline.events[1].evidence = { callId: 'call-before', artifactSha256: 'a'.repeat(64) };
  candidate.events[1].evidence = { callId: 'call-after', artifactSha256: 'b'.repeat(64) };
  assert.ok(canPinBaseline(baseline, evaluateChain(baseline)));
  assert.equal(check(baseline, candidate).status, 'pass');
  delete candidate.events[1].evidence.artifactSha256;
  assert.equal(check(baseline, candidate).status, 'review');
  candidate.events[1].evidence.artifactSha256 = 'malformed';
  assert.equal(check(baseline, candidate).status, 'review');
  assert.ok(!canPinBaseline(candidate, evaluateChain(candidate)));
});
