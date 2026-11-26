// Navigation uses only fingerprint-matched snapshots attached to the selected review.
import { evaluateChain } from './evaluator.mjs';

const sides = { baseline: 'Baseline', candidate: 'Candidate', 'follow-up': 'Follow-up' };

export function reviewRun(item, original, followUp, side) {
  if (side === 'follow-up') return !followUp.incompatible && followUp.assessment?.states.candidate === 'matched'
    ? item.followUp?.candidate : undefined;
  if ((side === 'baseline' || side === 'candidate') && original.states?.[side] === 'matched') return item[side];
}

// Keep the action as the anchor when looking through its grant's ancestors.
export function actionGrants(run, eventId) {
  const events = run.events.filter(event => event.id === eventId);
  if (events.length !== 1) return { issue: events.length ? 'Ambiguous action' : 'Missing action', id: eventId, grants: [] };
  const event = events[0];
  const byId = new Map();
  for (const grant of run.grants) byId.set(grant.id, byId.has(grant.id) ? null : grant);
  const visited = new Set();
  const grants = [];
  let id = event.authorityId;
  while (id !== null) {
    if (visited.has(id)) return { event, grants, issue: 'Grant cycle at', id };
    const grant = byId.get(id);
    if (!grant) return { event, grants, issue: grant === null ? 'Ambiguous grant' : 'Missing grant', id };
    grants.push(grant);
    visited.add(id);
    id = grant.parentGrantId;
  }
  return { event, grants };
}

function route(item, side, event, finding, extra) {
  const params = new URLSearchParams({ item: item.id, side, event });
  if (finding) params.set('finding', finding);
  // A baseline link inside a follow-up finding belongs to that comparison too.
  if (side === 'follow-up' || finding === 'follow-up') params.set('capture', item.followUp.id);
  for (const [key, value] of Object.entries(extra ?? {})) params.set(key, value);
  return '#review?' + params;
}

export function actionLink(item, side, event, escape, finding) {
  const href = route(item, side, event.id, finding);
  return `<a data-grant-side="${side}" data-grant-event="${escape(event.id)}" href="${escape(href)}">${sides[side]} · ${escape(event.label)} · ${escape(event.id)}</a>`;
}

export function actionDirectory(item, runs, escape) {
  const groups = Object.entries(runs).filter(([, run]) => run).map(([side, run]) =>
    `<h4>${sides[side]} · <code>${escape(run.id)}</code></h4><ul>${run.events.map(event =>
      `<li>${actionLink(item, side, event, escape)}<span class="muted"> · ${escape(event.action.action)} · ${escape(event.action.resource)}</span></li>`).join('')}</ul>`);
  if (!groups.length) return '';
  return `<details class="review-differences" id="review-action-directory"><summary>Actions and supporting grants</summary>${groups.join('')}</details>`;
}

export function grantLookup(item, run, side, eventId, requestedGrant, escape, finding) {
  const back = `<a href="${escape('#review?' + new URLSearchParams({ item: item.id }))}">Return to case</a>`;
  const body = contents => `<section id="review-grant-lookup" aria-labelledby="grant-lookup-title">
    <h3 id="grant-lookup-title" tabindex="-1">Action and supporting grant</h3>${contents}</section>`;
  if (!run) return body(`<p>No matching run snapshot is available for this selection.</p>${back}`);
  const trace = actionGrants(run, eventId);
  const issue = trace.issue ? `<p class="import-error">${escape(trace.issue)} <code>${escape(trace.id)}</code></p>` : '';
  if (!trace.event) return body(issue + back);
  const event = trace.event;
  const id = requestedGrant ?? event.authorityId;
  const grant = trace.grants.find(record => record.id === id);
  const returnLabel = finding ? 'Back to grouped missing grant finding' : 'Return to this action';
  const returnLink = `<a href="${escape(route(item, side, event.id, finding, { view: 'actions' }))}">${returnLabel}</a>`;
  const field = (name, value) => `<dt>${name}</dt><dd><code>${escape(value)}</code></dd>`;
  const action = `<p><strong>${sides[side]} run</strong> · <code>${escape(run.id)}</code></p>
    <dl>${field('Action record', event.id)}${field('Actor', event.actor)}${field('For principal', run.principal.id)}
    ${field('Recorded action', event.action.action)}${field('Resource', event.action.resource)}
    ${field('Action time', event.action.at)}${field('Referenced grant', event.authorityId)}</dl>`;
  let details = '';
  if (grant) {
    const parent = grant.parentGrantId;
    const parentLink = parent === null ? '<p>This grant has no recorded parent.</p>' :
      `<p><a href="${escape(route(item, side, event.id, finding, { grant: parent }))}">Parent grant · ${escape(parent)}</a></p>`;
    const scope = grant.capabilities.map(pair => `<li><code>${escape(pair.action)}</code> · <code>${escape(pair.resource)}</code></li>`).join('');
    details = `<h4>Grant <code>${escape(grant.id)}</code></h4><dl>${field('Issuer', grant.issuer)}${field('Subject', grant.subject)}
      ${field('Principal', grant.principal)}${field('Valid from', grant.validFrom)}${field('Expires at', grant.expiresAt)}
      ${field('May delegate', grant.canDelegate ? 'Yes' : 'No')}</dl><h4>Granted actions and resources</h4>
      ${scope ? `<ul>${scope}</ul>` : '<p>No capabilities supplied.</p>'}${parentLink}`;
  } else if (trace.id !== id) {
    details = `<p class="import-error">Grant <code>${escape(id)}</code> is outside the recorded ancestry of this action.</p>`;
  }
  const findings = evaluateChain(run).findings.filter(finding => !finding.eventId || finding.eventId === event.id);
  const findingsList = findings.length ? '<h4>Evaluator findings for this action</h4><ul>' + findings.map(finding =>
    `<li>${escape(finding.code)} · ${escape(finding.message)}</li>`).join('') + '</ul>' : '';
  return body(action + details + issue + findingsList + returnLink);
}
