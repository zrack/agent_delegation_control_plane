// Conclusions concern supplied records only. This is not an enforcement engine.
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const instant = value => {
  if (!nonempty(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return NaN;
  const canonical = value.includes('.') ? value.replace(/\.(\d{1,3})Z$/, (_, fraction) => `.${fraction.padEnd(3, '0')}Z`) : value.replace('Z', '.000Z');
  return new Date(parsed).toISOString() === canonical ? parsed : NaN;
};
const pairValid = pair => object(pair) && nonempty(pair.action) && nonempty(pair.resource);
const windowValid = grant => Number.isFinite(instant(grant.validFrom)) && Number.isFinite(instant(grant.expiresAt))
  && instant(grant.validFrom) < instant(grant.expiresAt);
const statusFor = findings => findings.some(f => f.severity === 'violation') ? 'violation'
  : findings.some(f => f.severity === 'unknown') ? 'unknown' : 'valid';

// Shared by browser imports and direct/offline callers. These are work units,
// not elapsed time; limits must never turn unassessed evidence into permission.
export const EVALUATION_LIMITS = Object.freeze({ records: 200, work: 50_000, findings: 1_000 });

export function evaluateChain(chain) {
  const findings = [];
  const findingKeys = new Map();
  const limitReached = Symbol('evaluation limit');
  let remaining = EVALUATION_LIMITS.work;
  let safeEvents = [];
  const spend = (units = 1) => {
    if (units > remaining) throw limitReached;
    remaining -= units;
  };
  const capsValid = value => {
    if (!Array.isArray(value)) return false;
    spend(value.length);
    return value.every(pairValid);
  };
  const allows = (capabilities, action) => {
    spend(capabilities.length);
    return capabilities.some(pair => pair.action === action.action && pair.resource === action.resource);
  };
  const add = (severity, code, message, eventId = null, grantId = null, compared = {}) => {
    // Nested keys preserve exact identity without coercion or delimiter collisions.
    const byEvent = findingKeys.get(code) ?? new Map();
    const byGrant = byEvent.get(eventId) ?? new Set();
    if (byGrant.has(grantId)) return;
    if (findings.length >= EVALUATION_LIMITS.findings) throw limitReached;
    byGrant.add(grantId);
    byEvent.set(eventId, byGrant);
    findingKeys.set(code, byEvent);
    findings.push({ severity, code, message, eventId, grantId, compared });
  };
  const finish = events => ({
    status: statusFor(findings),
    completeness: findings.some(f => f.severity === 'unknown') ? 'incomplete' : 'complete',
    findings,
    events: events.map(event => ({ id: event.id, status: statusFor(findings.filter(f => !f.eventId || f.eventId === event.id)) })),
  });
  try {
    if (!object(chain) || !Array.isArray(chain.events) || !chain.events.length || !Array.isArray(chain.grants)
        || !object(chain.principal) || !nonempty(chain.principal.id) || !nonempty(chain.rootGrantId)) {
      add('unknown', 'CHAIN_INVALID', 'The chain is missing required principal, event, or authority evidence.');
      return finish([]);
    }
    const events = chain.events;
    const grants = chain.grants;
    if (events.length > EVALUATION_LIMITS.records || grants.length > EVALUATION_LIMITS.records) throw limitReached;
    safeEvents = events.filter(event => object(event) && typeof event.id === 'string' && event.id.length <= 160 && nonempty(event.id));
    // Direct callers do not pass through import normalization. Bound fields that
    // flow into findings before repeating them, without reinterpreting evidence.
    const scalarFits = (value, max) => value == null || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= max);
    const fieldsFit = (record, limits) => !object(record)
      || Object.entries(limits).every(([key, max]) => scalarFits(record[key], max));
    const pairLimits = { action: 200, resource: 1000 };
    if (!scalarFits(chain.rootGrantId, 160) || !scalarFits(chain.principal.id, 160)
        || !events.every(event => fieldsFit(event, { id: 160, parentEventId: 160, actor: 160, authorityId: 160 })
          && fieldsFit(event?.action, { ...pairLimits, at: 100 }))
        || !grants.every(grant => fieldsFit(grant, { id: 160, parentGrantId: 160, issuer: 160, subject: 160,
          principal: 160, validFrom: 100, expiresAt: 100 })
          && (!Array.isArray(grant?.capabilities) || (grant.capabilities.length <= 100
            && grant.capabilities.every(pair => fieldsFit(pair, pairLimits)))))) throw limitReached;
    const comparedPairs = capabilities => capabilities.map(({ action, resource }) => ({ action, resource }));
    const index = (items, label) => {
      const map = new Map();
      for (const item of items) {
        spend();
        if (!object(item) || !nonempty(item.id)) {
          add('unknown', `${label}_INVALID`, `A ${label.toLowerCase()} record has no usable identifier.`);
        } else if (map.has(item.id)) {
          add('unknown', `${label}_DUPLICATE`, `Duplicate ${label.toLowerCase()} ID ${item.id}; its evidence is ambiguous.`);
          map.set(item.id, null);
        } else map.set(item.id, item);
      }
      return map;
    };
    const grantMap = index(grants, 'GRANT');
    const eventMap = index(events, 'EVENT');
    if (!grantMap.get(chain.rootGrantId)) add('unknown', 'ROOT_MISSING', `Root authority ${chain.rootGrantId} is missing or ambiguous.`);
    if (safeEvents.filter(event => event.parentEventId === null).length !== 1) {
      add('unknown', 'EVENT_ROOT_AMBIGUOUS', 'A completed example must have exactly one root event.');
    }
    const grantValid = grant => object(grant) && ['id', 'issuer', 'subject', 'principal'].every(key => nonempty(grant[key]))
      && (grant.parentGrantId === null || nonempty(grant.parentGrantId)) && typeof grant.canDelegate === 'boolean'
      && capsValid(grant.capabilities) && windowValid(grant);

    for (const event of safeEvents) {
      spend();
      const eventId = event.id;
      const action = event.action;
      if (!nonempty(event.actor) || !nonempty(event.authorityId) || !pairValid(action) || !Number.isFinite(instant(action?.at))
          || (event.parentEventId !== null && !nonempty(event.parentEventId))) {
        add('unknown', 'EVENT_INVALID', 'Required actor, action, resource, time, or parent evidence is malformed.', eventId);
        // A missing time must not suppress a separately established scope violation.
        if (!nonempty(event.authorityId)) continue;
      }
      // Trace log ancestry independently: array position is never evidence of a parent.
      const seenEvents = new Set([eventId]);
      let parentId = event.parentEventId;
      while (parentId !== null) {
        spend();
        if (seenEvents.has(parentId)) {
          add('unknown', 'EVENT_CYCLE', 'Event parent links contain a cycle.', eventId);
          break;
        }
        seenEvents.add(parentId);
        const parent = eventMap.get(parentId);
        if (!parent) {
          add('unknown', 'EVENT_PARENT_MISSING', `Parent event ${parentId} is missing or ambiguous.`, eventId);
          break;
        }
        parentId = parent.parentEventId;
      }
      const leaf = grantMap.get(event.authorityId);
      if (leaf && leaf.subject !== event.actor) {
        add('unknown', 'ACTOR_MISMATCH', 'The recorded actor does not match the authority subject.', eventId, leaf.id,
          { actor: event.actor, subject: leaf.subject });
      }
      if (event.parentEventId === null && event.authorityId !== chain.rootGrantId) {
        add('unknown', 'ROOT_EVENT_MISMATCH', 'The first event is not bound to the declared root authority.', eventId);
      }
      const parentEvent = eventMap.get(event.parentEventId);
      if (parentEvent && leaf && leaf.parentGrantId !== parentEvent.authorityId) {
        add('unknown', 'EVENT_GRANT_DISCONNECTED', 'Event ancestry does not agree with authority ancestry.', eventId, leaf.id);
      }
      if (parentEvent && Number.isFinite(instant(parentEvent.action?.at)) && instant(parentEvent.action.at) > instant(action?.at)) {
        add('unknown', 'EVENT_TIME_ORDER', 'This event occurs before its recorded parent event.', eventId);
      }
      const seenGrants = new Set();
      let grantId = event.authorityId;
      while (grantId !== null) {
        spend();
        if (seenGrants.has(grantId)) {
          add('unknown', 'GRANT_CYCLE', 'Authority parent links contain a cycle.', eventId, grantId);
          break;
        }
        seenGrants.add(grantId);
        const grant = grantMap.get(grantId);
        if (!grant) {
          add('unknown', 'GRANT_MISSING', `Authority record ${grantId} is missing or ambiguous.`, eventId, grantId,
            { missingGrantId: grantId, reason: 'No unique supplied authority record' });
          break;
        }
        if (!grantValid(grant)) {
          add('unknown', 'GRANT_INVALID', `Authority ${grantId} has malformed or missing fields.`, eventId, grantId);
        }
        if (grant.principal !== chain.principal.id) {
          add('unknown', 'PRINCIPAL_MISMATCH', 'Authority changes the principal without supporting evidence.', eventId, grantId);
        }
        if (capsValid(grant.capabilities) && pairValid(action) && !allows(grant.capabilities, action)) {
          add('violation', 'ACTION_OUTSIDE_SCOPE', `${action.action} on ${action.resource} exceeds authority ${grant.id}.`, eventId, grant.id,
            { requested: { action: action.action, resource: action.resource }, allowed: comparedPairs(grant.capabilities) });
        }
        if (windowValid(grant) && Number.isFinite(instant(action?.at))
            && (instant(action.at) < instant(grant.validFrom) || instant(action.at) >= instant(grant.expiresAt))) {
          add('violation', 'ACTION_OUTSIDE_LIFETIME', `The action occurred outside authority ${grant.id}'s validity window.`, eventId, grant.id,
            { at: action.at, validFrom: grant.validFrom, expiresAt: grant.expiresAt });
        }
        if (grant.parentGrantId === null) {
          if (grant.id !== chain.rootGrantId || grant.issuer !== chain.principal.id) {
            add('unknown', 'ROOT_UNANCHORED', 'The authority path does not end at the declared principal/root grant.', eventId, grant.id);
          }
          break;
        }
        if (grant.id === chain.rootGrantId) {
          add('unknown', 'ROOT_HAS_PARENT', 'The declared root authority unexpectedly has a parent.', eventId, grant.id);
        }
        const parent = grantMap.get(grant.parentGrantId);
        if (parent) {
          if (grant.issuer !== parent.subject || grant.principal !== parent.principal) {
            add('unknown', 'DELEGATOR_MISMATCH', 'The grant issuer/principal does not match the parent authority.', eventId, grant.id,
              { issuer: grant.issuer, expectedIssuer: parent.subject, parentGrantId: parent.id });
          }
          if (parent.canDelegate === false) {
            add('violation', 'DELEGATION_FORBIDDEN', `Authority ${parent.id} does not permit further delegation.`, eventId, grant.id,
              { parentGrantId: parent.id, canDelegate: parent.canDelegate });
          }
          const expansion = capsValid(grant.capabilities) && capsValid(parent.capabilities)
            ? grant.capabilities.filter(pair => !allows(parent.capabilities, pair)) : [];
          if (expansion.length) {
            add('violation', 'SCOPE_EXPANSION', `Authority ${grant.id} adds a capability its parent ${parent.id} never granted.`, eventId, grant.id,
              { parentGrantId: parent.id, requested: comparedPairs(expansion), allowed: comparedPairs(parent.capabilities) });
          }
          if (windowValid(grant) && windowValid(parent)
              && (instant(grant.validFrom) < instant(parent.validFrom) || instant(grant.expiresAt) > instant(parent.expiresAt))) {
            add('violation', 'LIFETIME_EXPANSION', `Authority ${grant.id} extends beyond its parent's validity window.`, eventId, grant.id,
              { parentGrantId: parent.id, child: [grant.validFrom, grant.expiresAt], parent: [parent.validFrom, parent.expiresAt] });
          }
        }
        if (!nonempty(grant.parentGrantId)) break;
        grantId = grant.parentGrantId;
      }
    }
    return finish(safeEvents);
  } catch (error) {
    if (error !== limitReached) throw error;
    // Reserved extra slot: retained violations win, every other event is unknown.
    findings.push({ severity: 'unknown', code: 'EVALUATION_LIMIT', eventId: null, grantId: null,
      message: 'Evaluation stopped at a work, finding or input-size limit. Retained violations remain established; remaining evidence is unassessed.',
      compared: { limits: EVALUATION_LIMITS } });
    return finish(safeEvents);
  }
}

export const statusLabels = Object.freeze({ valid: 'Within scope', violation: 'Violation', unknown: 'Unverifiable' });
export { instant as parseRecordedTime };
