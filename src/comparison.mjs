// Compare normalized run records. The evaluator remains the source of each run's assessment.
import { parseRecordedTime, statusLabels } from './evaluator.mjs';

function uniqueBy(records, key) {
  const index = new Map();
  for (const record of records) {
    const value = key(record);
    index.set(value, index.has(value) ? null : record);
  }
  return index;
}

function align(before, after, keys) {
  const matched = new Map();
  const used = new Set();
  for (const key of keys) {
    const left = uniqueBy(before.filter(record => !matched.has(record)), record => key(record, 0));
    const right = uniqueBy(after.filter(record => !used.has(record)), record => key(record, 1));
    for (const [value, baseline] of left) {
      const candidate = right.get(value);
      if (!baseline || !candidate) continue;
      matched.set(baseline, candidate);
      used.add(candidate);
    }
  }
  return [
    ...before.map(record => [record, matched.get(record) ?? null]),
    ...after.filter(record => !used.has(record)).map(record => [null, record]),
  ];
}

// Only the pilot's two known run-local targets have equivalent roles across runs.
function resourceKey(resource, chain) {
  if (/^SANDBOX-[a-f0-9]{12}$/.test(chain.id)) {
    if (resource === `sandbox:${chain.id}`) return ['sandbox execution'];
    if (resource === `sandbox:${chain.id}:results.json`) return ['sandbox result'];
  }
  return ['literal', resource];
}

const pairKey = (pair, chain) => JSON.stringify([pair.action, resourceKey(pair.resource, chain)]);

function referenceMap(pairs) {
  return new Map(pairs.filter(([left, right]) => left && right).map(([left, right]) => [left.id, right.id]));
}

function sameReference(left, right, matches) {
  return (matches.get(left) ?? left) === right;
}

function change(changes, label, before, after, equivalent = before === after, impact) {
  if (!equivalent) changes.push(impact ? { label, before, after, impact } : { label, before, after });
}

const review = 'review';
const regression = 'regression';
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);

export const regressionLabels = Object.freeze({
  pass: 'No regression found',
  regression: 'Regression detected',
  review: 'Needs review',
});

export function canPinBaseline(chain, result) {
  return result.status === 'valid' && result.completeness === 'complete'
    && chain.events.every(event => event.evidence?.artifactSha256 === undefined || validHash(event.evidence.artifactSha256));
}

function windowDuration(grant) {
  const duration = parseRecordedTime(grant.expiresAt) - parseRecordedTime(grant.validFrom);
  return duration > 0 ? duration : null;
}

function findingIndex(result) {
  const index = new Map();
  for (const finding of result.findings) {
    const list = index.get(finding.eventId) ?? [];
    list.push(finding);
    index.set(finding.eventId, list);
  }
  return index;
}

function findingCounts(findings) {
  const counts = new Map();
  for (const finding of findings) counts.set(finding.code, (counts.get(finding.code) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b));
}

function findingChange(changes, before, after) {
  const left = findingCounts(before);
  const right = findingCounts(after);
  const format = counts => counts.map(([code, count]) => `${code.replaceAll('_', ' ')} × ${count}`);
  change(changes, 'Finding codes', format(left), format(right), JSON.stringify(left) === JSON.stringify(right));
}

export function compareRuns(baseline, candidate, baselineResult, candidateResult) {
  const byId = record => record.id;
  const events = align(baseline.events, candidate.events, [
    byId, (event, side) => JSON.stringify([event.actor, pairKey(event.action, side === 0 ? baseline : candidate)]), event => event.actor,
  ]);
  const grants = align(baseline.grants, candidate.grants, [
    byId, grant => JSON.stringify([grant.subject, grant.issuer, grant.principal]), grant => grant.subject,
  ]);
  const eventMatches = referenceMap(events);
  const grantMatches = referenceMap(grants);
  const leftGrants = new Set(baseline.grants.map(byId));
  const rightGrants = new Set(candidate.grants.map(byId));
  const leftFindings = findingIndex(baselineResult);
  const rightFindings = findingIndex(candidateResult);
  const leftStatus = new Map(baselineResult.events.map(item => [item.id, item.status]));
  const rightStatus = new Map(candidateResult.events.map(item => [item.id, item.status]));
  const groups = { permissions: [], actions: [], evidence: [] };

  const permissionContext = [];
  change(permissionContext, 'Principal ID', baseline.principal.id, candidate.principal.id, undefined, review);
  change(permissionContext, 'Root grant', baseline.rootGrantId, candidate.rootGrantId,
    sameReference(baseline.rootGrantId, candidate.rootGrantId, grantMatches), review);
  if (permissionContext.length) {
    groups.permissions.push({ title: 'Run authority', changes: permissionContext,
      before: { principal: baseline.principal, rootGrantId: baseline.rootGrantId },
      after: { principal: candidate.principal, rootGrantId: candidate.rootGrantId } });
  }

  for (const [before, after] of grants) {
    const title = `Grant for ${after?.subject ?? before.subject}`;
    if (!before || !after) {
      groups.permissions.push({ title, before, after, changes: [] });
      continue;
    }
    const changes = [];
    for (const field of ['subject', 'issuer', 'principal']) {
      change(changes, field[0].toUpperCase() + field.slice(1), before[field], after[field], undefined, review);
    }
    change(changes, 'Can delegate', before.canDelegate, after.canDelegate, undefined, after.canDelegate ? regression : undefined);
    change(changes, 'Parent grant', before.parentGrantId, after.parentGrantId,
      sameReference(before.parentGrantId, after.parentGrantId, grantMatches), review);
    const previousDuration = windowDuration(before);
    const nextDuration = windowDuration(after);
    if (previousDuration !== null && nextDuration !== null) {
      change(changes, 'Validity duration', `${previousDuration / 1000} s`, `${nextDuration / 1000} s`,
        undefined, nextDuration > previousDuration ? regression : undefined);
    } else {
      change(changes, 'Validity window (unverifiable)', [before.validFrom, before.expiresAt],
        [after.validFrom, after.expiresAt], before.validFrom === after.validFrom && before.expiresAt === after.expiresAt, review);
    }
    const previousPairs = new Map(before.capabilities.map(pair => [pairKey(pair, baseline), pair]));
    const nextPairs = new Map(after.capabilities.map(pair => [pairKey(pair, candidate), pair]));
    const removed = [...previousPairs].filter(([key]) => !nextPairs.has(key)).map(([, pair]) => pair);
    const added = [...nextPairs].filter(([key]) => !previousPairs.has(key)).map(([, pair]) => pair);
    if (removed.length || added.length) {
      const field = { label: 'Capability changes', before: removed, after: added, capabilities: true };
      if (added.length) field.impact = regression;
      changes.push(field);
    }
    if (changes.length) groups.permissions.push({ title, before, after, changes });
  }

  for (const [before, after] of events) {
    const title = after?.label ?? before.label;
    const eventLinks = [before?.id, after?.id];
    if (!before || !after) {
      groups.actions.push({ title, before, after, changes: [], eventLinks });
      continue;
    }
    const actionChanges = [];
    change(actionChanges, 'Actor', before.actor, after.actor, undefined, review);
    change(actionChanges, 'Action', before.action.action, after.action.action, undefined, regression);
    change(actionChanges, 'Resource', before.action.resource, after.action.resource,
      JSON.stringify(resourceKey(before.action.resource, baseline)) === JSON.stringify(resourceKey(after.action.resource, candidate)), regression);
    change(actionChanges, 'Outcome', before.action.outcome, after.action.outcome, undefined, review);
    change(actionChanges, 'Parent action', before.parentEventId, after.parentEventId,
      sameReference(before.parentEventId, after.parentEventId, eventMatches), review);
    if (actionChanges.length) groups.actions.push({ title, before, after, changes: actionChanges, eventLinks });

    const evidenceChanges = [];
    for (const [field, label] of [['tool', 'Tool'], ['callId', 'Tool call ID'], ['artifactSha256', 'Artifact hash']]) {
      const previous = before.evidence?.[field];
      const next = after.evidence?.[field];
      const requiresReview = (previous !== undefined && next === undefined)
        || (field === 'artifactSha256' && next !== undefined && !validHash(next))
        || (field === 'tool' && previous !== undefined);
      change(evidenceChanges, label, previous, next, undefined, requiresReview ? review : undefined);
    }
    change(evidenceChanges, 'Authority reference', before.authorityId, after.authorityId,
      sameReference(before.authorityId, after.authorityId, grantMatches), review);
    change(evidenceChanges, 'Referenced grant supplied', leftGrants.has(before.authorityId), rightGrants.has(after.authorityId), undefined, review);
    change(evidenceChanges, 'Action assessment', statusLabels[leftStatus.get(before.id)], statusLabels[rightStatus.get(after.id)]);
    const baselineFindings = leftFindings.get(before.id) ?? [];
    const candidateFindings = rightFindings.get(after.id) ?? [];
    findingChange(evidenceChanges, baselineFindings, candidateFindings);
    if (evidenceChanges.length) groups.evidence.push({ title, changes: evidenceChanges, eventLinks,
      before: { event: before, findings: baselineFindings.map(({ compared, ...finding }) => finding) },
      after: { event: after, findings: candidateFindings.map(({ compared, ...finding }) => finding) } });
  }

  const runEvidence = [];
  change(runEvidence, 'Source claim', baseline.source, candidate.source, undefined, review);
  change(runEvidence, 'Run assessment', statusLabels[baselineResult.status], statusLabels[candidateResult.status]);
  change(runEvidence, 'Evidence completeness', baselineResult.completeness, candidateResult.completeness);
  const baselineFindings = leftFindings.get(null) ?? [];
  const candidateFindings = rightFindings.get(null) ?? [];
  findingChange(runEvidence, baselineFindings, candidateFindings);
  if (runEvidence.length) {
    const context = (chain, result, findings) => ({ source: chain.source, assessment: statusLabels[result.status],
      completeness: result.completeness, findings: findings.map(({ compared, ...finding }) => finding) });
    groups.evidence.unshift({ title: 'Run assessment and source', changes: runEvidence,
      before: context(baseline, baselineResult, baselineFindings),
      after: context(candidate, candidateResult, candidateFindings) });
  }
  return groups;
}

export function checkRegression(groups, candidateResult) {
  const reasons = [];
  if (candidateResult.status === 'violation') {
    reasons.push({ impact: regression, message: 'The candidate recorded an authority violation.',
      eventId: candidateResult.events.find(event => event.status === 'violation')?.id });
  }
  if (candidateResult.completeness !== 'complete' || candidateResult.status === 'unknown') {
    reasons.push({ impact: review, message: 'The candidate has incomplete or unverifiable authority evidence.',
      eventId: candidateResult.events.find(event => event.status === 'unknown')?.id });
  }
  for (const rows of Object.values(groups)) {
    for (const row of rows) {
      if (!row.before || !row.after) {
        reasons.push({ impact: review, message: 'No unique counterpart in the other run.', row });
        continue;
      }
      for (const impact of [regression, review]) {
        const fields = row.changes.filter(field => field.impact === impact).map(field =>
          field.after === undefined ? `${field.label} missing from candidate` : field.label);
        if (fields.length) reasons.push({ impact, message: fields.join(' · '), row });
      }
    }
  }
  const regressions = reasons.filter(reason => reason.impact === regression);
  const reviews = reasons.filter(reason => reason.impact === review);
  const status = regressions.length ? regression : reviews.length ? review : 'pass';
  return { status, reasons: [...regressions, ...reviews] };
}
