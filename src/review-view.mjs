import { regressionLabels } from './comparison.mjs';
import { MAX_IMPORT_BYTES, parseInvestigation } from './import.mjs';
import {
  assessFollowUp, assessReview, attachReviewFollowUp, createReviewCase, createReviewPackage, importReview, importReviewPackage,
  MAX_REPORT_BYTES, MAX_REVIEW_NOTE, MAX_REVIEW_PACKAGE_BYTES, removeReview, resolveReviewCase,
  restoreReviews, reviewDecisions, saveReview, saveReviewDecision,
} from './review.mjs';

const tones = { pass: 'valid', regression: 'violation', review: 'unknown' };
const priority = { regression: 0, review: 1, pass: 2 };
const evidenceLabels = {
  matched: 'Matches report fingerprint',
  missing: 'Original export missing',
  mismatch: 'Export does not match the report',
  unavailable: 'No fingerprint recorded',
};
export const reviewRoute = '#review?';
const itemRoute = id => reviewRoute + new URLSearchParams({ item: id });

export function createReviewInbox({ getStorage, escape, comparisonDetail }) {
  const form = document.querySelector('#review-import');
  const packageInput = document.querySelector('#review-package-file');
  const list = document.querySelector('#review-list');
  const detail = document.querySelector('#review-detail');
  const status = document.querySelector('#review-status');
  let selected;
  let revision = 0;
  let records = [];

  function announce(message, error = false) {
    status.textContent = message;
    status.classList.toggle('import-error', error);
  }

  function finishImport({ id, mismatches, caseWarnings }, currentRoute) {
    const message = mismatches.length ? `Report saved. The selected ${mismatches.join(' and ')} evidence did not match and was not saved.`
      : 'Report saved in this browser.';
    announce([message, ...caseWarnings].join(' '), Boolean(mismatches.length || caseWarnings.length));
    if (location.hash !== currentRoute) return;
    if (location.hash === itemRoute(id)) render({ focus: true });
    else location.hash = itemRoute(id);
  }

  function evidenceDetails(title, record, description = '') {
    const index = records.push(record) - 1;
    return `<details class="run-difference" data-review-evidence="${index}"><summary><strong>${escape(title)}</strong>
      <span class="muted">${escape(description)}</span></summary><div class="compare-detail"></div></details>`;
  }

  function renderEvidence(item, assessment) {
    const { states, groups, candidateResult, verdict } = assessment;
    const evidence = `<dl class="review-evidence-status">${['baseline', 'candidate'].map(side => `<div>
      <dt>${side === 'baseline' ? 'Baseline' : 'Candidate'}</dt><dd><code>${escape(item.report[side + 'Id'] ?? 'No run ID')}</code>
      <span>${evidenceLabels[states[side]]}</span></dd></div>`).join('')}</dl>`;
    if (!verdict) return evidence + '<p class="panel-description">The verdict cannot be reproduced from the supplied exports. Use the original files to restore matching evidence.</p>';

    const reproduced = verdict.status === item.report.status;
    const explanation = reproduced ? 'The current check reproduced the reported verdict.'
      : 'The current check differs from the reported verdict. Review the matching evidence below.';
    const reasons = verdict.reasons.slice(0, 12).map(reason => {
      if (reason.row) return evidenceDetails(reason.row.title, { row: reason.row }, reason.message);
      const chain = item.candidate;
      const event = chain.events.find(record => record.id === reason.eventId);
      const grant = chain.grants.find(record => record.id === event?.authorityId);
      const parentGrant = chain.grants.find(record => record.id === grant?.parentGrantId);
      const findings = candidateResult.findings.filter(finding => finding.eventId === (event?.id ?? null));
      return evidenceDetails(event?.label ?? 'Candidate assessment', { snapshot: {
        event, grant: grant ?? null, parentGrant: parentGrant ?? null, findings,
      } }, reason.message);
    });
    const differences = Object.entries(groups).filter(([, rows]) => rows.length).map(([group, rows]) =>
      `<h4>${escape(group[0].toUpperCase() + group.slice(1))}</h4>${rows.map(row => evidenceDetails(row.title, { row },
        row.changes.map(change => change.label).join(' · ') || 'Only supplied in one run')).join('')}`).join('');
    return `${evidence}<section class="assessment review-verdict ${tones[verdict.status]}">
      <div><strong>Current evidence check · ${regressionLabels[verdict.status]}</strong><p>${explanation}</p></div></section>
      ${reasons.length ? `<h4>Flagged findings</h4>${reasons.join('')}` : ''}
      ${differences ? `<details class="review-differences"><summary>All comparison differences</summary>${differences}</details>` : ''}`;
  }

  function renderCase(item, original, followUp) {
    if (item.report.status === 'pass' && (!original.verdict || original.verdict.status === 'pass') && !item.decision) return '';
    const { assessment, canResolve, resolved } = followUp;
    const comparison = (label, record, check) => `<div class="compare-run"><h3>${label}</h3>
      <code>${escape(record.report.candidateId ?? 'No run ID')}</code>
      <p class="panel-description">Reported · ${regressionLabels[record.report.status]}</p>
      <p class="panel-description">${check?.verdict ? `Rechecked · ${regressionLabels[check.verdict.status]}` : 'Evidence check unavailable'}</p></div>`;
    const nextStep = resolved ? 'The saved follow-up still passes against the original baseline.'
      : canResolve ? 'Inspect the follow-up evidence, then close the case when you are ready.'
        : 'To close this case, save a decision and attach a passing follow-up with matching evidence against the original baseline.';
    const followUpRecords = assessment?.states.candidate === 'matched'
      ? evidenceDetails('Follow-up actions and grants', { snapshot: item.followUp.candidate }) : '';
    return `<section class="review-case" aria-labelledby="review-case-title">
      <div class="panel-heading"><h3 id="review-case-title">Review decision and follow-up</h3>
        <span class="badge ${resolved ? 'valid' : 'unknown'}">${resolved ? 'Resolved' : 'Open'}</span></div>
      <form id="review-decision-form">
        <label for="review-decision">Decision</label>
        <select id="review-decision" required><option value="">Choose a decision</option>${Object.entries(reviewDecisions).map(([kind, label]) =>
          `<option value="${kind}" ${item.decision?.kind === kind ? 'selected' : ''}>${label}</option>`).join('')}</select>
        <label for="review-decision-reason">Reason for decision</label>
        <textarea id="review-decision-reason" rows="2" maxlength="${MAX_REVIEW_NOTE}" required>${escape(item.decision?.reason ?? '')}</textarea>
        <button type="submit">Save decision</button>
      </form>
      <label for="review-follow-up-file">Attach follow-up package</label>
      <input id="review-follow-up-file" type="file" accept=".json,application/json" aria-describedby="review-case-help" ${item.decision ? '' : 'disabled'}>
      ${item.followUp ? `<div class="compare-sides review-case-verdicts">${comparison('Original run', item, original)}
        ${comparison('Follow-up run', item.followUp, assessment)}</div>
        ${assessment ? `<details class="review-differences"><summary>Inspect follow-up evidence</summary>${renderEvidence(item.followUp, assessment)}${followUpRecords}</details>` : ''}` : ''}
      <p id="review-case-help" class="panel-description">${nextStep}</p>
      <button type="button" id="resolve-review-case" ${canResolve && !resolved ? '' : 'disabled'}>Close as resolved</button>
    </section>`;
  }

  function renderExport(item, original, followUp) {
    const evidence = ['baseline', 'candidate'].filter(side => original.states[side] === 'matched');
    const matching = evidence.length ? ` and matching ${evidence.join(' and ')} evidence` : '';
    const contents = [];
    if (item.decision) contents.push('saved decision and reason');
    if (item.decision && followUp.assessment?.states.baseline === 'matched'
      && followUp.assessment.states.candidate === 'matched') contents.push('follow-up report and evidence');
    if (followUp.resolved) contents.push('verified closure');
    return `<details class="review-differences"><summary>Export review package or case</summary>
      <p class="panel-description">The download includes the original report${matching}.</p>
      ${contents.length ? `<p class="panel-description">The case download also includes the ${contents.join(', ')}.</p>` : ''}
      <div class="review-note-actions"><label><input type="checkbox" id="include-review-note" ${item.note ? '' : 'disabled'}> Include saved review note</label>
      <button type="button" id="download-review-package">Download review package</button>
      ${item.decision ? '<button type="button" id="download-review-case">Download review case</button>' : ''}</div></details>`;
  }

  async function render({ focus = false } = {}) {
    const currentRevision = ++revision;
    const { items, warning } = restoreReviews(getStorage);
    const id = new URLSearchParams(location.hash.slice(reviewRoute.length)).get('item');
    selected = items.find(item => item.id === id);
    records = [];
    if (warning) announce(warning, true);
    list.innerHTML = [...items].sort((a, b) => Number(a.reviewed) - Number(b.reviewed)
      || priority[a.report.status] - priority[b.report.status]).map(item => `<a class="chain-card review-card ${item.id === id ? 'selected' : ''}"
        href="${itemRoute(item.id)}" ${item.id === id ? 'aria-current="true"' : ''}>
        <span class="badge ${tones[item.report.status]}">${regressionLabels[item.report.status]}</span>
        <code>${escape(item.report.candidateId ?? 'Run ID unavailable')}</code>
        <span class="muted">${item.reviewed ? 'Reviewed' : 'Unreviewed'}</span></a>`).join('');
    if (!selected) {
      detail.innerHTML = `<p class="muted">${id ? 'This report is unavailable in this browser.'
        : items.length ? 'Select a report to inspect its evidence and record your review.' : 'No saved reports yet. Import an offline regression report to get started.'}</p>`;
      return;
    }
    const item = selected;
    detail.innerHTML = '<p class="muted">Checking the saved evidence…</p>';
    if (focus) detail.focus();
    try {
      const assessment = await assessReview(item);
      const followUp = await assessFollowUp(item, assessment);
      if (currentRevision !== revision) return;
      const title = assessment.states.candidate === 'matched' ? item.candidate.title : 'Saved regression report';
      detail.innerHTML = `<div class="panel-heading"><h3>${escape(title)}</h3>
        <span class="badge ${tones[item.report.status]}">Reported · ${regressionLabels[item.report.status]}</span></div>
        ${renderEvidence(item, assessment)}
        ${item.report.reasons.length ? `<details class="review-differences"><summary>Reasons recorded by the offline report</summary>
          <ul>${item.report.reasons.slice(0, 12).map(reason => `<li>${escape(reason.message)}</li>`).join('')}</ul>
          ${item.report.reasons.length > 12 ? `<p>Showing 12 of ${item.report.reasons.length} recorded reasons.</p>` : ''}</details>` : ''}
        ${renderCase(item, assessment, followUp)}
        <form id="review-note-form">
          <label for="review-note">Review note</label>
          <textarea id="review-note" rows="3" maxlength="${MAX_REVIEW_NOTE}">${escape(item.note)}</textarea>
          <div class="review-note-actions"><label><input type="checkbox" id="review-complete" ${item.reviewed ? 'checked' : ''}> Mark as reviewed</label>
          <button type="submit">Save review</button><button type="button" id="remove-review">Remove from inbox</button></div>
        </form>
        ${renderExport(item, assessment, followUp)}`;
    } catch (error) {
      if (currentRevision === revision) detail.innerHTML = `<p class="import-error">${escape(error.message)}</p>`;
    }
  }

  packageInput.addEventListener('change', async () => {
    const file = packageInput.files[0];
    if (!file) return;
    const currentRoute = location.hash;
    packageInput.disabled = true;
    announce('Checking the review file…');
    try {
      if (file.size > MAX_REVIEW_PACKAGE_BYTES) throw new Error('Choose a review file no larger than 2 MiB.');
      finishImport(await importReviewPackage(getStorage, await file.text()), currentRoute);
    } catch (error) {
      announce(`Could not import the review file. ${error.message}`, true);
    } finally {
      packageInput.value = '';
      packageInput.disabled = false;
    }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    const currentRoute = location.hash;
    button.disabled = true;
    announce('Checking the selected files…');
    try {
      const file = document.querySelector('#review-report-file').files[0];
      if (!file || file.size > MAX_REPORT_BYTES) throw new Error('Choose a regression report no larger than 2 MiB.');
      const evidence = {};
      for (const side of ['baseline', 'candidate']) {
        const exportFile = document.querySelector(`#review-${side}-file`).files[0];
        if (!exportFile) continue;
        if (exportFile.size > MAX_IMPORT_BYTES) throw new Error(`The ${side} export exceeds 1 MiB.`);
        evidence[side] = parseInvestigation(await exportFile.text());
      }
      const imported = await importReview(getStorage, await file.text(), evidence);
      form.reset();
      document.querySelector('#review-import-controls').open = false;
      finishImport(imported, currentRoute);
    } catch (error) {
      announce(`Could not import the report. ${error.message}`, true);
    } finally { button.disabled = false; }
  });

  detail.addEventListener('toggle', event => {
    const element = event.target;
    if (!element.matches('details[data-review-evidence]') || !element.open) return;
    const container = element.querySelector('.compare-detail');
    const record = records[Number(element.dataset.reviewEvidence)];
    if (!record || container.hasChildNodes()) return;
    if (record.row) container.innerHTML = comparisonDetail(record.row, null);
    else {
      const evidence = document.createElement('pre');
      evidence.tabIndex = 0;
      evidence.textContent = JSON.stringify(record.snapshot, null, 2);
      container.append(evidence);
    }
  }, true);

  detail.addEventListener('submit', async event => {
    if (event.target.id === 'review-decision-form' && selected) {
      event.preventDefault();
      try {
        saveReviewDecision(getStorage, selected, detail.querySelector('#review-decision').value,
          detail.querySelector('#review-decision-reason').value);
        announce('Decision saved.');
        await render();
        if (!detail.closest('[hidden]')) detail.querySelector('#review-decision')?.focus({ preventScroll: true });
      } catch (error) { announce(`Could not save the decision. ${error.message}`, true); }
      return;
    }
    if (event.target.id !== 'review-note-form' || !selected) return;
    event.preventDefault();
    try {
      saveReview(getStorage, selected, detail.querySelector('#review-note').value, detail.querySelector('#review-complete').checked);
      announce('Review saved.');
      await render();
      if (!detail.closest('[hidden]')) detail.querySelector('#review-note')?.focus({ preventScroll: true });
    } catch (error) { announce(`Could not save the review. ${error.message}`, true); }
  });

  detail.addEventListener('change', async event => {
    const input = event.target;
    if (input.id !== 'review-follow-up-file' || !input.files[0] || !selected) return;
    const file = input.files[0];
    const item = selected;
    input.disabled = true;
    announce('Checking the follow-up package…');
    try {
      if (file.size > MAX_REVIEW_PACKAGE_BYTES) throw new Error('Choose a review package no larger than 2 MiB.');
      await attachReviewFollowUp(getStorage, item, await file.text());
      announce('Follow-up saved.');
      if (location.hash === itemRoute(item.id)) await render();
    } catch (error) { announce(`Could not attach the follow-up. ${error.message}`, true); }
    finally { input.disabled = false; input.value = ''; }
  });

  detail.addEventListener('click', async event => {
    if (!selected) return;
    if (event.target.id === 'resolve-review-case') {
      const item = selected;
      event.target.disabled = true;
      try {
        await resolveReviewCase(getStorage, item);
        announce('Case closed as resolved.');
        if (location.hash === itemRoute(item.id)) await render();
      } catch (error) {
        announce(`Could not resolve the case. ${error.message}`, true);
        if (location.hash === itemRoute(item.id)) await render();
      }
      return;
    }
    if (['download-review-package', 'download-review-case'].includes(event.target.id)) {
      const item = selected;
      const completeCase = event.target.id === 'download-review-case';
      const label = completeCase ? 'Review case' : 'Review package';
      const checkbox = detail.querySelector('#include-review-note');
      const note = checkbox.checked ? item.note : undefined;
      checkbox.checked = false;
      event.target.disabled = true;
      try {
        const contents = completeCase ? await createReviewCase(item, note) : await createReviewPackage(item.report, item, note);
        const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = completeCase ? 'review-case.json' : 'review-package.json';
        detail.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        announce(`${label} downloaded${note ? ' with the saved note' : ''}.`);
      } catch (error) { announce(`Could not download the ${label.toLowerCase()}. ${error.message}`, true); }
      finally { event.target.disabled = false; }
      return;
    }
    if (event.target.id !== 'remove-review') return;
    if (!window.confirm('Remove this report and its saved evidence, follow-up, decision and notes?')) return;
    try {
      removeReview(getStorage, selected);
      announce('Report removed from the inbox.');
      location.hash = reviewRoute;
    } catch (error) { announce(`Could not remove the report. ${error.message}`, true); }
  });

  return { render };
}
