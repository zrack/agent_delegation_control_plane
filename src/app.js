import { chains as examples } from './fixtures.mjs';
import { evaluateChain, statusLabels } from './evaluator.mjs';
import { MAX_IMPORT_BYTES, parseInvestigation, mergeInvestigation } from './import.mjs';
import {
  restoreInvestigations, saveInvestigation, clearInvestigations, restoreWorkflowBaselines,
  saveWorkflowBaseline, removeWorkflowBaseline, workflowKey, runFingerprint,
} from './storage.mjs';
import { canPinBaseline, checkRegression, compareRuns, regressionLabels } from './comparison.mjs';
import { createReviewInbox, reviewRoute } from './review-view.mjs';

const getStorage = () => window.localStorage;
const restored = restoreInvestigations(getStorage);
let chains = [...examples, ...restored.chains];

const escape = value => String(value ?? 'Unknown').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const results = new Map(chains.map(chain => [chain.id, evaluateChain(chain)]));
const importStatus = document.querySelector('#import-status');
importStatus.textContent = restored.warning || (restored.chains.length ? `Restored ${restored.chains.length} locally saved run(s). Source claims remain unverified.` : '');
importStatus.classList.toggle('import-error', Boolean(restored.warning));
const icon = status => ({ valid: '✓', violation: '!', unknown: '?' })[status];
const badge = status => `<span class="badge ${status}"><span aria-hidden="true">${icon(status)}</span>${statusLabels[status]}</span>`;
const time = at => typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(at) ? `${at.slice(11, 19)} UTC` : 'Time unverifiable';
const pairs = values => values.map(pair => `<span class="capability"><code>${escape(pair.action)}</code><span>${escape(pair.resource)}</span></span>`).join('');
let selectedChain;
let selectedEvent;
let findingEvidence = [];
const comparison = document.querySelector('#comparison');
const compareStatus = document.querySelector('#compare-status');
const compareResults = document.querySelector('#compare-results');
const baselineSelect = document.querySelector('#baseline-run');
const candidateSelect = document.querySelector('#candidate-run');
const workflowSelect = document.querySelector('#saved-workflow');
const workflowName = document.querySelector('#workflow-name');
const workflowStatus = document.querySelector('#workflow-status');
const saveBaselineButton = document.querySelector('#save-workflow-baseline');
const removeBaselineButton = document.querySelector('#remove-workflow-baseline');
const investigateLink = document.querySelector('#investigate-link');
const compareLink = document.querySelector('#compare-link');
const reviewLink = document.querySelector('#review-link');
const reviewInbox = document.querySelector('#review-inbox');
const reviewView = createReviewInbox({ getStorage, escape, comparisonDetail });
const compareRoute = '#compare?';
let comparisonRows = [];
let comparisonPair = [];
let workflows = [];
let comparisonRevision = 0;

function comparisonHash(baseline, candidate, workflow = '') {
  const params = new URLSearchParams({ baseline, candidate });
  if (workflow) params.set('workflow', workflow);
  return compareRoute + params;
}

function updateSaveLabel() {
  saveBaselineButton.textContent = workflows.some(profile => workflowKey(profile.name) === workflowKey(workflowName.value))
    ? 'Replace baseline' : 'Save baseline';
}

function regressionNotice(status, message) {
  const tone = { pass: 'valid', review: 'unknown', regression: 'violation' }[status];
  return `<section class="assessment regression-verdict ${tone}" aria-label="Regression verdict">
    <div><h3>${regressionLabels[status]}</h3><p>${escape(message)}</p></div></section>`;
}

function renderComparison(preserveDraft = false) {
  const revision = ++comparisonRevision;
  updateClearButton();
  const params = new URLSearchParams(location.hash.slice(compareRoute.length));
  const saved = restoreWorkflowBaselines(getStorage);
  workflows = saved.baselines;
  if (saved.warning) workflowStatus.textContent = saved.warning;
  const key = params.get('workflow');
  const profile = workflows.find(item => workflowKey(item.name) === key);
  workflowSelect.innerHTML = '<option value="">One-off comparison</option>' + workflows.map(item =>
    `<option value="${escape(workflowKey(item.name))}">${escape(item.name)}</option>`).join('');
  workflowSelect.value = profile ? key : '';
  baselineSelect.disabled = Boolean(profile);
  removeBaselineButton.hidden = !profile;
  document.querySelector('#compare-submit').textContent = profile ? 'Check candidate' : 'Compare';
  updateSaveLabel();
  const baseline = chains.find(chain => chain.id === (profile?.runId ?? params.get('baseline')));
  const candidate = chains.find(chain => chain.id === params.get('candidate'));
  const options = [
    ['Imported runs', chains.filter(chain => chain.imported)],
    ['Fictional examples', examples],
  ].filter(([, items]) => items.length).map(([label, items]) => `<optgroup label="${label}">${items.map(item =>
    `<option value="${escape(item.id)}">${escape(item.title)} · ${escape(item.id)}</option>`).join('')}</optgroup>`).join('');
  for (const [select, chosen] of [[baselineSelect, baseline], [candidateSelect, candidate]]) {
    const draft = preserveDraft && !select.disabled && chains.some(chain => chain.id === select.value) ? select.value : null;
    select.innerHTML = '<option value="">Choose a run</option>' + options;
    select.value = draft ?? chosen?.id ?? '';
  }
  comparisonRows = [];
  comparisonPair = [];
  compareResults.replaceChildren();
  compareStatus.textContent = '';
  if (key && !profile) {
    compareResults.innerHTML = regressionNotice('review', 'The saved workflow is unavailable. Choose a saved workflow or start a one-off comparison.')
      + '<p class="compare-empty"><a href="#compare?">Start a one-off comparison</a></p>';
    return;
  }
  if (profile && !baseline) {
    compareResults.innerHTML = regressionNotice('review', `Import the original baseline run ${profile.runId} to check this workflow.`);
    return;
  }
  if (profile && !candidate) {
    compareStatus.textContent = params.get('candidate') ? 'The selected candidate is unavailable. Choose another run.' : 'Choose a candidate to check against this saved baseline.';
    return;
  }
  if (!baseline || !candidate) {
    if (params.get('baseline') || params.get('candidate')) {
      compareStatus.textContent = 'A selected run is unavailable. Import it again or choose another run.';
    }
    compareResults.innerHTML = `<p class="compare-empty">Select two imported runs or <a href="${comparisonHash('CH-001', 'CH-002')}">try an example comparison</a>.</p>`;
    return;
  }
  if (baseline.id === candidate.id) {
    compareStatus.textContent = 'Choose two different runs.';
    return;
  }
  if (profile) {
    compareStatus.textContent = 'Checking the saved baseline.';
    checkPinnedComparison(profile, baseline, candidate, revision);
  } else {
    renderComparisonResults(baseline, candidate);
  }
}

async function checkPinnedComparison(profile, baseline, candidate, revision) {
  let message = '';
  try {
    if (await runFingerprint(baseline) !== profile.fingerprint) {
      message = 'The run no longer matches the pinned baseline. Reimport the original run or explicitly replace the baseline.';
    } else if (!canPinBaseline(baseline, results.get(baseline.id))) {
      message = 'The pinned run does not have a complete, within-scope assessment and usable artifact references.';
    }
  } catch {
    message = 'The browser could not verify the pinned baseline.';
  }
  if (revision !== comparisonRevision || comparison.hidden) return;
  if (message) {
    compareStatus.textContent = regressionLabels.review;
    compareResults.innerHTML = regressionNotice('review', message);
  } else {
    renderComparisonResults(baseline, candidate, profile);
  }
}

function renderComparisonResults(baseline, candidate, profile) {
  const baseResult = results.get(baseline.id);
  const nextResult = results.get(candidate.id);
  const groups = compareRuns(baseline, candidate, baseResult, nextResult);
  comparisonPair = [baseline, candidate];
  const runCard = (label, chain, result) => `<div class="compare-run">
    <p class="field-label">${label}</p><h3>${escape(chain.title)}</h3>
    <a href="#${escape(chain.id)}"><code>${escape(chain.id)}</code></a>
    <p class="compare-assessment">${badge(result.status)} <span>${result.completeness === 'complete' ? 'Supplied evidence complete' : 'Supplied evidence incomplete'}</span></p>
  </div>`;
  const sections = [['Permissions', groups.permissions], ['Actions', groups.actions], ['Evidence', groups.evidence]];
  const count = sections.reduce((sum, [, rows]) => sum + rows.length, 0);
  const assessment = profile ? checkRegression(groups, nextResult) : null;
  compareStatus.textContent = (assessment ? `${regressionLabels[assessment.status]}. ` : '')
    + `${count} ${count === 1 ? 'difference' : 'differences'} across permissions, actions and evidence.`;
  compareResults.innerHTML = `<div class="compare-sides">${runCard('Baseline', baseline, baseResult)}${runCard('Candidate', candidate, nextResult)}</div>
    <p class="compare-method">Matches use record IDs and unique recorded identities. One-sided records may reflect unmatched or missing evidence. Grant durations are compared across runs. Expand a difference to inspect the original dates and records.</p>
    ${sections.map(([label, rows]) => `<section class="compare-group" aria-label="${label} differences">
      <h3>${label} <span class="compare-count">${rows.length}</span></h3>
      ${rows.length ? rows.map(row => {
        const index = comparisonRows.push(row) - 1;
        const description = row.changes.length ? row.changes.map(field => field.label).join(' · ')
          : row.before ? 'Only in baseline' : 'Only in candidate';
        return `<details class="run-difference" data-comparison-index="${index}"><summary>
          <strong>${escape(row.title)}</strong><span class="muted">${escape(description)}</span>
        </summary><div class="compare-detail"></div></details>`;
      }).join('') : '<p class="compare-empty">No differences in the compared fields.</p>'}</section>`).join('')}`;
  if (assessment) {
    const description = assessment.status === 'pass' ? 'The compared records show no regression. Recorded call IDs and artifact hashes may differ.'
      : 'Review the reasons and recorded evidence below.';
    const visibleReasons = assessment.reasons.slice(0, 6);
    const reasonList = visibleReasons.map(reason => {
      if (reason.row) {
        return `<li><button type="button" class="regression-reason" data-open-difference="${comparisonRows.indexOf(reason.row)}">
          ${escape(reason.row.title)} · ${escape(reason.message)}</button></li>`;
      }
      return `<li><a href="#${escape(candidate.id)}${reason.eventId ? '/' + escape(reason.eventId) : ''}">${escape(reason.message)}</a></li>`;
    }).join('');
    compareResults.insertAdjacentHTML('afterbegin', regressionNotice(assessment.status, description));
    if (visibleReasons.length) {
      compareResults.querySelector('.regression-verdict > div').insertAdjacentHTML('beforeend',
        `<ul>${reasonList}</ul>${assessment.reasons.length > visibleReasons.length ? '<p>See the differences below for more records.</p>' : ''}`);
    }
  }
}

function comparisonValue(value, capabilities) {
  if (capabilities) return value.length ? pairs(value) : 'None';
  if (Array.isArray(value)) return value.length ? `<ul>${value.map(item => `<li>${escape(item)}</li>`).join('')}</ul>` : 'None';
  if (value === undefined) return 'Not supplied';
  if (value === null) return 'None';
  return escape(typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value);
}

function comparisonDetail(row, pair = comparisonPair) {
  const records = ['Baseline', 'Candidate'].map((label, index) => {
    const record = index === 0 ? row.before : row.after;
    const chain = pair?.[index];
    const eventId = row.eventLinks?.[index];
    return `<section><h4>${label} record</h4>
      ${record ? `<pre tabindex="0" aria-label="${label} raw record">${escape(JSON.stringify(record, null, 2))}</pre>` : '<p class="muted">No matching record.</p>'}
      ${chain && eventId ? `<a href="#${escape(chain.id)}/${escape(eventId)}">Open ${label.toLowerCase()} hop</a>` : ''}
    </section>`;
  }).join('');
  return `${row.changes.length ? `<table class="compare-fields">
    <caption class="sr-only">Changed fields for ${escape(row.title)}</caption>
    <thead><tr><th scope="col">Field</th><th scope="col">Baseline</th><th scope="col">Candidate</th></tr></thead>
    <tbody>${row.changes.map(field => `<tr><th scope="row">${escape(field.label)}</th>
      <td>${field.capabilities && field.before.length ? '<strong class="field-label">Removed</strong>' : ''}${comparisonValue(field.before, field.capabilities)}</td>
      <td>${field.capabilities && field.after.length ? '<strong class="field-label">Added</strong>' : ''}${comparisonValue(field.after, field.capabilities)}</td>
    </tr>`).join('')}</tbody></table>` : ''}
    <div class="compare-sides compare-records">${records}</div>`;
}

function setView(view) {
  comparison.hidden = view !== 'comparison';
  reviewInbox.hidden = view !== 'review-inbox';
  for (const selector of ['.workspace', '#overview', '.demo-note', '.dataset-note']) document.querySelector(selector).hidden = view !== 'investigation';
  document.querySelector('.import-controls').hidden = view === 'review-inbox';
  const skipLink = document.querySelector('.skip-link');
  skipLink.href = '#' + view;
  skipLink.textContent = `Skip to ${view === 'review-inbox' ? 'regression inbox' : view}`;
  if (view === 'comparison') {
    document.querySelector('.environment').textContent = 'Local / comparison';
    document.querySelector('footer').textContent = 'Comparison of supplied records · Local to this browser';
  } else if (view === 'review-inbox') {
    document.querySelector('.environment').textContent = 'Local / review';
    document.querySelector('footer').textContent = 'Saved reports and review notes · Local to this browser';
  }
  for (const [link, name] of [[investigateLink, 'investigation'], [compareLink, 'comparison'], [reviewLink, 'review-inbox']]) {
    if (view === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function updateClearButton() {
  document.querySelector('#clear-imports').disabled = !chains.some(item => item.imported) && !restored.warning;
}

function selectFromHash() {
  if (location.hash === '#review-inbox' && !reviewInbox.hidden) {
    reviewInbox.focus();
    history.replaceState(null, '', reviewLink.hash);
    return;
  }
  if (location.hash.startsWith(reviewRoute) || location.hash === '#review-inbox') {
    const wasActive = !reviewInbox.hidden;
    setView('review-inbox');
    reviewLink.href = location.hash.startsWith(reviewRoute) ? location.hash : reviewRoute;
    reviewView.render({ focus: wasActive });
    if (!wasActive && document.activeElement === reviewLink) reviewInbox.focus();
    return;
  }
  if (location.hash === '#comparison' && !comparison.hidden) {
    comparison.focus();
    // The skip link is a focus target; keep the selected pair in the URL.
    history.replaceState(null, '', compareLink.hash);
    return;
  }
  if (location.hash.startsWith(compareRoute)) {
    const wasActive = !comparison.hidden;
    setView('comparison');
    compareLink.href = location.hash;
    renderComparison();
    if (!wasActive && document.activeElement === compareLink) comparison.focus();
    return;
  }
  const leftPanel = !comparison.hidden || !reviewInbox.hidden;
  setView('investigation');
  if (location.hash === '#investigation' && selectedChain) {
    document.querySelector('#investigation').focus();
    return;
  }
  const focusedLink = document.activeElement?.closest('a')?.getAttribute('href');
  const focusedKind = document.activeElement?.classList.contains('chain-card') ? 'chain-card'
    : document.activeElement?.classList.contains('hop') ? 'hop' : 'brand';
  const [chainId, eventId] = location.hash.slice(1).split('/');
  selectedChain = chains.find(chain => chain.id === chainId) ?? chains[0];
  const result = results.get(selectedChain.id);
  selectedEvent = selectedChain.events.find(event => event.id === eventId)
    ?? selectedChain.events.find(event => result.events.find(item => item.id === event.id)?.status !== 'valid')
    ?? selectedChain.events[0];
  render();
  investigateLink.href = `#${selectedChain.id}/${selectedEvent.id}`;
  if (leftPanel && document.activeElement !== investigateLink) document.querySelector('#investigation').focus();
  if (focusedLink) [...document.querySelectorAll(`a.${focusedKind}`)].find(link => link.getAttribute('href') === focusedLink)?.focus({ preventScroll: true });
}

function render() {
  const chain = selectedChain;
  const result = results.get(chain.id);
  document.querySelector('#overview').innerHTML = [
    ['Completed chains', chains.length, 'Examples and imported investigations'],
    ['With violations', [...results.values()].filter(r => r.status === 'violation').length, 'Recorded authority exceeded'],
    ['Unverifiable', [...results.values()].filter(r => r.status === 'unknown').length, 'Authority evidence missing'],
  ].map(([label, count, note], i) => `<div class="stat stat-${i}"><div><span>${label}</span><strong>${String(count).padStart(2, '0')}</strong></div><p>${note}</p></div>`).join('');
  document.querySelector('#chain-list').innerHTML = chains.map(item => `<a href="#${item.id}" class="chain-card ${item.id === chain.id ? 'selected' : ''}" ${item.id === chain.id ? 'aria-current="true"' : ''}>
    <div class="chain-card-top"><code>${escape(item.id)}</code>${badge(results.get(item.id).status)}</div><h3>${escape(item.title)}</h3><p>${escape(item.summary)}</p><div class="chain-card-meta"><span>${item.events.length} recorded actions</span><span>${time(item.completedAt)}</span></div></a>`).join('');

  document.querySelector('.rail-heading > span').textContent = String(chains.length).padStart(2, '0');
  updateClearButton();
  document.querySelector('.environment').textContent = chain.imported ? 'Local / imported' : 'Local / synthetic';
  document.querySelector('.dataset-note').textContent = chain.imported ? 'Imported completed run' : 'Example dataset';
  document.querySelector('.demo-note strong').textContent = chain.imported ? 'Imported investigation' : 'Synthetic demonstration';
  document.querySelector('.demo-note span').textContent = chain.imported ? 'Source provenance and identities are supplied by the file. Findings assess recorded authority; this viewer does not block actions.' : 'Completed actions are simulated. Findings assess recorded authority; actions are not blocked.';
  document.querySelector('footer').innerHTML = chain.imported ? 'Imported records · Evaluation uses recorded action time.<span>Viewing this file does not run agents</span>' : 'Fixed example records · Evaluation uses action time, not the current clock.<span>No live agents connected</span>';

  const event = selectedEvent;
  const eventStatus = result.events.find(item => item.id === event.id).status;
  const hop = chain.events.indexOf(event) + 1;
  const grant = chain.grants.find(item => item.id === event.authorityId);
  const parent = grant ? chain.grants.find(item => item.id === grant.parentGrantId) : undefined;
  const findings = result.findings.filter(item => item.eventId === event.id || !item.eventId);
  findingEvidence = findings;
  const findingEvents = new Set(result.findings.filter(f => f.eventId).map(f => f.eventId));
  document.querySelector('#investigation').innerHTML = `
    <div class="investigation-heading"><div><p class="eyebrow">${chain.id} <span>·</span> COMPLETED CHAIN</p><h2>${escape(chain.title)}</h2></div>${badge(result.status)}</div>
    <p class="source-label">${chain.imported ? 'Imported source claim: ' : 'Source: '}${escape(chain.source)}</p>
    <div class="principal-strip"><span class="avatar" aria-hidden="true">${chain.imported ? 'LW' : 'AC'}</span><div><span class="field-label">Acting for</span><strong>${escape(chain.principal.name)}</strong><span class="muted">${escape(chain.principal.role)}</span></div><div class="intent"><span class="field-label">Original intent</span><span>${escape(chain.intent)}</span></div></div>
    <div class="chain-section-heading"><h3>Delegation path</h3><span>${result.completeness === 'complete' ? 'Supplied evidence complete' : 'Supplied evidence incomplete'}</span></div>
    <div class="path" aria-label="Select an agent hop">${chain.events.map((item, i) => {
      const state = result.events.find(r => r.id === item.id).status;
      return `<a href="#${chain.id}/${item.id}" class="hop ${state} ${item.id === event.id ? 'active' : ''}" ${item.id === event.id ? 'aria-current="step"' : ''}><div class="hop-top"><span>HOP ${i + 1}</span><span class="hop-state" aria-label="${statusLabels[state]}">${icon(state)}</span></div><strong>${escape(item.label)}</strong><code>${escape(item.action.action)}</code><span class="hop-bottom">${time(item.action.at)} <span aria-hidden="true">↗</span></span></a>`;
    }).join('')}</div>
    <div class="assessment ${result.status}"><span class="assessment-icon" aria-hidden="true">${icon(result.status)}</span><div><strong>${result.status === 'violation' ? 'Recorded authority was exceeded' : result.status === 'unknown' ? 'The authority trail cannot be verified' : 'Every recorded action stays within delegated authority'}</strong><p>${result.status === 'violation' ? `Inspect ${findingEvents.size} flagged hop. Inspect the findings below for the exact scope, timing, or delegation condition that failed.` : result.status === 'unknown' ? 'Missing, malformed or inconsistent evidence prevents verification. Inspect the affected hops for the specific finding.' : 'The supplied grants preserve the principal, narrow authority, and cover each recorded action time.'}${result.status === 'violation' && result.completeness === 'incomplete' ? ' There are also unresolved evidence gaps.' : ''}</p></div></div>
    <div class="detail-grid">
      <section class="evidence-panel" aria-labelledby="hop-title"><div class="panel-heading"><h3 id="hop-title">Hop ${hop} · ${escape(event.label)}</h3>${badge(eventStatus)}</div><p class="panel-description">${escape(event.job)}</p>
        <dl class="event-details"><div><dt>Agent identity</dt><dd><code>${escape(event.actor)}</code></dd></div><div><dt>Recorded action</dt><dd><code>${escape(event.action.action)}</code></dd></div><div><dt>Target resource</dt><dd><code>${escape(event.action.resource)}</code></dd></div><div><dt>Action time</dt><dd>${time(event.action.at)}</dd></div><div><dt>Logged outcome</dt><dd>Completed <span class="muted">· ${chain.imported ? 'recorded in file' : 'simulated'}</span></dd></div><div><dt>Authority record</dt><dd><code>${escape(event.authorityId)}</code>${grant ? '' : '<span class="inline-unknown">Missing</span>'}</dd></div></dl>
        <h4>Authority comparison</h4><div class="authority-comparison"><div><span class="field-label">${grant?.parentGrantId === null ? 'Principal granted' : 'Parent authority'}</span>${grant ? (grant.parentGrantId === null ? pairs(grant.capabilities) : parent ? pairs(parent.capabilities) : '<span class="missing">Parent grant not available</span>') : '<span class="missing">Cannot establish from missing grant</span>'}</div><div><span class="field-label">${grant?.parentGrantId === null ? 'Agent used' : 'Delegated to this agent'}</span>${grant?.parentGrantId === null ? pairs([event.action]) : grant ? pairs(grant.capabilities) : '<span class="missing">Grant not available</span>'}</div></div>
        ${grant ? `<p class="validity">Valid ${time(grant.validFrom)} – ${time(grant.expiresAt)} <span>· ${grant.canDelegate ? 'May delegate' : 'No further delegation'}</span></p>` : ''}
      </section>
      <section class="findings-panel" aria-labelledby="findings-title"><div class="panel-heading"><h3 id="findings-title">Evidence findings</h3><span class="count">${findings.length}</span></div>
        ${findings.length ? findings.map((finding, index) => `<article class="finding ${finding.severity}"><span class="finding-code">${escape(finding.code.replaceAll('_', ' '))}</span><p>${escape(finding.message)}</p>${finding.grantId ? `<code>${escape(finding.grantId)}</code>` : ''}<details class="compared-evidence" data-finding-index="${index}"><summary>Compared evidence</summary><pre></pre></details></article>`).join('') : '<div class="no-findings"><span aria-hidden="true">✓</span><strong>No violation found at this hop</strong><p>Actor, scope, delegation and timing agree with the supplied authority records.</p></div>'}
        <p class="evidence-limit">${chain.imported ? 'Imported provenance and identities are self-reported.' : 'These records are synthetic and self-reported.'} “Within scope” is not proof of authenticated identity, complete capture or action prevention.</p>
      </section>
    </div>
    <details class="raw-evidence"><summary><span>Raw evidence for this hop</span><span class="muted">Event + grant + parent</span></summary><pre>${escape(JSON.stringify({ source: chain.source, principal: chain.principal, event, grant: grant ?? null, parentGrant: parent ?? null }, null, 2))}</pre></details>`;
  document.querySelector('#announcement').textContent = `${chain.title}. ${statusLabels[result.status]}. Hop ${hop}, ${event.label}, ${statusLabels[eventStatus]}.`;
}

window.addEventListener('hashchange', selectFromHash);
workflowName.addEventListener('input', updateSaveLabel);
workflowSelect.addEventListener('change', () => {
  const profile = workflows.find(item => workflowKey(item.name) === workflowSelect.value);
  const baseline = profile?.runId ?? baselineSelect.value;
  const candidate = candidateSelect.value === baseline ? '' : candidateSelect.value;
  location.hash = comparisonHash(baseline, candidate, workflowSelect.value);
});
saveBaselineButton.addEventListener('click', async () => {
  const baseline = chains.find(chain => chain.id === baselineSelect.value);
  const name = workflowName.value.trim();
  if (!baseline || !canPinBaseline(baseline, results.get(baseline.id))) {
    workflowStatus.textContent = 'Choose a within-scope baseline with complete authority evidence and usable artifact references.';
    return;
  }
  if (!name) {
    workflowStatus.textContent = 'Enter a workflow name.';
    workflowName.focus();
    return;
  }
  const key = workflowKey(name);
  const expected = workflows.find(item => workflowKey(item.name) === key);
  const currentRoute = location.hash;
  saveBaselineButton.disabled = true;
  try {
    const fingerprint = await runFingerprint(baseline);
    workflows = saveWorkflowBaseline(getStorage, name, baseline, fingerprint, expected);
    workflowStatus.textContent = `Saved baseline ${baseline.id} for ${name}.`;
    if (location.hash === currentRoute) {
      const candidate = candidateSelect.value === baseline.id ? '' : candidateSelect.value;
      const hash = comparisonHash(baseline.id, candidate, key);
      if (location.hash === hash) renderComparison();
      else location.hash = hash;
    }
  } catch (error) {
    workflowStatus.textContent = `Could not save the baseline. ${error.message}`;
    renderComparison(true);
  } finally {
    saveBaselineButton.disabled = false;
  }
});
removeBaselineButton.addEventListener('click', () => {
  const profile = workflows.find(item => workflowKey(item.name) === workflowSelect.value);
  if (!profile) return;
  try {
    workflows = removeWorkflowBaseline(getStorage, profile);
    workflowStatus.textContent = `Removed the saved baseline for ${profile.name}.`;
    location.hash = comparisonHash(baselineSelect.value, candidateSelect.value);
  } catch (error) {
    workflowStatus.textContent = `Could not remove the baseline. ${error.message}`;
    renderComparison(true);
  }
});
document.querySelector('#compare-form').addEventListener('submit', event => {
  event.preventDefault();
  const key = workflowSelect.value;
  if (!baselineSelect.value) {
    compareStatus.textContent = 'A baseline run is required.';
    return;
  }
  if (baselineSelect.value === candidateSelect.value) {
    compareStatus.textContent = 'Choose two different runs.';
    compareResults.replaceChildren();
    candidateSelect.focus();
    return;
  }
  const hash = comparisonHash(baselineSelect.value, candidateSelect.value, key);
  if (location.hash === hash) renderComparison();
  else location.hash = hash;
});
compareResults.addEventListener('click', event => {
  const button = event.target.closest('button[data-open-difference]');
  if (!button) return;
  const index = Number(button.dataset.openDifference);
  const details = compareResults.querySelector(`[data-comparison-index="${index}"]`);
  if (!details) return;
  details.open = true;
  details.querySelector('summary').focus();
});
compareResults.addEventListener('toggle', event => {
  const details = event.target;
  if (!details.matches('.run-difference') || !details.open) return;
  const detail = details.querySelector('.compare-detail');
  const row = comparisonRows[Number(details.dataset.comparisonIndex)];
  if (row && !detail.hasChildNodes()) detail.innerHTML = comparisonDetail(row);
}, true);
// Serialize repeated capability evidence only when its details are opened.
document.querySelector('#investigation').addEventListener('toggle', event => {
  const details = event.target;
  if (!details.matches('details.compared-evidence') || !details.open) return;
  const finding = findingEvidence[Number(details.dataset.findingIndex)];
  if (finding) details.querySelector('pre').textContent = JSON.stringify(finding.compared, null, 2);
}, true);
document.querySelector('#investigation-file').addEventListener('change', async event => {
  const status = document.querySelector('#import-status');
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > MAX_IMPORT_BYTES) throw new Error('Choose a JSON export smaller than 1 MB.');
    const imported = parseInvestigation(await file.text());
    const evaluated = evaluateChain(imported);
    if (evaluated.events.length !== imported.events.length) throw new Error('The export cannot be displayed as a completed chain.');
    chains = mergeInvestigation(chains, imported);
    results.set(imported.id, evaluated);
    const assessment = evaluated.findings.some(finding => finding.code === 'EVALUATION_LIMIT')
      ? ' Evaluation is incomplete: a work or finding limit was reached. Retained violations remain visible; other evidence is unassessed.' : '';
    try {
      saveInvestigation(getStorage, imported);
      status.textContent = `Imported and saved in this browser. Reload restores the run and evidence. Source claims remain unverified.${assessment}`;
      status.classList.remove('import-error');
    } catch {
      status.textContent = `Imported for this tab only; saving failed. Browser storage may be unavailable, full (20 runs / 2 MiB), or damaged. Keep the original export; this import will be lost on reload.${assessment}`;
      status.classList.add('import-error');
    }
    if (!reviewInbox.hidden) updateClearButton();
    else if (!comparison.hidden) renderComparison(true);
    else if (location.hash === `#${imported.id}`) selectFromHash();
    else location.hash = imported.id;
  } catch (error) {
    status.textContent = `Import failed: ${error.message}`;
    status.classList.add('import-error');
  } finally { event.target.value = ''; }
});
document.querySelector('#clear-imports').addEventListener('click', () => {
  try {
    clearInvestigations(getStorage);
    chains = [...examples];
    results.clear();
    chains.forEach(chain => results.set(chain.id, evaluateChain(chain)));
    restored.warning = '';
    importStatus.textContent = 'Imported runs cleared from this browser and this tab. Original export files are unchanged. Other open tabs may still display their loaded copies.';
    importStatus.classList.remove('import-error');
    if (!comparison.hidden) renderComparison();
    else if (location.hash === `#${examples[0].id}`) selectFromHash();
    else location.hash = examples[0].id;
  } catch {
    importStatus.textContent = 'Could not clear browser storage. Imported runs are still displayed. Use browser site-data settings to remove saved copies.';
    importStatus.classList.add('import-error');
  }
});
selectFromHash();
