import assert from 'node:assert/strict';
import test from 'node:test';
import { assessEditTestAuthority, parseEditTestTime } from '../../src/edit-test-grants.mjs';

const edit = { action: 'file:write', resource: 'repo:sample/src/tally.js' };
const verify = { action: 'test:execute', resource: 'repo:sample/tests/tally.js' };
const instant = fraction => `2024-02-29T12:30:00.${fraction}+00:00`;

function records() {
  const root = { id: 'owner-grant', subject: 'coordinator', issuer: 'owner', principal: 'owner',
    parentGrantId: null, capabilities: [edit, verify], validFrom: instant('000100'), expiresAt: instant('000900'), canDelegate: true };
  const leaf = { ...root, id: 'quality-check', issuer: 'coordinator', subject: 'tester', parentGrantId: root.id,
    capabilities: [verify], canDelegate: false, validFrom: instant('000250'), expiresAt: instant('000750') };
  const editor = { ...leaf, id: 'file-edit', subject: 'author', capabilities: [edit] };
  const action = { ...verify, actor: 'tester', grantId: 'quality-check', startedAt: instant('000250'),
    completedAt: instant('000749'), eventId: 'checked' };
  return { root, leaf, editor, action };
}

function expectIssue(result, authority, code) {
  assert.equal(result.authority, authority);
  assert.ok(result.diagnostics.some(issue => issue.code === code), JSON.stringify(result.diagnostics));
}

test('the capture parser preserves UTC microseconds and rejects normalized dates and unsupported precision', () => {
  assert.equal(parseEditTestTime('1970-01-01T00:00:00Z'), 0n);
  assert.equal(parseEditTestTime('1969-12-31T23:59:59.999999+00:00'), -1n);
  assert.equal(parseEditTestTime(instant('000750')) - parseEditTestTime(instant('000749')), 1n);
  assert.equal(parseEditTestTime(instant('1')), parseEditTestTime('2024-02-29T12:30:00.100000Z'));
  for (const value of ['2025-02-29T00:00:00.000000Z', '2024-04-31T00:00:00Z', '2024-02-29T24:00:00Z',
    '2024-02-29T00:00:00.0000001Z', '2024-02-29T00:00:00', '2024-02-29T00:00:00-08:00', null]) {
    assert.equal(parseEditTestTime(value), null);
  }
});

test('both interval endpoints must fit inside the grant, down to one microsecond', () => {
  const { root, leaf, editor, action } = records();
  const grants = [editor, leaf, root];
  const assessed = assessEditTestAuthority(grants, action);
  assert.deepEqual(assessed, { grant: leaf, authority: 'within-scope', diagnostics: [] });
  for (const change of [{ startedAt: instant('000249') }, { completedAt: instant('000750') }]) {
    expectIssue(assessEditTestAuthority(grants, { ...action, ...change }), 'violation', 'ACTION_OUTSIDE_LIFETIME');
  }
  expectIssue(assessEditTestAuthority(grants, { ...action, completedAt: instant('000249'), startedAt: instant('000600') }),
    'violation', 'ACTION_OUTSIDE_LIFETIME');
  expectIssue(assessEditTestAuthority(grants, { ...action, completedAt: instant('000400'), startedAt: instant('000401') }),
    'unverifiable', 'INVALID_ACTION_WINDOW');
  const { completedAt, eventId, ...attempt } = action;
  assert.equal(assessEditTestAuthority(grants, attempt).authority, 'within-scope');
  expectIssue(assessEditTestAuthority(grants, { ...attempt, eventId }), 'unverifiable', 'INVALID_ACTION_WINDOW');
});

test('child scope and window must fit the parent even when the actual test fits both grants', () => {
  const { root, leaf, action } = records();
  const evaluate = child => assessEditTestAuthority([root, child], action);
  const crossPair = { action: edit.action, resource: verify.resource };
  expectIssue(evaluate({ ...leaf, capabilities: [verify, crossPair] }), 'violation', 'SCOPE_EXPANSION');
  expectIssue(evaluate({ ...leaf, validFrom: instant('000099') }), 'violation', 'LIFETIME_EXPANSION');
  expectIssue(evaluate({ ...leaf, expiresAt: instant('000901') }), 'violation', 'LIFETIME_EXPANSION');
  assert.equal(evaluate({ ...leaf, validFrom: root.validFrom, expiresAt: root.expiresAt }).authority, 'within-scope');
});

test('supplied grant, actor, principal, delegator and delegation permission are independently checked', () => {
  const { root, leaf, action } = records();
  expectIssue(assessEditTestAuthority([root], action), 'unverifiable', 'MISSING_VERIFIER_GRANT');
  expectIssue(assessEditTestAuthority([root], { ...action, ...edit }), 'unverifiable', 'MISSING_EDITOR_GRANT');
  expectIssue(assessEditTestAuthority([root, leaf], { ...action, resource: edit.resource }), 'violation', 'ACTION_OUTSIDE_SCOPE');
  expectIssue(assessEditTestAuthority([root, leaf], { ...action, actor: 'other' }), 'unverifiable', 'ACTOR_MISMATCH');
  expectIssue(assessEditTestAuthority([root, { ...leaf, issuer: 'other' }], action), 'unverifiable', 'DELEGATOR_MISMATCH');
  expectIssue(assessEditTestAuthority([root, { ...leaf, principal: 'other' }], action), 'unverifiable', 'DELEGATOR_MISMATCH');
  expectIssue(assessEditTestAuthority([{ ...root, issuer: 'other' }, leaf], action), 'unverifiable', 'ROOT_UNANCHORED');
  expectIssue(assessEditTestAuthority([{ ...root, canDelegate: false }, leaf], action), 'violation', 'DELEGATION_FORBIDDEN');
  expectIssue(assessEditTestAuthority([root, leaf], { ...action, grantId: root.id, actor: root.subject }),
    'unverifiable', 'STAGE_GRANT_NOT_DELEGATED');
  const mixed = assessEditTestAuthority([root, leaf], { ...action, actor: 'other', resource: edit.resource });
  expectIssue(mixed, 'violation', 'ACTION_OUTSIDE_SCOPE');
  expectIssue(mixed, 'violation', 'ACTOR_MISMATCH');
  const noAncestor = assessEditTestAuthority([leaf], { ...action, resource: edit.resource });
  expectIssue(noAncestor, 'violation', 'ACTION_OUTSIDE_SCOPE');
  expectIssue(noAncestor, 'violation', 'STAGE_GRANT_NOT_DELEGATED');
});

test('duplicate, cyclic, unanchored, multi-hop and unsupported grant records cannot clear a stage', () => {
  const { root, leaf, editor, action } = records();
  for (const [grants, code] of [
    [[root, leaf, leaf], 'DUPLICATE_GRANT_ID'],
    [[root, leaf, { ...editor, parentGrantId: null }], 'GRANT_ROOT_AMBIGUOUS'],
    [[root, { ...leaf, parentGrantId: leaf.id }], 'GRANT_PARENT_INVALID'],
    [[root, { ...leaf, parentGrantId: editor.id }, { ...editor, parentGrantId: leaf.id }], 'GRANT_PARENT_INVALID'],
    [[root, leaf, { ...editor, parentGrantId: leaf.id }], 'GRANT_PARENT_INVALID'],
    [[root, leaf, { ...editor, subject: leaf.subject }], 'GRANT_SUBJECT_AMBIGUOUS'],
    [[root, { ...leaf, parentGrantId: 'missing' }], 'GRANT_PARENT_INVALID'],
    [[root, { ...leaf, condition: 'unsupported' }], 'INVALID_GRANT'],
    [[root, { ...leaf, capabilities: [{ ...verify, condition: 'unsupported' }] }], 'INVALID_GRANT'],
    [[root, { ...leaf, capabilities: [{ ...verify, resource: '/fictional/private/output.log' }] }], 'INVALID_GRANT'],
    [[root, { ...leaf, capabilities: [{ ...verify, resource: 'repo:sample/../output.log' }] }], 'INVALID_GRANT'],
    [[root, { ...leaf, capabilities: [{ ...verify, action: 'arbitrary\noutput' }] }], 'INVALID_GRANT'],
    [[root, { ...leaf, validFrom: leaf.expiresAt }], 'INVALID_GRANT'],
    [[root, { ...leaf, capabilities: Array(101).fill(verify) }], 'INVALID_GRANT'],
    [[root, leaf, editor, editor], 'UNSUPPORTED_GRANT_LEDGER'],
  ]) expectIssue(assessEditTestAuthority(grants, action), 'unverifiable', code);
});
