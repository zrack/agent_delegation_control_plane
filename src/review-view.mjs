import { regressionLabels } from './comparison.mjs';
import { MAX_IMPORT_BYTES, parseInvestigation } from './import.mjs';
import { importInvoiceFolder, invoiceFields } from './invoice-import.mjs';
import { restoreWorkflowBaselines } from './storage.mjs';
import {
  assessFollowUp, assessReview, attachInvoiceFollowUp, attachReviewFollowUp, createReviewCase, createReviewPackage, importReview, importReviewPackage,
  MAX_REPORT_BYTES, MAX_REVIEW_NOTE, MAX_REVIEW_PACKAGE_BYTES, removeReview, resolveReviewCase,
  restoreReviews, reviewDecisions, saveInvoiceCandidate, saveReview, saveReviewDecision,
} from './review.mjs';

const tones = { pass: 'valid', regression: 'violation', review: 'unknown' };
const priority = { regression: 0, review: 1, pass: 2 };
const receiptLabels = {
  matched: 'Matches manifest', missing: 'File missing', unlisted: 'Hash missing from manifest',
  mismatch: 'Hash mismatch', invalid: 'Invalid or unreadable',
};
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
  const invoiceInput = document.querySelector('#invoice-folder-file');
  const invoiceStatus = document.querySelector('#invoice-folder-status');
  const invoiceResults = document.querySelector('#invoice-folder-results');
  const invoiceForm = document.querySelector('#invoice-candidate-form');
  const invoiceWorkflow = document.querySelector('#invoice-workflow');
  const invoiceHelp = document.querySelector('#invoice-candidate-help');
  const invoiceSave = invoiceForm.querySelector('button');
  let invoiceDraft;
  let pins = [];
  let savingInvoice = false;
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
      <div><strong>${item.invoice ? 'Baseline regression' : 'Current evidence check'} · ${regressionLabels[verdict.status]}</strong><p>${explanation}</p></div></section>
      ${reasons.length ? `<h4>Flagged findings</h4>${reasons.join('')}` : ''}
      ${differences ? `<details class="review-differences"><summary>All comparison differences</summary>${differences}</details>` : ''}`;
  }

  function invoiceClosureChecklist(item, original, followUp) {
    const { report, suppliedBaseline, invoice } = item;
    const { pinState, assessment, incompatible, passes } = followUp;
    const checks = [];
    const targetLabels = {
      'review-import-link': 'Go to case import', 'compare-link': 'Open Compare runs',
      'review-decision': 'Go to decision', 'review-follow-up-file': 'Go to follow-up picker',
      'invoice-follow-up-evidence': 'Inspect receipt evidence', 'resolve-review-case': 'Go to close button',
    };
    const row = (label, issue, action, target, evidence = '') => {
      checks.push(`<li><strong>${escape(label)}</strong> · ${escape(issue)}${evidence}
        ${action ? `<p>${escape(action)} ${target ? `<button type="button" data-closure-target="${target}">${targetLabels[target]}</button>` : ''}</p>` : ''}</li>`);
    };
    const identify = (label, runId, fingerprint) => `<p>${label} <code>${escape(runId)}</code>
      <code>${escape(fingerprint)}</code></p>`;
    const expected = identify('Expected baseline', report.baselineId, report.baselineFingerprint);
    const reimport = 'Reimport the case with the original baseline and candidate evidence. Keep the same workflow and decision.';
    const attach = 'Attach the original corrected folder for this invoice case. Pin the original baseline first if needed.';
    if (original.states.baseline !== 'matched') {
      const supplied = suppliedBaseline ? identify('Supplied baseline', suppliedBaseline.runId, suppliedBaseline.fingerprint) : '';
      row('Baseline evidence', suppliedBaseline || original.states.baseline === 'mismatch' ? 'Baseline mismatch' : 'Baseline missing',
        reimport, 'review-import-link', expected + supplied);
    } else {
      row('Baseline evidence', 'Matches the saved case');
    }
    if (original.states.candidate !== 'matched') {
      row('Candidate evidence', evidenceLabels[original.states.candidate], reimport, 'review-import-link');
    } else if (original.states.baseline === 'matched' && !original.verdict) {
      row('Baseline comparison', 'The saved evidence cannot reproduce the comparison', reimport, 'review-import-link');
    }
    if (pinState?.status === 'conflict') {
      row('Workflow pin', `“${invoice.workflow}” uses a different baseline`,
        'Use the original baseline to continue this review. The current pin was kept.', 'compare-link',
        expected + identify('Current pin', pinState.pin.runId, pinState.pin.fingerprint));
    } else if (pinState?.status === 'unreadable') {
      row('Workflow pin', 'Saved workflows could not be read', 'Check this browser’s site storage.');
    } else if (pinState?.status === 'missing' && original.states.baseline === 'matched') {
      row('Workflow pin', `“${invoice.workflow}” is not pinned in this browser`,
        'To attach a replacement or close locally, import the original baseline run and pin it under this workflow.', 'compare-link');
    }
    if (!item.decision) {
      row('Review decision', 'Decision needed', 'Choose a decision and save a reason.', 'review-decision');
    }
    if (!followUp.originalInvoice?.checked) {
      row('Original receipts', 'Saved invoice snapshot could not be verified', reimport, 'review-import-link');
    }
    if (!item.followUp) {
      row('Follow-up evidence', 'Corrected folder needed', attach, item.decision ? 'review-follow-up-file' : 'review-decision');
    } else if (incompatible) {
      row('Follow-up evidence', incompatible === 'baseline' ? 'Follow-up references a different baseline' : 'Follow-up candidate differs',
        'Reimport a case with a follow-up checked against the original baseline.', 'review-import-link');
    } else {
      const receipts = followUp.invoice;
      const checked = receipts?.checked;
      if (!checked || [checked.authority, checked.output, checked.execution].some(check => check.tone !== 'valid')
        || checked.caseId !== followUp.originalInvoice?.checked?.caseId || item.followUp.invoice.workflow !== invoice.workflow) {
        const states = receipts?.receiptStates ?? checked?.receiptStates ?? {};
        const files = Object.entries(states).filter(([, state]) => state !== 'matched')
          .map(([name, state]) => `${name} · ${receiptLabels[state]}`).join(', ');
        const failedChecks = checked ? [checked.authority, checked.output, checked.execution]
          .filter(check => check.tone !== 'valid').map(check => check.label).join(', ') : '';
        const reason = files || failedChecks || (checked ? 'Follow-up does not match this invoice case' : 'Saved receipt snapshot could not be verified');
        row('Follow-up evidence', reason, attach, 'invoice-follow-up-evidence');
      } else {
        row('Follow-up evidence', 'Receipt checks passed');
      }
      if (original.verdict && (assessment?.verdict?.status !== 'pass' || item.followUp.report.status !== 'pass')) {
        row('Follow-up comparison', 'The follow-up did not pass against the original baseline', attach, 'invoice-follow-up-evidence');
      }
    }
    if (passes && followUp.canResolve) {
      row('Closure', 'Ready to close', 'Review the checks and select Close as resolved.', 'resolve-review-case');
    }
    return `<section class="closure-checklist" aria-labelledby="invoice-closure-title">
      <h4 id="invoice-closure-title">Closure checklist</h4><ul>${checks.join('')}</ul></section>`;
  }

  function renderCase(item, original, followUp) {
    if (item.report.status === 'pass' && !followUp.flagged && !item.decision) return '';
    const { assessment, canResolve, pinChanged, resolved } = followUp;
    const comparison = (label, record, check) => `<div class="compare-run"><h3>${label}</h3>
      <code>${escape(record.report.candidateId ?? 'No run ID')}</code>
      <p class="panel-description">Reported · ${regressionLabels[record.report.status]}</p>
      <p class="panel-description">${check?.verdict ? `Rechecked · ${regressionLabels[check.verdict.status]}` : 'Evidence check unavailable'}</p></div>`;
    const nextStep = item.invoice && !resolved ? '' : resolved ? 'The saved follow-up still passes against the original baseline.'
      : pinChanged ? 'Restore the original workflow pin to attach a follow-up or close this case.'
        : canResolve ? 'Inspect the follow-up evidence, then close the case when you are ready.'
        : item.invoice ? 'Save a decision and attach a folder for this invoice case. The original baseline comparison, authority, output, and execution checks must pass for the follow-up.'
          : 'To close this case, save a decision and attach a passing follow-up with matching evidence against the original baseline.';
    const followUpRecords = assessment?.states.candidate === 'matched'
      ? evidenceDetails('Follow-up actions and grants', { snapshot: item.followUp.candidate }) : '';
    const receiptCheck = followUp.invoice;
    const receiptSummary = receiptCheck?.checked
      ? `<p class="panel-description">Follow-up receipts · ${receiptCheck.checked.output.label} · ${receiptCheck.checked.execution.label}</p>`
      : '';
    const receiptDetails = receiptCheck?.checked ? invoiceMarkup(receiptCheck.checked)
      : receiptCheck?.error ? `<p class="import-error">${escape(receiptCheck.error)}</p>
        ${receiptCheck.receiptStates ? receiptFileChecks(receiptCheck.receiptStates) : ''}` : '';
    const label = item.invoice ? 'Attach follow-up invoice folder' : 'Attach follow-up package';
    const picker = item.invoice ? 'webkitdirectory' : 'accept=".json,application/json"';
    const folderUnsupported = item.invoice && !('webkitdirectory' in invoiceInput);
    return `<section class="review-case" aria-labelledby="review-case-title">
      <div class="panel-heading"><h3 id="review-case-title">Review decision and follow-up</h3>
        <span class="badge ${resolved ? 'valid' : 'unknown'}">${resolved ? 'Resolved' : 'Open'}</span></div>
      ${item.invoice && !resolved ? invoiceClosureChecklist(item, original, followUp) : ''}
      <form id="review-decision-form">
        <label for="review-decision">Decision</label>
        <select id="review-decision" required><option value="">Choose a decision</option>${Object.entries(reviewDecisions).map(([kind, label]) =>
          `<option value="${kind}" ${item.decision?.kind === kind ? 'selected' : ''}>${label}</option>`).join('')}</select>
        <label for="review-decision-reason">Reason for decision</label>
        <textarea id="review-decision-reason" rows="2" maxlength="${MAX_REVIEW_NOTE}" required>${escape(item.decision?.reason ?? '')}</textarea>
        <button type="submit">Save decision</button>
      </form>
      <label for="review-follow-up-file">${label}</label>
      <input id="review-follow-up-file" type="file" ${picker} aria-describedby="review-case-help" ${item.decision && !folderUnsupported ? '' : 'disabled'}>
      ${item.followUp ? `<div class="compare-sides review-case-verdicts">${comparison('Original run', item, original)}
        ${comparison('Follow-up run', item.followUp, assessment)}</div>
        ${receiptSummary}
        ${assessment || receiptDetails ? `<details class="review-differences" id="invoice-follow-up-evidence"><summary>Inspect follow-up evidence</summary>
          ${assessment ? renderEvidence(item.followUp, assessment) + followUpRecords : ''}${receiptDetails}</details>` : ''}` : ''}
      <p id="review-case-help" class="panel-description">${folderUnsupported ? 'Use a browser with folder selection support to attach a follow-up.' : nextStep}</p>
      <button type="button" id="resolve-review-case" ${canResolve && !resolved ? '' : 'disabled'}>Close as resolved</button>
    </section>`;
  }

  function renderExport(item, original, followUp) {
    const evidence = ['baseline', 'candidate'].filter(side => original.states[side] === 'matched');
    const matching = evidence.length ? ` and matching ${evidence.join(' and ')} evidence` : '';
    const contents = [];
    if (item.decision) contents.push('saved decision and reason');
    if (!item.invoice && item.decision && followUp.assessment?.states.baseline === 'matched'
      && followUp.assessment.states.candidate === 'matched') contents.push('follow-up report and evidence');
    if (!item.invoice && followUp.resolved) contents.push('verified closure');
    const receiptOption = item.invoice && item.decision && original.verdict && followUp.originalInvoice?.checked;
    return `<details class="review-differences"><summary>Export review package or case</summary>
      <p class="panel-description">The download includes the original report${matching}.</p>
      ${contents.length ? `<p class="panel-description">The case download also includes the ${contents.join(', ')}.</p>` : ''}
      ${receiptOption ? `<p class="panel-description" id="invoice-export-help">Including invoice receipts adds the available original
        and follow-up receipt files and any verified closure to the case download. Execution receipts may contain logs.</p>` : ''}
      <div class="review-note-actions"><label><input type="checkbox" id="include-review-note" ${item.note ? '' : 'disabled'}> Include saved review note</label>
      ${receiptOption ? '<label><input type="checkbox" id="include-invoice-receipts" aria-describedby="invoice-export-help"> Include invoice receipts in case download</label>' : ''}
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
    if (!savingInvoice) updateInvoiceWorkflows();
    list.innerHTML = [...items].sort((a, b) => Number(a.reviewed) - Number(b.reviewed)
      || priority[a.report.status] - priority[b.report.status]).map(item => `<a class="chain-card review-card ${item.id === id ? 'selected' : ''}"
        href="${itemRoute(item.id)}" ${item.id === id ? 'aria-current="true"' : ''}>
        <span class="badge ${tones[item.report.status]}">${regressionLabels[item.report.status]}</span>
        ${item.invoice ? `<strong>${escape(item.invoice.evidence?.caseId ?? 'Invoice run')}</strong>` : ''}
        <code>${escape(item.report.candidateId ?? 'Run ID unavailable')}</code>
        ${item.invoice ? `<span class="muted">Output at import · ${escape(item.invoice.outputAtImport)}</span>` : ''}
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
      const followUp = await assessFollowUp(item, assessment, getStorage);
      const invoice = followUp.originalInvoice;
      const receiptResults = invoice?.checked ? invoiceMarkup(invoice.checked)
        : invoice?.error ? `<p class="import-error">${escape(invoice.error)}</p>` : '';
      if (currentRevision !== revision) return;
      const title = assessment.states.candidate === 'matched' ? item.candidate.title : 'Saved regression report';
      detail.innerHTML = `<div class="panel-heading"><h3>${escape(title)}</h3>
        <span class="badge ${tones[item.report.status]}">Reported · ${regressionLabels[item.report.status]}</span></div>
        ${item.invoice ? `<p class="panel-description">Pinned workflow · ${escape(item.invoice.workflow)}</p>` : ''}
        ${renderEvidence(item, assessment)}
        ${receiptResults}
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

  function receiptFileChecks(states) {
    return `<details class="review-differences receipt-file-checks"><summary>File checks against manifest</summary><dl>
      ${Object.entries(states).map(([name, state]) => `<div><dt>${escape(name)}</dt><dd>${receiptLabels[state]}</dd></div>`).join('')}
      </dl></details>`;
  }

  function invoiceMarkup({ caseId, authority, output, execution, receiptStates }) {
    const properties = entries => `<dl>${entries.map(([label, value]) =>
      `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>`;
    const panel = (title, check, body) => `<section class="compare-run" aria-label="${title}">
      <h4>${title}</h4><span class="badge ${check.tone}">${check.label}</span>${body}</section>`;
    const authorityBody = authority.runId ? properties([['Run', authority.runId], ['Completed actions', authority.actions]])
      + (authority.findings.length ? `<ul>${authority.findings.map(message => `<li>${escape(message)}</li>`).join('')}</ul>` : '')
      : '<p>Supply the matching investigation to check the recorded grants.</p>';
    const outputBody = output.totals ? properties(Object.entries(invoiceFields).map(([key, label]) => [label, output.totals[key]]))
      : `<p>${output.message}</p>`;
    const executionBody = [];
    if (execution.receipt) {
      const { status, exitCode, inputUnchanged, cleaned } = execution.receipt;
      executionBody.push(['Sandbox status', status], ['Exit code', exitCode ?? 'Unavailable'],
        ['Input unchanged', inputUnchanged ? 'Yes' : 'No'], ['Sandbox cleaned up', cleaned ? 'Yes' : 'No']);
    }
    if (execution.attempts) executionBody.push(['Allowed attempts', execution.attempts.allowed], ['Denied attempts', execution.attempts.denied]);
    return `<section class="invoice-results"><h3>Invoice run · ${escape(caseId)}</h3>
      <div class="invoice-checks">
      ${panel('Authority', authority, authorityBody)}
      ${panel('Output', output, outputBody)}
      ${panel('Execution', execution, executionBody.length ? properties(executionBody) : '<p>Supply matching execution and attempts receipts.</p>')}
      </div>
      ${receiptFileChecks(receiptStates)}</section>`;
  }

  function updateInvoiceWorkflows() {
    invoiceForm.hidden = !invoiceDraft?.candidate;
    if (invoiceForm.hidden) return;
    const selectedPin = invoiceWorkflow.value ? pins[Number(invoiceWorkflow.value)] : undefined;
    const saved = restoreWorkflowBaselines(getStorage);
    pins = saved.baselines.filter(pin => !pin.runId.startsWith('CH-'));
    invoiceWorkflow.innerHTML = '<option value="">Choose a saved workflow</option>' + pins.map((pin, index) =>
      `<option value="${index}">${escape(pin.name)} · ${escape(pin.runId)}</option>`).join('');
    const index = selectedPin ? pins.findIndex(pin => JSON.stringify(pin) === JSON.stringify(selectedPin)) : -1;
    if (index >= 0) invoiceWorkflow.value = String(index);
    invoiceWorkflow.disabled = !pins.length;
    invoiceSave.disabled = !invoiceWorkflow.value;
    invoiceHelp.textContent = saved.warning || (pins.length ? 'Saving keeps up to six receipt files, including any execution logs they contain, in this browser.'
      : 'Import a baseline investigation, then save it under a workflow in Compare runs.');
  }

  invoiceWorkflow.addEventListener('change', () => {
    invoiceSave.disabled = !invoiceWorkflow.value;
  });

  invoiceForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (savingInvoice || !invoiceWorkflow.value || !invoiceDraft?.candidate) return;
    const pin = pins[Number(invoiceWorkflow.value)];
    if (!pin) return;
    const currentRoute = location.hash;
    savingInvoice = true;
    invoiceInput.disabled = invoiceWorkflow.disabled = invoiceSave.disabled = true;
    invoiceStatus.classList.remove('import-error');
    invoiceStatus.textContent = 'Checking the pinned baseline and saving the case…';
    try {
      const id = await saveInvoiceCandidate(getStorage, pin, invoiceDraft.evidence);
      invoiceDraft = undefined;
      invoiceResults.replaceChildren();
      invoiceStatus.textContent = '';
      document.querySelector('#invoice-folder-import').open = false;
      announce('Invoice comparison and receipts saved in this browser.');
      if (location.hash === currentRoute) {
        if (location.hash === itemRoute(id)) render({ focus: true });
        else location.hash = itemRoute(id);
      }
    } catch (error) {
      invoiceStatus.classList.add('import-error');
      invoiceStatus.textContent = error.message;
    } finally {
      savingInvoice = false;
      invoiceInput.disabled = false;
      updateInvoiceWorkflows();
    }
  });

  if (!('webkitdirectory' in invoiceInput)) {
    invoiceInput.disabled = true;
    invoiceStatus.textContent = 'This browser does not support folder selection.';
  }

  invoiceInput.addEventListener('change', async () => {
    if (!invoiceInput.files.length) return;
    invoiceInput.disabled = true;
    invoiceResults.replaceChildren();
    invoiceDraft = undefined;
    updateInvoiceWorkflows();
    invoiceStatus.classList.remove('import-error');
    invoiceStatus.textContent = 'Checking invoice folder…';
    try {
      invoiceDraft = await importInvoiceFolder(invoiceInput.files);
      invoiceResults.innerHTML = invoiceMarkup(invoiceDraft);
      updateInvoiceWorkflows();
      invoiceStatus.textContent = 'Invoice folder checked. See the three results below.';
    } catch (error) {
      invoiceStatus.classList.add('import-error');
      invoiceStatus.textContent = error.message;
    } finally {
      invoiceInput.value = '';
      invoiceInput.disabled = false;
    }
  });

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
      if (item.invoice) {
        const { evidence } = await importInvoiceFolder(input.files);
        await attachInvoiceFollowUp(getStorage, item, evidence);
      } else {
        if (file.size > MAX_REVIEW_PACKAGE_BYTES) throw new Error('Choose a review package no larger than 2 MiB.');
        await attachReviewFollowUp(getStorage, item, await file.text());
      }
      announce('Follow-up saved.');
      if (location.hash === itemRoute(item.id)) await render();
    } catch (error) { announce(`Could not attach the follow-up. ${error.message}`, true); }
    finally { input.disabled = false; input.value = ''; }
  });

  detail.addEventListener('click', async event => {
    if (!selected) return;
    const targetId = event.target.dataset.closureTarget;
    if (targetId) {
      const target = targetId === 'review-import-link' ? packageInput : document.getElementById(targetId);
      if (!target) return;
      if (target.tagName === 'DETAILS') {
        target.open = true;
        const files = target.querySelector('.receipt-file-checks');
        if (files) files.open = true;
        (files ?? target).querySelector('summary').focus();
      } else if (target.id === 'compare-link') target.click();
      else target.focus();
      return;
    }
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
      const receiptCheckbox = detail.querySelector('#include-invoice-receipts');
      const includeInvoiceReceipts = Boolean(completeCase && receiptCheckbox?.checked);
      if (receiptCheckbox) receiptCheckbox.checked = false;
      event.target.disabled = true;
      try {
        const contents = completeCase ? await createReviewCase(item, note, { includeInvoiceReceipts })
          : await createReviewPackage(item.report, item, note);
        const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = completeCase ? 'review-case.json' : 'review-package.json';
        detail.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        const included = [note && 'saved note', includeInvoiceReceipts && 'invoice receipts'].filter(Boolean);
        announce(`${label} downloaded${included.length ? ' with ' + included.join(' and ') : ''}.`);
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
