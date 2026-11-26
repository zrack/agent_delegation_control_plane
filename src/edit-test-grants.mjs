import { parseRecordedTime } from './evaluator.mjs';

// The capture records UTC microseconds. Keep the last three digits for comparisons
// across a grant boundary while using the evaluator's calendar validation.
export function parseEditTestTime(value) {
  if (typeof value !== 'string' || value.length > 32) return null;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/.exec(value);
  if (!match) return null;
  const wholeSecondMs = parseRecordedTime(match[1] + 'Z');
  if (!Number.isFinite(wholeSecondMs)) return null;
  return BigInt(wholeSecondMs) * 1000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(value);
export const isEditTestRepository = value => typeof value === 'string' && /^repo:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
export function isEditTestResource(value) {
  if (typeof value !== 'string' || value.length > 512) return false;
  const [repository, ...parts] = value.split('/');
  return isEditTestRepository(repository) && parts.length > 0
    && parts.every(part => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part));
}
const grantFile = 'grants.jsonl';
const diagnostic = (code, message, file = grantFile) => ({ code, file, message });
const grantFields = ['id', 'parentGrantId', 'issuer', 'subject', 'principal', 'capabilities', 'validFrom', 'expiresAt', 'canDelegate'];
const onlyFields = (row, fields) => object(row) && Object.keys(row).every(key => fields.includes(key));
const pairValid = pair => onlyFields(pair, ['action', 'resource']) && id(pair.action) && isEditTestResource(pair.resource);
const allows = (grant, pair) => grant.capabilities.some(cap => cap.action === pair.action && cap.resource === pair.resource);

function validGrant(grant) {
  if (!onlyFields(grant, grantFields) || !['id', 'issuer', 'subject', 'principal'].every(key => id(grant[key]))
      || !(grant.parentGrantId === null || id(grant.parentGrantId)) || typeof grant.canDelegate !== 'boolean'
      || !Array.isArray(grant.capabilities) || grant.capabilities.length > 100) return false;
  for (const pair of grant.capabilities) if (!pairValid(pair)) return false;
  const from = parseEditTestTime(grant.validFrom);
  const until = parseEditTestTime(grant.expiresAt);
  return from !== null && until !== null && from < until;
}

// This workflow has a single recorded root and at most two direct children.
// A missing child is diagnosed against its action, independently of row order.
export function validateEditTestGrants(rows) {
  if (!Array.isArray(rows) || rows.length > 3) {
    return [diagnostic('UNSUPPORTED_GRANT_LEDGER', 'The capture supports one root grant and two delegated roles.')];
  }
  for (const row of rows) {
    if (!validGrant(row)) {
      return [diagnostic('INVALID_GRANT', 'A grant contains unsupported or malformed fields, capabilities, or UTC validity bounds.')];
    }
  }
  if (new Set(rows.map(row => row.id)).size !== rows.length) {
    return [diagnostic('DUPLICATE_GRANT_ID', 'A repeated grant ID makes the referenced authority ambiguous.')];
  }
  const roots = rows.filter(row => row.parentGrantId === null);
  if (roots.length !== 1) {
    return [diagnostic('GRANT_ROOT_AMBIGUOUS', 'The ledger must identify one parentless root grant.')];
  }
  const root = roots[0];
  const issues = [];
  if (root.issuer !== root.principal) {
    issues.push(diagnostic('ROOT_UNANCHORED', 'The issuer of the root grant differs from its recorded principal.'));
  }
  if (rows.some(row => row !== root && row.parentGrantId !== root.id)) {
    issues.push(diagnostic('GRANT_PARENT_INVALID', 'A delegated grant does not point directly to the recorded root grant.'));
  }
  if (new Set(rows.map(row => row.subject)).size !== rows.length) {
    issues.push(diagnostic('GRANT_SUBJECT_AMBIGUOUS', 'The coordinator and the two delegated roles require distinct recorded subjects.'));
  }
  return issues;
}

export function assessEditTestAuthority(grants, action) {
  const diagnostics = validateEditTestGrants(grants);
  const result = { authority: 'unverifiable', grant: null, diagnostics };
  const completed = object(action) && ['completedAt', 'eventId', 'outcome'].some(key => Object.hasOwn(action, key));
  const file = completed ? 'actions.jsonl' : 'attempts.jsonl';
  if (!object(action) || !id(action.actor) || !id(action.grantId) || !isEditTestResource(action.resource)
      || !['file:write', 'test:execute'].includes(action.action)) {
    diagnostics.push(diagnostic('INVALID_AUTHORITY_REFERENCE', 'The recorded role, action, resource, or grant reference is unsupported.', file));
    return result;
  }
  if (!Array.isArray(grants) || grants.length > 3) return result;
  const stage = action.action === 'test:execute' ? 'verifier' : 'editor';
  const matches = grants.filter(row => row?.id === action.grantId);
  if (matches.length === 0) {
    diagnostics.push(diagnostic(stage === 'verifier' ? 'MISSING_VERIFIER_GRANT' : 'MISSING_EDITOR_GRANT',
      `The ${stage} references a grant with no supplied record.`));
    return result;
  }
  if (matches.length !== 1 || !validGrant(matches[0])) return result;
  const leaf = matches[0];
  result.grant = { ...leaf, capabilities: leaf.capabilities.map(({ action, resource }) => ({ action, resource })) };
  if (action.actor !== leaf.subject) {
    diagnostics.push(diagnostic('ACTOR_MISMATCH', `The ${stage} actor differs from the subject of its referenced grant.`, file));
  }
  let violation = false;
  function flag(code, message, source = grantFile) {
    violation = true;
    diagnostics.push(diagnostic(code, message, source));
  }
  const path = [leaf];
  const parents = grants.filter(row => row?.id === leaf.parentGrantId);
  if (parents.length === 1 && validGrant(parents[0]) && parents[0].parentGrantId === null) {
    const root = parents[0];
    path.push(root);
    if (leaf.issuer !== root.subject || leaf.principal !== root.principal) {
      diagnostics.push(diagnostic('DELEGATOR_MISMATCH', `The ${stage} grant does not preserve the issuer or principal established by its parent.`));
    }
    if (!root.canDelegate) flag('DELEGATION_FORBIDDEN', `The root forbids delegation to the ${stage}.`);
    if (leaf.capabilities.some(cap => !allows(root, cap))) {
      flag('SCOPE_EXPANSION', `The ${stage} grant adds a capability absent from the root grant.`);
    }
    if (parseEditTestTime(leaf.validFrom) < parseEditTestTime(root.validFrom)
        || parseEditTestTime(leaf.expiresAt) > parseEditTestTime(root.expiresAt)) {
      flag('LIFETIME_EXPANSION', `The ${stage} grant extends beyond the root grant's validity window.`);
    }
  } else {
    diagnostics.push(diagnostic('STAGE_GRANT_NOT_DELEGATED', `The ${stage} did not reference a direct child of a unique recorded root grant.`));
  }
  if (path.some(grant => !allows(grant, action))) {
    flag('ACTION_OUTSIDE_SCOPE', `The ${stage} action and resource pair falls outside a recorded grant.`, file);
  }
  const start = parseEditTestTime(action.startedAt);
  const end = completed ? parseEditTestTime(action.completedAt) : start;
  if (start === null || end === null || end < start) {
    diagnostics.push(diagnostic('INVALID_ACTION_WINDOW', `The ${stage} has missing, malformed, or reversed action times.`, file));
  }
  if (path.some(grant => [start, end].some(at => at !== null
    && (at < parseEditTestTime(grant.validFrom) || at >= parseEditTestTime(grant.expiresAt))))) {
    flag('ACTION_OUTSIDE_LIFETIME', `The ${stage} started or completed outside a recorded grant's validity window.`, file);
  }
  result.authority = violation ? 'violation' : diagnostics.length ? 'unverifiable' : 'within-scope';
  return result;
}
