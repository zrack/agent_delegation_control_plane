import { caseSummary } from './case-summary.mjs';
import { JOURNAL, writeLocal } from './backup-storage.mjs';
import { regressionLabels } from './comparison.mjs';
import { actionDirectory, actionLink, grantLookup, reviewRun } from './grant-lookup.mjs';
import { importCodexFolder } from './codex-import.mjs';
import { MAX_IMPORT_BYTES, parseInvestigation } from './import.mjs';
import { importInvoiceFolder, invoiceFields } from './invoice-import.mjs';
import { restoreWorkflowBaselines, workflowKey, WORKFLOW_BASELINE_KEY } from './storage.mjs';
import {
  adoptCodexBaseline, assessFollowUp, assessReview, attachCodexFollowUp, attachInvoiceFollowUp, attachReviewFollowUp, createReviewCase, createReviewPackage, importReview, importReviewPackage, importNewCodexCase, inspectCodexCaseImport, inspectCodexRunEvidence,
  MAX_REPORT_BYTES, REVIEW_STORAGE_KEY, MAX_REVIEW_NOTE, MAX_REVIEW_PACKAGE_BYTES, MAX_SENDER_HISTORY_ENTRIES, removeReview, resolveReviewCase,
  applyCodexOriginalRepair, previewCodexOriginalRepair, previewInvoiceEvidenceRestore, restoreInvoiceEvidence, restoreReviews, reviewClosureState, reviewDecisions, saveInvoiceCandidate, saveReview, saveReviewDecision, senderHistoryEntries,
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

function isCaseDetailRoute(id) {
  if (!location.hash.startsWith(reviewRoute)) return false;
  const params = new URLSearchParams(location.hash.slice(reviewRoute.length));
  return params.get('item') === id && !params.has('event') && !params.has('view');
}

// Describe the current recheck. These targets only open evidence or move focus.
export function codexClosureSteps(item, original, followUp, supportsFolders = true) {
  if (followUp.resolved || (item.report.status === 'pass' && !followUp.flagged && !item.decision && !original.error)) return [];
  if (followUp.canResolve) return [{
    label: 'Ready to close', reason: 'The original finding and passing follow-up verified against the matching pin.',
    action: 'Review the evidence, then select Close as resolved when you are ready.', target: 'resolve-review-case',
  }];

  const steps = [];
  const add = (label, reason, action, target) => steps.push({ label, reason, action, target });
  const followUpError = followUp.error?.replace(/^Follow-up Codex evidence: /, '');
  const freshCopy = 'Ask the sender for a clean case export with receipts. Import it in a fresh browser profile to keep this review.';
  if (original.error) {
    add('Original evidence', original.error, 'Choose a clean export of this case to preview matching original receipts.', 'codex-evidence-restore');
  } else if (!original.verdict) {
    const unmatched = ['baseline', 'candidate'].filter(side => original.states[side] !== 'matched');
    const reason = unmatched.length ? `The ${unmatched.join(' and ')} evidence does not match the original report.`
      : 'The original baseline comparison could not be reproduced.';
    add('Original comparison', reason, freshCopy);
  } else if (!followUp.flagged) {
    add('Original comparison', 'The current comparison shows no flagged result to close.', 'Check the original report and its evidence.');
  }

  const { status } = followUp.pinState;
  if (status === 'missing') {
    const canAdopt = original.codex && original.verdict;
    const action = canAdopt ? 'Inspect the included baseline and pin it if you accept it.'
      : 'Verify the original case evidence before pinning its baseline.';
    add('Baseline needed', `There is no local pin for “${item.codex.workflow}”.`, action, 'codex-included-baseline');
  } else if (status === 'conflict') {
    add('Conflicting baseline', `The current pin for “${item.codex.workflow}” differs from the case baseline.`,
      'Compare the run IDs and fingerprints. To review under the case baseline while keeping this pin, use a separate profile.',
      'codex-included-baseline');
  } else if (status === 'unreadable') {
    add('Workflow pin', 'Saved workflow pins could not be read.', 'Check this browser’s site storage and reopen the case.');
  }

  if (original.error) {
    // The original check failed. A separately detected follow-up error can still be reported.
    if (followUpError) add('Follow-up evidence', followUpError, 'After repairing the original receipts, attach a verified corrected folder.');
    return steps;
  }
  if (!item.decision) add('Decision needed', 'No review decision has been saved.', 'Choose a decision and save its reason.', 'review-decision');

  let correction;
  if (!item.followUp) correction = 'No corrected folder is attached.';
  else if (followUpError) correction = followUpError;
  else if (followUp.incompatible === 'baseline') correction = 'The follow-up references a different baseline.';
  else if (followUp.incompatible) correction = 'The corrected run could not be matched to this case.';
  else if (followUp.assessment?.verdict?.status !== 'pass' || item.followUp.report.status !== 'pass') {
    correction = 'The follow-up comparison does not reproduce a passing result.';
  }
  if (correction) {
    const canAttach = supportsFolders && item.decision && original.codex && followUp.flagged && status === 'matched';
    let action = 'Attach a verified corrected folder for the same task.';
    if (!supportsFolders) action = 'Use a browser with folder selection support to attach a verified corrected folder.';
    else if (!canAttach) action = 'Address the checks above, then attach a verified corrected folder for the same task.';
    add('Follow-up evidence', correction, action, canAttach ? 'review-follow-up-file' : undefined);
  }
  return steps;
}

const closureLabels = { resolved: 'Verified resolved', ready: 'Ready to close', blocked: 'Open · blocked', clear: 'No closure needed' };

export function reviewCardState(item, original, followUp) {
  const blocked = reason => ({ closure: 'blocked', reason });
  const closure = reviewClosureState(item, original, followUp);
  if (closure !== 'blocked') return { closure };
  if (original.error) return blocked(original.error);
  if (!original.verdict) {
    const sides = ['baseline', 'candidate'].filter(side => original.states?.[side] !== 'matched');
    return blocked(sides.length ? 'Verify the ' + sides.join(' and ') + ' evidence.' : 'The original comparison could not be reproduced.');
  }
  if (item.invoice && !followUp.originalInvoice?.checked) return blocked(followUp.originalInvoice?.error || 'Verify the original invoice receipts.');
  if (item.codex) {
    const [step] = codexClosureSteps(item, original, followUp);
    if (step) return blocked(step.label + ' · ' + step.reason);
  }
  if (followUp.pinChanged) {
    const status = followUp.pinState.status;
    return blocked(status === 'conflict' ? 'Conflicting baseline pin.' : status === 'missing' ? 'A matching workflow pin is needed.' : 'The workflow pin could not be read.');
  }
  if (!item.decision) return blocked('Save a decision and its reason.');
  if (!item.followUp) return blocked('Attach a corrected follow-up.');
  if (followUp.incompatible) return blocked('The follow-up does not match the original ' + followUp.incompatible + '.');
  if (followUp.error || followUp.invoice?.error) return blocked(followUp.error ?? followUp.invoice.error);
  if (item.invoice && followUp.invoice?.checked) {
    const { authority, output, execution } = followUp.invoice.checked;
    const failed = [authority, output, execution].find(lane => lane.tone !== 'valid');
    if (failed) return blocked('Follow-up receipt check · ' + failed.label);
  }
  return blocked('The follow-up and original evidence do not meet the closure checks.');
}

// Group reasons from one reproduced comparison. Keep the original rows for evidence lookup.
export function groupGrantFindings(reasons) {
  const findings = [];
  const missing = new Map();
  for (const reason of reasons) {
    const { row } = reason;
    const before = row?.before?.event;
    const after = row?.after?.event;
    const change = row?.changes.find(field => field.label === 'Referenced grant supplied');
    if (reason.impact !== 'review' || reason.message !== 'Referenced grant supplied'
      || change?.before !== true || change.after !== false || !before || !after
      || before.id !== row.eventLinks?.[0] || after.id !== row.eventLinks?.[1]
      || before.authorityId !== after.authorityId || before.actor !== after.actor
      || before.action.resource !== after.action.resource || before.action.action !== after.action.action
      || !row.after.findings?.some(f => f.code === 'GRANT_MISSING' && f.eventId === after.id && f.grantId === after.authorityId)) {
      findings.push(reason);
      continue;
    }
    const key = JSON.stringify([after.authorityId, after.actor, after.action.resource]);
    let finding = missing.get(key);
    if (!finding) {
      finding = { grantId: after.authorityId, actor: after.actor, resource: after.action.resource, rows: [] };
      missing.set(key, finding);
      findings.push(finding);
    }
    finding.rows.push(row);
  }
  return findings;
}

export function createReviewInbox({ getStorage, escape, comparisonDetail, onBaselineAdopted }) {
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
  let restoreDraft;
  let revision = 0;
  let records = [];
  let runs = {};

  const filters = document.querySelector('#review-filters');
  const controls = {
    workflow: document.querySelector('#review-workflow-filter'), decision: document.querySelector('#review-decision-filter'),
    closure: document.querySelector('#review-closure-filter'),
  };
  const filterKey = 'adcp.review-filters.v1';
  let choices = {};
  let queue = [];
  try {
    const saved = sessionStorage.getItem(filterKey);
    if (saved && saved.length <= 1024) {
      const values = JSON.parse(saved);
      for (const key of Object.keys(controls)) {
        if (typeof values?.[key] === 'string') choices[key] = values[key];
      }
    }
  } catch { /* All cases remain available if tab storage is unavailable. */ }

  const workflowOf = item => item.codex?.workflow ?? item.invoice?.workflow;
  const workflowValue = item => workflowOf(item) ? 'named:' + workflowKey(workflowOf(item)) : 'unnamed';

  function updateFilters(items) {
    filters.hidden = !items.length;
    const workflows = new Map(items.map(item => [workflowValue(item), workflowOf(item) ?? 'No recorded workflow']));
    controls.workflow.replaceChildren(new Option('All workflows', ''));
    for (const [value, label] of [...workflows].sort((a, b) => a[1].localeCompare(b[1]))) {
      controls.workflow.add(new Option(label, value));
    }
    for (const [name, control] of Object.entries(controls)) {
      control.value = choices[name] ?? '';
      if (control.selectedIndex < 0) control.value = '';
    }
  }

  function renderQueue() {
    const id = selected?.id;
    const workflow = controls.workflow.value;
    const decision = controls.decision.value;
    const closure = controls.closure.value;
    const visible = queue.filter(({ item, status }) => (!workflow || workflowValue(item) === workflow)
      && (!decision || (item.decision?.kind ?? 'none') === decision)
      && (!closure || closure === status.closure || (closure === 'open' && ['ready', 'blocked'].includes(status.closure))));
    const outside = id && !visible.some(({ item }) => item.id === id);
    document.querySelector('#review-filter-count').textContent = `Showing ${visible.length} of ${queue.length} saved cases.`
      + (outside ? ' The selected case is outside these filters.' : '');
    document.querySelector('#review-clear-filters').disabled = !workflow && !decision && !closure;
    list.innerHTML = visible.map(({ item, status }) => `<a class="chain-card review-card ${item.id === id ? 'selected' : ''}"
      href="${itemRoute(item.id)}" ${item.id === id ? 'aria-current="true"' : ''}>
      <span class="badge ${tones[item.report.status]}">Reported · ${regressionLabels[item.report.status]}</span>
      ${item.codex ? '<strong>Codex folder</strong>' : ''}
      ${item.invoice ? `<strong>${escape(item.invoice.evidence?.caseId ?? 'Invoice run')}</strong>` : ''}
      <code>${escape(item.report.candidateId ?? 'Run ID unavailable')}</code>
      <span class="case-closure">${closureLabels[status.closure]}</span>
      ${status.reason ? `<span class="muted">${escape(status.reason)}</span>` : ''}
      ${workflowOf(item) ? `<span>${escape(workflowOf(item))}</span>` : ''}
      ${item.invoice ? `<span class="muted">Output at import · ${escape(item.invoice.outputAtImport)}</span>` : ''}
      <span class="muted">${item.decision ? reviewDecisions[item.decision.kind] + ' · ' : ''}${item.reviewed ? 'Reviewed' : 'Unreviewed'}</span></a>`).join('');
  }

  function applyFilters() {
    choices = Object.fromEntries(Object.entries(controls).map(([name, control]) => [name, control.value]));
    try { sessionStorage.setItem(filterKey, JSON.stringify(choices)); }
    catch { announce('The filters apply to this view. This browser could not remember them after reload.', true); }
    renderQueue();
  }
  filters.addEventListener('change', applyFilters);
  document.querySelector('#review-clear-filters').addEventListener('click', () => {
    for (const control of Object.values(controls)) control.value = '';
    applyFilters();
    controls.workflow.focus();
  });

  function announce(message, error = false) {
    status.textContent = message;
    status.classList.toggle('import-error', error);
  }

  function finishImport({ id, mismatches, caseWarnings }, currentRoute) {
    const message = mismatches.length ? `Report saved. The selected ${mismatches.join(' and ')} evidence did not match and was not saved.`
      : 'Report saved in this browser.';
    announce([message, ...caseWarnings].join(' '), Boolean(mismatches.length || caseWarnings.length));
    if (location.hash !== currentRoute) return;
    if (isCaseDetailRoute(id)) render({ focus: true });
    else location.hash = itemRoute(id);
  }

  const inspectFile = document.querySelector('#codex-inspect-file');
  const inspectStatus = document.querySelector('#codex-inspect-status');
  const inspectResult = document.querySelector('#codex-inspect-result');
  const acceptPreview = document.querySelector('#codex-inspect-save');
  const cancelPreview = document.querySelector('#codex-inspect-cancel');
  let previewRequest = 0;
  let pendingImport;

  function clearImportPreview(message) {
    previewRequest++;
    pendingImport = undefined;
    inspectFile.value = '';
    inspectResult.replaceChildren();
    inspectStatus.textContent = message;
    acceptPreview.hidden = true;
    cancelPreview.hidden = true;
  }

  inspectFile.addEventListener('change', async () => {
    const file = inspectFile.files[0];
    clearImportPreview('');
    if (!file) return;
    const request = previewRequest;
    cancelPreview.hidden = false;
    inspectStatus.textContent = 'Checking the case and available inbox space…';
    try {
      if (file.size > MAX_REVIEW_PACKAGE_BYTES) throw new Error('Choose a case no larger than 2 MiB.');
      const contents = await file.text();
      const preview = await inspectCodexCaseImport(getStorage, contents);
      if (request !== previewRequest) return;
      pendingImport = { contents, pinState: preview.pinState };
      inspectResult.innerHTML = `<dl>
        <dt>Workflow</dt><dd>${escape(preview.workflow)}</dd>
        <dt>Required receiver baseline</dt><dd><code>${escape(preview.baselineId ?? 'Missing')}</code>
        <code>${escape(preview.fingerprint ?? 'Missing')}</code></dd>
        <dt>Receiver pin</dt><dd>${escape(preview.pinState.status)}</dd>
        <dt>Original receipts</dt><dd>${escape(preview.originalReceipts.join(', '))}</dd>
        <dt>Follow-up receipts</dt><dd>${escape(preview.followUpReceipts.join(', ') || 'None')}</dd>
        <dt>Sender history entries</dt><dd>${preview.senderEvents}</dd>
        <dt>Case after import</dt><dd>${escape(preview.disposition)}</dd></dl>`;
      inspectStatus.textContent = ['Preview only. The case has not been saved.', ...preview.warnings].join(' ');
      acceptPreview.hidden = false;
    } catch (error) {
      if (request === previewRequest) clearImportPreview(error.message + ' Choose another file or open an existing case.');
    }
  });
  cancelPreview.addEventListener('click', () => clearImportPreview('Preview canceled.'));
  acceptPreview.addEventListener('click', async () => {
    if (!pendingImport || acceptPreview.disabled) return;
    const route = location.hash;
    const { contents, pinState } = pendingImport;
    acceptPreview.disabled = inspectFile.disabled = cancelPreview.disabled = true;
    try {
      const imported = await writeLocal(importNewCodexCase, getStorage, contents, pinState);
      clearImportPreview('Case imported.');
      finishImport(imported, route);
    } catch (error) {
      clearImportPreview(error.message + ' Choose the file to preview it again.');
    } finally {
      acceptPreview.disabled = inspectFile.disabled = cancelPreview.disabled = false;
    }
  });

  function evidenceDetails(title, record, description = '') {
    const index = records.push(record) - 1;
    return `<details class="run-difference" data-review-evidence="${index}"><summary><strong>${escape(title)}</strong>
      <span class="muted">${escape(description)}</span></summary><div class="compare-detail"></div></details>`;
  }

  function missingGrantFinding(finding, candidateSide) {
    const actions = [...new Set(finding.rows.map(row => row.after.event.action.action))].join(', ');
    const sideLabel = candidateSide === 'follow-up' ? 'follow-up' : 'candidate';
    const links = finding.rows.map(({ before, after }) => `<li><strong>${escape(after.event.action.action)}</strong> ·
      ${actionLink(selected, 'baseline', before.event, escape)} · ${actionLink(selected, candidateSide, after.event, escape)}</li>`);
    return `<details class="run-difference grant-finding"><summary><strong>Missing grant <code>${escape(finding.grantId)}</code></strong>
      <span class="muted">${escape(finding.actor)} · ${escape(actions)} · ${escape(finding.resource)}</span></summary>
      <div class="compare-detail"><p>The baseline supplied this grant. The ${sideLabel} references it but omits the grant record.</p>
      <ul>${links.join('')}</ul></div></details>`;
  }

  function recordedReason(reason) {
    const refs = [];
    for (const side of ['baseline', 'candidate']) {
      for (const [field, label] of [['EventId', 'action'], ['GrantId', 'grant']]) {
        const id = reason[side + field];
        if (id) refs.push(`${side} ${label} <code>${escape(id)}</code>`);
      }
    }
    return `<li>${escape(reason.message)}${refs.length ? ' · ' + refs.join(' · ') : ''}</li>`;
  }

  function outputReceiptControl(check, stage) {
    const files = check?.codex?.evidence?.files;
    if (!files || !Object.hasOwn(files, 'after.md')) return '';
    const target = `codex-${stage}-output-receipt`;
    return `<button type="button" data-output-receipt="${stage}" aria-controls="${target}" aria-describedby="${target}-help">Go to ${stage} receipt for after.md</button>
      <p id="${target}-help" class="panel-description">Opens the saved file contents and SHA-256 in this case.</p>`;
  }

  function openOutputReceipt(stage) {
    if (stage !== 'original' && stage !== 'follow-up') return false;
    const receipt = detail.querySelector('#codex-' + stage + '-output-receipt');
    if (!receipt) return false;
    for (let group = receipt; group; group = group.parentElement?.closest('details')) group.open = true;
    receipt.querySelector('summary').focus();
    return true;
  }

  function restoreOutputReceipt(route, item) {
    if (!route.has('receipt')) return;
    const stage = route.get('receipt');
    const currentCapture = stage === 'original' || (stage === 'follow-up' && item.followUp && route.get('capture') === item.followUp.id);
    if (!currentCapture || !openOutputReceipt(stage)) history.replaceState(null, '', itemRoute(item.id));
  }

  function renderEvidence(item, assessment, candidateSide = 'candidate') {
    const { states, groups, candidateResult, verdict } = assessment;
    const evidence = `<dl class="review-evidence-status">${['baseline', 'candidate'].map(side => `<div>
      <dt>${side === 'baseline' ? 'Baseline' : 'Candidate'}</dt><dd><code>${escape(item.report[side + 'Id'] ?? 'No run ID')}</code>
      <span>${evidenceLabels[states[side]]}</span></dd></div>`).join('')}</dl>`;
    if (!verdict) return evidence + '<p class="panel-description">The verdict cannot be reproduced from the supplied exports. Use the original files to restore matching evidence.</p>';

    const reproduced = verdict.status === item.report.status;
    const explanation = reproduced ? 'The current check reproduced the reported verdict.'
      : 'The current check differs from the reported verdict. Review the matching evidence below.';
    const findings = runs[candidateSide] ? groupGrantFindings(verdict.reasons) : verdict.reasons;
    const reasons = findings.slice(0, 12).map(reason => {
      if (reason.rows) return missingGrantFinding(reason, candidateSide);
      if (reason.row) return evidenceDetails(reason.row.title, { row: reason.row, candidateSide }, reason.message);
      const chain = item.candidate;
      const event = chain.events.find(record => record.id === reason.eventId);
      const grant = chain.grants.find(record => record.id === event?.authorityId);
      const parentGrant = chain.grants.find(record => record.id === grant?.parentGrantId);
      const findings = candidateResult.findings.filter(finding => finding.eventId === (event?.id ?? null));
      return evidenceDetails(event?.label ?? 'Candidate assessment', { candidateSide, snapshot: {
        event, grant: grant ?? null, parentGrant: parentGrant ?? null, findings,
      } }, reason.message);
    });
    const differences = Object.entries(groups).filter(([, rows]) => rows.length).map(([group, rows]) =>
      `<h4>${escape(group[0].toUpperCase() + group.slice(1))}</h4>${rows.map(row => evidenceDetails(row.title, { row, candidateSide },
        row.changes.map(change => change.label).join(' · ') || 'Only supplied in one run')).join('')}`).join('');
    return `${evidence}<section class="assessment review-verdict ${tones[verdict.status]}">
      <div><strong>${item.invoice ? 'Baseline regression' : 'Current evidence check'} · ${regressionLabels[verdict.status]}</strong><p>${explanation}</p>
      ${candidateSide === 'candidate' && !item.followUp ? outputReceiptControl(assessment, 'original') : ''}</div></section>
      ${reasons.length ? `<h4>Flagged findings</h4>${reasons.join('')}` : ''}
      ${findings.length > 12 ? `<p>Showing 12 of ${findings.length} findings. See all comparison differences below.</p>` : ''}
      ${differences ? `<details class="review-differences"><summary>All comparison differences</summary>${differences}</details>` : ''}`;
  }

  function invoiceClosureChecklist(item, original, followUp) {
    const { report, suppliedBaseline, invoice } = item;
    const { pinState, assessment, incompatible, passes } = followUp;
    const checks = [];
    const targetLabels = {
      'invoice-evidence-restore': 'Restore matching evidence', 'compare-link': 'Open Compare runs',
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
    const repairTarget = item.decision ? 'invoice-evidence-restore' : 'review-decision';
    const reimport = 'Choose a portable copy with the original baseline and candidate evidence.';
    const attach = 'Attach the original corrected folder for this invoice case. Pin the original baseline first if needed.';
    if (original.states.baseline !== 'matched') {
      const supplied = suppliedBaseline ? identify('Supplied baseline', suppliedBaseline.runId, suppliedBaseline.fingerprint) : '';
      row('Baseline evidence', suppliedBaseline || original.states.baseline === 'mismatch' ? 'Baseline mismatch' : 'Baseline missing',
        reimport, repairTarget, expected + supplied);
    } else {
      row('Baseline evidence', 'Matches the saved case');
    }
    if (original.states.candidate !== 'matched') {
      row('Candidate evidence', evidenceLabels[original.states.candidate], reimport, repairTarget);
    } else if (original.states.baseline === 'matched' && !original.verdict) {
      row('Baseline comparison', 'The saved evidence cannot reproduce the comparison', reimport, repairTarget);
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
      row('Original receipts', 'Saved invoice snapshot could not be verified', reimport, repairTarget);
    }
    if (!item.followUp) {
      row('Follow-up evidence', 'Corrected folder needed', attach, item.decision ? 'review-follow-up-file' : 'review-decision');
    } else if (incompatible) {
      row('Follow-up evidence', incompatible === 'baseline' ? 'Follow-up references a different baseline' : 'Follow-up candidate differs',
        'Choose a portable copy with a follow-up checked against the original baseline.', repairTarget);
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
        row('Follow-up evidence', reason, 'Restore a matching portable copy or attach the original corrected folder.',
          'invoice-follow-up-evidence');
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

  function decisionForm(item) {
    return `<form id="review-decision-form">
        <label for="review-decision">Decision</label>
        <select id="review-decision" required><option value="">Choose a decision</option>${Object.entries(reviewDecisions).map(([kind, label]) =>
          `<option value="${kind}" ${item.decision?.kind === kind ? 'selected' : ''}>${label}</option>`).join('')}</select>
        <label for="review-decision-reason">Reason for decision</label>
        <textarea id="review-decision-reason" rows="2" maxlength="${MAX_REVIEW_NOTE}" required>${escape(item.decision?.reason ?? '')}</textarea>
        <button type="submit">Save decision</button>
      </form>`;
  }

  function codexFileRow(evidence, side, name) {
    const { hashes, files } = evidence;
    const retained = Object.hasOwn(files, name);
    const isOutput = name === 'after.md' && retained;
    const receiptId = 'codex-' + side + '-output-receipt';
    const stageLabel = side === 'original' ? 'Original' : 'Follow-up';
    const summary = `${isOutput ? stageLabel + ' output receipt · ' : ''}<code>${escape(name)}</code> · ${retained ? 'Rechecked from saved bytes' : 'Verified at import only'}`;
    const hash = escape(hashes[name]);
    return retained ? `<details ${isOutput ? `id="${receiptId}"` : ''} class="run-difference" data-codex-file="${escape(name)}" data-codex-side="${side}" data-file-index="${records.push(files[name]) - 1}">
      <summary${isOutput ? ` aria-describedby="${receiptId}-sha"` : ''}>${summary}</summary><code class="receipt-digest"${isOutput ? ` id="${receiptId}-sha"` : ''}>SHA-256 ${hash}</code><pre tabindex="0"></pre></details>`
      : `<div class="codex-digest-only">${summary}<code class="receipt-digest">SHA-256 ${hash}</code></div>`;
  }

  function codexFolderEvidence({ codex, candidateResult }, side = 'original') {
    const heading = side === 'original' ? 'codex-evidence-title' : 'codex-follow-up-title';
    const stageLabel = side === 'original' ? 'Original' : 'Follow-up';
    const filenames = Object.keys(codex.evidence.hashes);
    const grants = candidateResult.findings.filter(finding => finding.code === 'GRANT_MISSING');
    const missing = grants.map(({ eventId, grantId }) => {
      const event = codex.chain.events.find(record => record.id === eventId);
      if (!event) return '';
      return evidenceDetails(event.label, { snapshot: { event, missingGrantId: grantId } },
        `${event.action.action} · Missing grant ${grantId}`);
    });
    const rows = filenames.map(name => codexFileRow(codex.evidence, side, name));
    return `<section class="invoice-results" aria-labelledby="${heading}">
      <h4 id="${heading}">${side === 'original' ? 'Codex folder evidence' : 'Corrected Codex folder evidence'}</h4>
      <p>The capture manifest lists ${filenames.length} files.
        ${codex.verifiedFileCount} saved files passed the current receipt check.</p>
      ${missing.length ? '<h4>Actions with missing grants</h4>' + missing.join('') : ''}
      <details class="review-differences"><summary>Inspect files and digests · ${stageLabel} run</summary>${rows.join('')}</details></section>`;
  }

  function senderActionClaims(evidence, stage) {
    if (!evidence) return '<p>The candidate investigation is unavailable for this stage.</p>';
    const edits = evidence.claims?.filter(claim => claim.receipt === 'after.md');
    if (!edits) return '<p>The sender’s candidate investigation could not be matched to this run’s report. Action and grant details are unavailable.</p>';
    const source = stage === 'original' ? 'candidate.chain' : 'followUp.candidate.chain';
    const sourceNote = `<p class="panel-description">The packaged candidate investigation records actions in <code>${source}.events</code> and grants in <code>${source}.grants</code>.</p>`;
    if (!edits.length) return sourceNote + '<p>The investigation has no recorded edit associated with <code>after.md</code>.</p>';
    return sourceNote + edits.map(claim => `<dl class="codex-claim-fields">
      <dt>Action</dt><dd><code>${escape(claim.action)}</code> by <code>${escape(claim.actor)}</code></dd>
      <dt>Target</dt><dd><code>${escape(claim.target)}</code></dd>
      <dt>Referenced grant</dt><dd><code>${escape(claim.grantId)}</code></dd>
      <dt>Grant record</dt><dd>${claim.grant ? `The supplied grant names <code>${escape(claim.grant.issuer)}</code> as issuer and <code>${escape(claim.grant.subject)}</code> as subject.`
        : 'Missing from the sender’s grant records.'}</dd>
      <dt>Action record</dt><dd><code>${escape(claim.eventId)}</code></dd>
      <dt>Output receipt for this edit</dt><dd><code>${escape(claim.receipt)}</code></dd>
    </dl>`).join('');
  }

  function receiverReceiptChecks(evidence, assessment, error, stage) {
    const label = stage === 'original' ? 'Original' : 'Follow-up';
    let result;
    if (error) {
      const consequence = stage === 'original' ? 'Closure requires the receiver to reproduce the original finding.'
        : 'Closure requires a verified passing follow-up.';
      result = `<p><strong>${label} verification failed.</strong> ${escape(error)} ${consequence}</p>`;
    } else if (assessment?.codex && assessment.verdict) {
      result = `<p><strong>${label} comparison rechecked</strong> · ${regressionLabels[assessment.verdict.status]}.</p>`;
    } else {
      result = `<p>The receiver could not reproduce the ${stage} comparison.</p>`;
    }
    if (!evidence?.checks?.length) return result + '<p>Individual receipt checks are unavailable.</p>';
    const receiptRow = receipt => `<li><strong><code>${escape(receipt.name)}</code> · ${receiptLabels[receipt.status]}</strong>
      ${receipt.expected ? `<p>Manifest SHA-256 <code>${escape(receipt.expected)}</code></p>` : ''}
      ${receipt.actual ? `<p>Received bytes SHA-256 <code>${escape(receipt.actual)}</code></p>` : ''}</li>`;
    const failed = evidence.checks.filter(receipt => receipt.status !== 'matched');
    const matched = evidence.checks.filter(receipt => receipt.status === 'matched');
    return result + (failed.length ? `<ul class="codex-receipt-checks failed">${failed.map(receiptRow).join('')}</ul>` : '')
      + (matched.length ? `<details class="review-differences"><summary>Matching receipts · ${matched.length} of ${evidence.checks.length}</summary>
        <ul class="codex-receipt-checks">${matched.map(receiptRow).join('')}</ul></details>` : '');
  }

  async function damagedCodexEvidence(item, original, followUp) {
    if (!item.codex || (!original.error && !followUp.error)) return '';
    const stages = item.followUp ? ['original', 'follow-up'] : ['original'];
    const panels = await Promise.all(stages.map(async stage => {
      // Preserve the other stage and the repair controls if this inspection fails.
      const evidence = await inspectCodexRunEvidence(item, stage).catch(() => undefined);
      const heading = 'codex-' + stage + '-evidence-title';
      const label = stage === 'original' ? 'Original' : 'Follow-up';
      const check = stage === 'original' ? original : followUp.assessment;
      const error = stage === 'original' ? original.error : followUp.error?.replace(/^Follow-up Codex evidence: /, '');
      // The blocked-original view has no comparison panels. Its follow-up can
      // expose saved bytes only after both its own check and the task match.
      const inspectable = !error && (stage === 'original' || evidence?.matchesOriginalTask);
      const control = inspectable ? outputReceiptControl(check, stage) : '';
      const followUpReceipt = stage === 'follow-up' && control
        ? '<p>The original evidence must verify before this case can close.</p>' + codexFileRow(check.codex.evidence, stage, 'after.md') : '';
      return `<section class="codex-stage-evidence" aria-labelledby="${heading}">
        <h4 id="${heading}">${label} run evidence</h4>
        ${evidence?.runId ? `<p class="panel-description">Run <code>${escape(evidence.runId)}</code></p>` : ''}
        <section aria-labelledby="${heading}-sender"><h5 id="${heading}-sender">Sender-reported action and grant</h5>
          ${senderActionClaims(evidence, stage)}</section>
        <section aria-labelledby="${heading}-receiver"><h5 id="${heading}-receiver">Receiver checks</h5>
          ${receiverReceiptChecks(evidence, check, error, stage)}
          ${control}${followUpReceipt}</section>
      </section>`;
    }));
    return panels.join('');
  }

  function codexChecklist(item, original, followUp) {
    const steps = codexClosureSteps(item, original, followUp, 'webkitdirectory' in invoiceInput);
    if (!steps.length) return '';
    const links = {
      'resolve-review-case': 'Go to close button', 'review-decision': 'Go to decision',
      'review-follow-up-file': 'Go to corrected folder picker', 'codex-included-baseline': 'Inspect baseline details',
      'codex-evidence-restore': 'Preview original receipt repair',
    };
    const rows = steps.map(step => `<li><strong>${escape(step.label)}</strong> · ${escape(step.reason)}
      <p>${escape(step.action)} ${step.target ? `<button type="button" data-closure-target="${step.target}">${links[step.target]}</button>` : ''}</p></li>`);
    return `<section class="closure-checklist" aria-labelledby="codex-closure-title">
      <h4 id="codex-closure-title">Closure checklist</h4><ul id="codex-closure-reasons">${rows.join('')}</ul></section>
      ${codexPinDetails(item, original, followUp.pinState)}`;
  }

  function codexPinDetails(item, original, pinState) {
    if (pinState.status === 'matched' || pinState.status === 'unreadable') return '';
    const pin = pinState.pin;
    const pinLabel = pin ? 'Inspect case baseline and conflicting pin' : 'Inspect included baseline';
    const canAdopt = !pin && original.codex && original.verdict;
    const identity = (label, id, fingerprint) => `<div class="compare-run"><strong>${escape(label)}</strong>
      <p><code>${escape(id)}</code></p><p class="receipt-digest">SHA-256 ${escape(fingerprint)}</p></div>`;
    return `<details id="codex-included-baseline" class="review-differences">
      <summary>${pinLabel}</summary>
      <p>Workflow · <strong>${escape(item.codex.workflow)}</strong></p>
      <div class="compare-sides">
        ${identity('Case baseline', item.report.baselineId, item.report.baselineFingerprint)}
        ${pin ? identity('Current local pin', pin.runId, pin.fingerprint) : ''}
      </div>
      ${original.states?.baseline === 'matched' ? evidenceDetails('Baseline actions and grants', { snapshot: item.baseline }, item.baseline.title) : ''}
      ${canAdopt ? '<p>Pinning saves this baseline in this browser and rechecks the case against it.</p><button type="button" id="adopt-codex-baseline">Pin included baseline</button>' : ''}
    </details>`;
  }

  function evidenceRestorePanel(item) {
    const kind = item.codex ? 'codex' : 'invoice';
    const summary = item.codex ? 'Restore original Codex receipts' : 'Restore matching evidence';
    return `<details class="review-differences" id="${kind}-evidence-restore">
      <summary>${summary}</summary>
      <p class="panel-description">Choose a portable copy of this case exported with receipts to preview matching replacements.</p>
      ${item.codex ? `<p>Workflow · ${escape(item.codex.workflow)}</p><p>Original run · <code>${escape(item.report.candidateId)}</code></p>` : ''}
      <label for="${kind}-restore-file">Matching ${item.codex ? 'Codex' : 'invoice'} review case</label>
      <input id="${kind}-restore-file" data-preview-restore="${kind}" type="file" accept=".json,application/json" aria-describedby="${kind}-restore-status">
      <p class="panel-description" id="${kind}-restore-status" role="status"></p>
      <button id="apply-${kind}-restore" data-apply-restore="${kind}" type="button" disabled>${item.codex ? 'Apply receipt repair' : 'Apply evidence repair'}</button>
      ${item.codex ? '<button id="cancel-codex-restore" type="button" hidden>Cancel preview</button>' : ''}
    </details>`;
  }

  function codexHistoryEntries(entries) {
    return entries.map(entry => {
      const time = new Date(entry.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' });
      let label, details;
      if (entry.kind === 'repair') {
        label = 'Original receipts repaired';
        details = entry.files.map(file => {
          const before = file.before === 'missing' ? 'File was missing'
            : file.before === 'unreadable' ? 'Previous bytes were unreadable' : `<code>${escape(file.before)}</code>`;
          return `<p><strong>${escape(file.name)}</strong></p><dl>
            <dt>Before SHA-256</dt><dd>${before}</dd>
            <dt>After SHA-256</dt><dd><code>${escape(file.after)}</code></dd></dl>`;
        }).join('');
      } else {
        label = 'Case explicitly closed';
        details = `<dl><dt>Pinned baseline</dt><dd><code>${escape(entry.baselineId)}</code></dd>
          <dt>Baseline SHA-256</dt><dd><code>${escape(entry.baselineFingerprint)}</code></dd>
          <dt>Passing follow-up</dt><dd><code>${escape(entry.followUpId)}</code></dd>
          <dt>Follow-up SHA-256</dt><dd><code>${escape(entry.followUpFingerprint)}</code></dd></dl>`;
      }
      return `<li class="codex-history-entry"><strong>${label}</strong>
        <time datetime="${escape(entry.at)}">${escape(time)}</time>${details}</li>`;
    }).join('');
  }

  function codexHistory(item) {
    if (!item.codex) return '';
    const sender = item.senderHistory?.entries;
    return `<section class="codex-history" id="codex-local-history" aria-labelledby="codex-history-title">
      <h3 id="codex-history-title">Local repair history</h3>
      ${item.localHistory?.length ? `<ol>${codexHistoryEntries(item.localHistory)}</ol>` : '<p class="muted">No local repairs or closures recorded.</p>'}</section>
      <section class="codex-history" id="codex-sender-history" aria-labelledby="codex-sender-history-title">
        <h3 id="codex-sender-history-title">Sender-reported history</h3>
        ${sender?.length ? `<p class="panel-description">These events and prior receipt digests come from the sender. This browser checks the case evidence and your workflow pin to determine the current status.</p>
          <ol>${codexHistoryEntries(sender)}</ol>`
          : '<p class="muted">No sender-reported repair or closure events are available for this case. Whether the sender made a repair is unknown.</p>'}</section>`;
  }

  function renderCase(item, original, followUp) {
    if (item.report.status === 'pass' && !followUp.flagged && !item.decision) return '';
    const { assessment, canResolve, pinChanged, resolved } = followUp;
    const comparison = (label, record, check, stage, error) => `<div class="compare-run"><h3>${label}</h3>
      <code>${escape(record.report.candidateId ?? 'No run ID')}</code>
      <p class="panel-description">${error ? 'Sender-reported' : 'Reported'} · ${regressionLabels[record.report.status]}</p>
      <p class="panel-description">${error ? `Receiver check failed · ${escape(error)}` :
        check?.verdict ? `Rechecked · ${regressionLabels[check.verdict.status]}` : 'Evidence check unavailable'}</p>
      ${!followUp.error && (stage === 'original' || !followUp.incompatible) ? outputReceiptControl(check, stage) : ''}</div>`;
    const nextStep = (item.invoice || item.codex) && !resolved ? '' : resolved ? 'The saved follow-up still passes against the original baseline.'
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
    const label = item.codex ? 'Attach corrected Codex folder' : item.invoice ? 'Attach follow-up invoice folder' : 'Attach follow-up package';
    const folder = item.codex || item.invoice;
    const picker = folder ? 'webkitdirectory' : 'accept=".json,application/json"';
    const folderUnsupported = folder && !('webkitdirectory' in invoiceInput);
    const canAttach = item.decision && !folderUnsupported && (!item.codex || (!pinChanged && original.codex && followUp.flagged));
    return `<section class="review-case" aria-labelledby="review-case-title">
      <div class="panel-heading"><h3 id="review-case-title">Review decision and follow-up</h3>
        <span class="badge ${resolved ? 'valid' : 'unknown'}">${resolved ? 'Resolved' : 'Open'}</span></div>
      ${item.invoice && !resolved ? invoiceClosureChecklist(item, original, followUp) : ''}
      ${decisionForm(item)}
      <label for="review-follow-up-file">${label}</label>
      <input id="review-follow-up-file" type="file" ${picker} aria-describedby="${item.codex && !resolved ? 'codex-closure-reasons' : 'review-case-help'}" ${canAttach ? '' : 'disabled'}>
      ${item.followUp ? `<div class="compare-sides review-case-verdicts">${comparison('Original run', item, original, 'original')}
        ${comparison('Follow-up run', item.followUp, assessment, 'follow-up', followUp.error)}</div>
        ${receiptSummary}
        ${assessment || receiptDetails ? `<details class="review-differences" id="${item.codex ? 'codex-follow-up-evidence' : 'invoice-follow-up-evidence'}"><summary>Inspect follow-up evidence</summary>
          ${assessment ? renderEvidence(item.followUp, assessment, 'follow-up') + followUpRecords : ''}${receiptDetails}
          ${assessment?.codex && !followUp.incompatible ? codexFolderEvidence(assessment, 'follow-up') : ''}</details>` : ''}` : ''}
      ${item.invoice && !resolved && item.decision ? evidenceRestorePanel(item) : ''}
      <p id="review-case-help" class="panel-description">${folderUnsupported ? 'Use a browser with folder selection support to attach a follow-up.' : nextStep}</p>
      <button type="button" id="resolve-review-case" ${canResolve && !resolved ? '' : 'disabled'}>Close as resolved</button>
    </section>`;
  }

  function renderExport(item, original, followUp) {
    const evidence = ['baseline', 'candidate'].filter(side => original.states[side] === 'matched');
    const matching = evidence.length ? ` and matching ${evidence.join(' and ')} evidence` : '';
    const contents = [];
    if (item.decision) contents.push('saved decision and reason');
    if (!item.invoice && !item.codex && item.decision && followUp.assessment?.states.baseline === 'matched'
      && followUp.assessment.states.candidate === 'matched') contents.push('follow-up report and evidence');
    if (!item.invoice && !item.codex && followUp.resolved) contents.push('verified closure');
    const receiptOption = item.invoice && item.decision && original.verdict && followUp.originalInvoice?.checked;
    const codexReceiptOption = Boolean(item.codex && item.decision && original.codex && original.verdict);
    const historyOption = codexReceiptOption && senderHistoryEntries(item).length > 0;
    return `<details class="review-differences"><summary>Export review package or case</summary>
      <p class="panel-description">The download includes the original report${matching}.</p>
      ${codexReceiptOption ? '<p class="panel-description" id="codex-export-help">Including receipts adds the saved Codex ledgers and before/after files for the original and any verified follow-up. They can contain source text and tool-call details. A resolved case also includes its verifiable closure.</p>' : ''}
      ${historyOption ? `<p class="panel-description" id="sender-history-export-help">Select Codex receipts to enable sender history. It shares this profile’s repairs to original receipts and explicit closures for the attached follow-up, up to the ${MAX_SENDER_HISTORY_ENTRIES} most recent events. Entries include times, filenames, digests and run IDs.</p>` : ''}
      ${contents.length ? `<p class="panel-description">The case download also includes the ${contents.join(', ')}.</p>` : ''}
      ${receiptOption ? `<p class="panel-description" id="invoice-export-help">Including invoice receipts adds the available original
        and follow-up receipt files and any verified closure to the case download. Execution receipts may contain logs.</p>` : ''}
      <div class="review-note-actions"><label><input type="checkbox" id="include-review-note" ${item.note ? '' : 'disabled'}> Include saved review note</label>
      ${codexReceiptOption ? '<label><input type="checkbox" id="include-codex-receipts" aria-describedby="codex-export-help"> Include Codex receipts in case download</label>' : ''}
      ${historyOption ? '<label><input type="checkbox" id="include-sender-history" aria-describedby="sender-history-export-help" disabled> Include sender repair history</label>' : ''}
      ${receiptOption ? '<label><input type="checkbox" id="include-invoice-receipts" aria-describedby="invoice-export-help"> Include invoice receipts in case download</label>' : ''}
      <button type="button" id="download-review-package">Download review package</button>
      ${item.decision ? '<button type="button" id="download-review-case">Download review case</button>' : ''}</div></details>`;
  }

  function summaryPanel(item, assessment, followUp, closure) {
    const preview = caseSummary(item, assessment, followUp, closure);
    return `<details class="review-differences"><summary>Preview PR summary</summary>
      <label for="review-summary-text">Text to copy</label>
      <textarea id="review-summary-text" rows="9" readonly spellcheck="false">${escape(preview)}</textarea>
      <button type="button" id="copy-review-summary">Copy summary</button>
      <p id="review-summary-status" role="status"></p></details>`;
  }

  async function recheck(item) {
    const assessment = await assessReview(item).catch(error => {
      if (item.codex) return { error: error.message };
      throw error;
    });
    const followUp = await assessFollowUp(item, assessment, getStorage);
    return { assessment, followUp, status: reviewCardState(item, assessment, followUp) };
  }

  function blockedCodexView(item, message, explanation) {
    return `<section class="review-case"><h3><span class="badge unknown">Open</span> · ${escape(message)}</h3>
      ${explanation}
      ${item.decision ? `<p id="codex-blocked-decision"><strong>Previously saved decision</strong> · ${escape(reviewDecisions[item.decision.kind])} · ${escape(item.decision.reason)}</p>` : ''}
      ${item.note ? `<p>Saved review note · ${escape(item.note)}</p>` : ''}
      <button type="button" id="resolve-review-case" disabled>Close as resolved</button></section>
      ${codexHistory(item)}
      <button type="button" id="remove-review">Remove from inbox</button>`;
  }

  async function render({ focus = false } = {}) {
    const currentRevision = ++revision;
    const { items, warning } = restoreReviews(getStorage);
    const route = new URLSearchParams(location.hash.slice(reviewRoute.length));
    const id = route.get('item');
    selected = items.find(item => item.id === id);
    restoreDraft = undefined;
    records = [];
    runs = {};
    if (warning) announce(warning, true);
    if (!savingInvoice) updateInvoiceWorkflows();
    queue = [];
    updateFilters(items);
    list.replaceChildren();
    document.querySelector('#review-filter-count').textContent = items.length ? 'Checking saved cases…' : '';
    detail.innerHTML = selected ? '<p class="muted">Checking the saved evidence…</p>' : '';
    if (focus && selected) detail.focus();
    const rows = [];
    let selectedChecks;
    for (const item of [...items].sort((a, b) => Number(a.reviewed) - Number(b.reviewed) || priority[a.report.status] - priority[b.report.status])) {
      try {
        const checked = await recheck(item);
        rows.push({ item, status: checked.status });
        if (item.id === id) selectedChecks = checked;
      } catch (error) {
        rows.push({ item, status: { closure: 'blocked', reason: 'Verification failed · ' + error.message } });
        if (item.id === id) selectedChecks = { error };
      }
      if (currentRevision !== revision) return;
    }
    queue = rows;
    renderQueue();
    if (!selected) {
      detail.innerHTML = `<p class="muted">${id ? 'This report is unavailable in this browser.'
        : items.length ? 'Select a report to inspect its evidence and record your review.' : 'No saved reports yet. Import an offline regression report to get started.'}</p>`;
      return;
    }
    const item = selected;
    try {
      if (selectedChecks.error) throw selectedChecks.error;
      const { assessment, followUp } = selectedChecks;
      const invoice = followUp.originalInvoice;
      const receiptResults = invoice?.checked ? invoiceMarkup(invoice.checked)
        : invoice?.error ? `<p class="import-error">${escape(invoice.error)}</p>` : '';
      if (currentRevision !== revision) return;
      const checklist = item.codex ? codexChecklist(item, assessment, followUp) : '';
      const damagedEvidence = await damagedCodexEvidence(item, assessment, followUp);
      if (currentRevision !== revision) return;
      if (assessment.error) {
        detail.innerHTML = blockedCodexView(item, 'Original Codex evidence could not be verified', checklist + damagedEvidence + evidenceRestorePanel(item))
          + summaryPanel(item, assessment, followUp, selectedChecks.status.closure);
        restoreOutputReceipt(route, item);
        return;
      }
      for (const side of ['baseline', 'candidate', 'follow-up']) runs[side] = reviewRun(item, assessment, followUp, side);
      const lookupSide = route.get('side');
      const lookupEvent = route.get('event');
      if (lookupEvent !== null && route.get('view') !== 'actions') {
        const sameCapture = lookupSide !== 'follow-up' || (item.followUp && route.get('capture') === item.followUp.id);
        const run = sameCapture && Object.hasOwn(runs, lookupSide) ? runs[lookupSide] : undefined;
        detail.innerHTML = grantLookup(item, run, lookupSide, lookupEvent, route.get('grant'), escape);
        detail.querySelector('#grant-lookup-title').focus();
        return;
      }
      const title = assessment.states.candidate === 'matched' ? item.candidate.title : 'Saved regression report';
      detail.innerHTML = `<div class="panel-heading"><h3>${escape(title)}</h3>
        <span class="badge ${tones[item.report.status]}">Reported · ${regressionLabels[item.report.status]}</span></div>
        ${item.invoice || item.codex ? `<p class="panel-description">${item.codex ? 'Case workflow' : 'Pinned workflow'} · ${escape((item.invoice ?? item.codex).workflow)}</p>` : ''}
        ${checklist}
        ${damagedEvidence}
        ${renderEvidence(item, assessment)}
        ${actionDirectory(item, runs, escape)}
        ${receiptResults}
        ${assessment.codex ? codexFolderEvidence(assessment) : ''}
        ${item.report.reasons.length ? `<details class="review-differences"><summary>Reasons recorded by the offline report</summary>
          <ul>${item.report.reasons.slice(0, 12).map(recordedReason).join('')}</ul>
          ${item.report.reasons.length > 12 ? `<p>Showing 12 of ${item.report.reasons.length} recorded reasons.</p>` : ''}</details>` : ''}
        ${renderCase(item, assessment, followUp)}
        ${codexHistory(item)}
        <form id="review-note-form">
          <label for="review-note">Review note</label>
          <textarea id="review-note" rows="3" maxlength="${MAX_REVIEW_NOTE}">${escape(item.note)}</textarea>
          <div class="review-note-actions"><label><input type="checkbox" id="review-complete" ${item.reviewed ? 'checked' : ''}> Mark as reviewed</label>
          <button type="submit">Save review</button><button type="button" id="remove-review">Remove from inbox</button></div>
        </form>
        ${summaryPanel(item, assessment, followUp, selectedChecks.status.closure)}
        ${renderExport(item, assessment, followUp)}`;
      restoreOutputReceipt(route, item);
      if (lookupEvent && route.get('view') === 'actions') {
        const directory = detail.querySelector('#review-action-directory');
        const link = [...(directory?.querySelectorAll('a') ?? [])].find(anchor =>
          anchor.dataset.grantSide === lookupSide && anchor.dataset.grantEvent === lookupEvent);
        if (link) {
          directory.open = true;
          link.focus();
          history.replaceState(null, '', itemRoute(item.id));
        }
      }
    } catch (error) {
      if (currentRevision !== revision) return;
      const message = `<p class="import-error">${escape(error.message)}</p>`;
      detail.innerHTML = item.codex ? blockedCodexView(item, 'Case verification could not finish',
        message + '<p>Check the case export and reopen it in a fresh profile.</p>')
        : message + '<button type="button" id="remove-review">Remove from inbox</button>';
    }
  }

  window.addEventListener('storage', event => {
    if ([WORKFLOW_BASELINE_KEY, REVIEW_STORAGE_KEY, JOURNAL, null].includes(event.key) && location.hash.startsWith(reviewRoute)) render();
  });

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
      const id = await writeLocal(saveInvoiceCandidate, getStorage, pin, invoiceDraft.evidence);
      invoiceDraft = undefined;
      invoiceResults.replaceChildren();
      invoiceStatus.textContent = '';
      document.querySelector('#invoice-folder-import').open = false;
      announce('Invoice comparison and receipts saved in this browser.');
      if (location.hash === currentRoute) {
        if (isCaseDetailRoute(id)) render({ focus: true });
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
      finishImport(await writeLocal(importReviewPackage, getStorage, await file.text()), currentRoute);
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
      const imported = await writeLocal(importReview, getStorage, await file.text(), evidence);
      form.reset();
      document.querySelector('#review-import-controls').open = false;
      finishImport(imported, currentRoute);
    } catch (error) {
      announce(`Could not import the report. ${error.message}`, true);
    } finally { button.disabled = false; }
  });

  detail.addEventListener('toggle', event => {
    const element = event.target;
    if (!element.open) return;
    if (element.matches('details[data-codex-file]')) {
      const pre = element.querySelector('pre');
      if (!pre.hasChildNodes()) {
        const encoded = records[Number(element.dataset.fileIndex)];
        if (typeof encoded !== 'string') return;
        const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
        try { pre.textContent = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { pre.textContent = 'Binary content. Inspect the original file to read these bytes.'; }
      }
      return;
    }
    if (!element.matches('details[data-review-evidence]')) return;
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
    if (!record.candidateSide) return;
    const links = [];
    for (const [index, side] of ['baseline', record.candidateSide].entries()) {
      const run = runs[side];
      if (!run) continue;
      const eventId = record.row?.eventLinks?.[index] ?? (index === 1 ? record.snapshot?.event?.id : null);
      const changed = index === 0 ? record.row?.before : record.row?.after;
      const actions = eventId ? run.events.filter(event => event.id === eventId) :
        changed && Object.hasOwn(changed, 'parentGrantId') ? run.events.filter(event => event.authorityId === changed.id) : [];
      for (const event of actions) links.push(actionLink(selected, side, event, escape));
    }
    if (links.length) container.insertAdjacentHTML('afterbegin', '<nav aria-label="Actions and supporting grants">' + links.join(' · ') + '</nav>');
  }, true);

  detail.addEventListener('submit', async event => {
    if (event.target.id === 'review-decision-form' && selected) {
      event.preventDefault();
      try {
        await writeLocal(saveReviewDecision, getStorage, selected, detail.querySelector('#review-decision').value,
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
      await writeLocal(saveReview, getStorage, selected, detail.querySelector('#review-note').value, detail.querySelector('#review-complete').checked);
      announce('Review saved.');
      await render();
      if (!detail.closest('[hidden]')) detail.querySelector('#review-note')?.focus({ preventScroll: true });
    } catch (error) { announce(`Could not save the review. ${error.message}`, true); }
  });

  detail.addEventListener('change', async event => {
    const input = event.target;
    if (input.id === 'include-codex-receipts') {
      const history = detail.querySelector('#include-sender-history');
      if (history) {
        history.disabled = !input.checked;
        if (!input.checked) history.checked = false;
      }
      return;
    }
    const kind = input.dataset.previewRestore;
    if (kind && selected) {
      const item = selected;
      const file = input.files[0];
      const route = location.hash;
      const button = detail.querySelector(`#apply-${kind}-restore`);
      const message = detail.querySelector(`#${kind}-restore-status`);
      restoreDraft = undefined;
      button.disabled = true;
      const cancel = detail.querySelector('#cancel-codex-restore');
      if (cancel) cancel.hidden = true;
      message.classList.remove('import-error');
      message.textContent = '';
      if (!file) return;
      const current = () => input.isConnected && item === selected && route === location.hash && input.files[0] === file;
      message.textContent = 'Checking replacement evidence…';
      try {
        if (file.size > MAX_REVIEW_PACKAGE_BYTES) throw new Error('Choose a review case no larger than 2 MiB.');
        const contents = await file.text();
        const preview = kind === 'codex' ? previewCodexOriginalRepair : previewInvoiceEvidenceRestore;
        const { restored, pinState } = await preview(getStorage, item, contents);
        if (!current()) return;
        restoreDraft = { item, contents, route, kind };
        const next = {
          matched: kind === 'codex' ? 'Closing requires a saved decision and a verified passing follow-up.'
            : 'After applying, review the evidence and close explicitly.',
          conflict: 'The conflicting workflow pin stays in place and still blocks closure.',
          missing: 'Pin the original baseline before closing.',
          unreadable: 'Restore access to your workflow pins before closing.',
        };
        const result = kind === 'codex'
          ? `Matching original receipts in ${file.name}: ${restored.join(', ')}. Applying will keep this case open.`
          : `Ready to restore: ${restored.join('; ')}.`;
        message.textContent = `${result} Your decision and notes are kept. ${next[pinState.status]}`;
        button.disabled = false;
        if (cancel) cancel.hidden = false;
      } catch (error) {
        if (current()) {
          message.classList.add('import-error');
          message.textContent = error.message;
        }
      } finally { if (current()) input.value = ''; }
      return;
    }
    if (input.id !== 'review-follow-up-file' || !input.files[0] || !selected) return;
    const file = input.files[0];
    const item = selected;
    input.disabled = true;
    announce(item.codex || item.invoice ? 'Checking the follow-up folder…' : 'Checking the follow-up package…');
    try {
      if (item.codex) {
        const { evidence } = await importCodexFolder(input.files, { retainEvidence: true });
        await writeLocal(attachCodexFollowUp, getStorage, item, evidence);
      } else if (item.invoice) {
        const { evidence } = await importInvoiceFolder(input.files);
        await writeLocal(attachInvoiceFollowUp, getStorage, item, evidence);
      } else {
        if (file.size > MAX_REVIEW_PACKAGE_BYTES) throw new Error('Choose a review package no larger than 2 MiB.');
        await writeLocal(attachReviewFollowUp, getStorage, item, await file.text());
      }
      announce('Follow-up saved.');
      if (isCaseDetailRoute(item.id)) await render();
    } catch (error) {
      announce(`Could not attach the follow-up. ${error.message}`, true);
      if (item.codex && isCaseDetailRoute(item.id)) await render();
    }
    finally { input.disabled = false; input.value = ''; }
  });

  function cancelCodexPreview() {
    restoreDraft = undefined;
    const input = detail.querySelector('#codex-restore-file');
    input.value = '';
    detail.querySelector('#apply-codex-restore').disabled = true;
    detail.querySelector('#cancel-codex-restore').hidden = true;
    detail.querySelector('#codex-restore-status').textContent = 'Preview canceled.';
    input.focus();
  }

  detail.addEventListener('cancel', event => {
    if (event.target.id === 'codex-restore-file' && restoreDraft?.kind === 'codex') cancelCodexPreview();
  });

  detail.addEventListener('click', async event => {
    if (!selected) return;
    const receiptStage = event.target.dataset.outputReceipt;
    if (receiptStage && openOutputReceipt(receiptStage)) {
      const params = new URLSearchParams({ item: selected.id, receipt: receiptStage });
      if (receiptStage === 'follow-up') params.set('capture', selected.followUp.id);
      history.replaceState(null, '', reviewRoute + params);
      return;
    }
    if (event.target.id === 'copy-review-summary') {
      const button = event.target;
      const preview = detail.querySelector('#review-summary-text');
      const message = detail.querySelector('#review-summary-status');
      button.disabled = true;
      try {
        const current = restoreReviews(getStorage).items.find(item => item.id === selected?.id);
        if (!current) throw new Error('Reopen the saved case before copying.');
        const { assessment, followUp, status } = await recheck(current);
        if (!button.isConnected) return;
        const latest = restoreReviews(getStorage).items.find(item => item.id === current.id);
        if (JSON.stringify(latest) !== JSON.stringify(current)) {
          await render();
          announce('The saved case changed. Reopen the PR summary to review it.');
          return;
        }
        const checked = caseSummary(current, assessment, followUp, status.closure);
        if (checked !== preview.value) {
          preview.value = checked;
          message.textContent = 'The evidence changed. Review the updated summary before copying.';
          return;
        }
        try {
          await navigator.clipboard.writeText(checked);
          message.textContent = 'Summary copied.';
        } catch {
          preview.focus();
          preview.select();
          message.textContent = 'Summary selected. Use your device’s Copy command.';
        }
      } catch {
        preview.value = '';
        message.textContent = 'Reopen the case to recheck the evidence before copying.';
      } finally { button.disabled = false; }
      return;
    }
    if (event.target.id === 'cancel-codex-restore') {
      cancelCodexPreview();
      return;
    }
    const targetId = event.target.dataset.closureTarget;
    if (targetId) {
      const target = document.getElementById(targetId);
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
    const kind = event.target.dataset.applyRestore;
    if (kind) {
      const draft = restoreDraft;
      if (!draft || draft.item !== selected || draft.kind !== kind || draft.route !== location.hash) return;
      restoreDraft = undefined;
      const input = detail.querySelector(`#${kind}-restore-file`);
      const message = detail.querySelector(`#${kind}-restore-status`);
      input.disabled = event.target.disabled = true;
      if (kind === 'codex') detail.querySelector('#cancel-codex-restore').hidden = true;
      message.textContent = 'Rechecking replacement evidence…';
      try {
        const apply = kind === 'codex' ? applyCodexOriginalRepair : restoreInvoiceEvidence;
        await writeLocal(apply, getStorage, draft.item, draft.contents);
        if (draft.route === location.hash) {
          announce(kind === 'codex' ? 'Original receipts repaired. The case is open for review.'
            : 'Matching evidence restored. Review the case before closing.');
          await render({ focus: true });
        }
      } catch (error) {
        if (input.isConnected) {
          message.textContent = error.message;
          message.classList.add('import-error');
          input.disabled = false;
        }
      }
      return;
    }
    if (event.target.id === 'adopt-codex-baseline') {
      const item = selected;
      event.target.disabled = true;
      try {
        const baseline = await writeLocal(adoptCodexBaseline, getStorage, item);
        onBaselineAdopted(baseline);
        announce('Included baseline pinned in this browser.');
      } catch (error) { announce(`Could not pin the included baseline. ${error.message}`, true); }
      if (isCaseDetailRoute(item.id)) await render({ focus: true });
      return;
    }
    if (event.target.id === 'resolve-review-case') {
      const item = selected;
      event.target.disabled = true;
      try {
        await writeLocal(resolveReviewCase, getStorage, item);
        announce('Case closed as resolved.');
        if (isCaseDetailRoute(item.id)) await render();
      } catch (error) {
        announce(`Could not resolve the case. ${error.message}`, true);
        if (isCaseDetailRoute(item.id)) await render();
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
      const receiptCheckbox = detail.querySelector('#include-invoice-receipts, #include-codex-receipts');
      const includeReceipts = completeCase && receiptCheckbox?.checked === true;
      const includeInvoiceReceipts = includeReceipts && Boolean(item.invoice);
      const includeCodexReceipts = includeReceipts && Boolean(item.codex);
      const historyCheckbox = detail.querySelector('#include-sender-history');
      const includeSenderHistory = includeCodexReceipts && historyCheckbox?.checked === true;
      if (receiptCheckbox) receiptCheckbox.checked = false;
      if (historyCheckbox) {
        historyCheckbox.checked = false;
        historyCheckbox.disabled = true;
      }
      event.target.disabled = true;
      try {
        const contents = completeCase ? await createReviewCase(item, note, { includeInvoiceReceipts, includeCodexReceipts, includeSenderHistory, getStorage })
          : await createReviewPackage(item.report, item, note);
        const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = completeCase ? 'review-case.json' : 'review-package.json';
        detail.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        const included = [note && 'saved note', includeInvoiceReceipts && 'invoice receipts', includeCodexReceipts && 'Codex receipts',
          includeSenderHistory && 'sender repair history'].filter(Boolean);
        announce(`${label} downloaded${included.length ? ' with ' + included.join(' and ') : ''}.`);
      } catch (error) { announce(`Could not download the ${label.toLowerCase()}. ${error.message}`, true); }
      finally { event.target.disabled = false; }
      return;
    }
    if (event.target.id !== 'remove-review') return;
    if (!window.confirm('Remove this report and its saved evidence, follow-up, decision and notes?')) return;
    try {
      await writeLocal(removeReview, getStorage, selected);
      announce('Report removed from the inbox.');
      location.hash = reviewRoute;
    } catch (error) { announce(`Could not remove the report. ${error.message}`, true); }
  });

  return { render };
}
