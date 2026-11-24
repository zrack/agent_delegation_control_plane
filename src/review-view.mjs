import { regressionLabels } from './comparison.mjs';
import { importCodexFolder } from './codex-import.mjs';
import { MAX_IMPORT_BYTES, parseInvestigation } from './import.mjs';
import { importInvoiceFolder, invoiceFields } from './invoice-import.mjs';
import { restoreWorkflowBaselines, WORKFLOW_BASELINE_KEY } from './storage.mjs';
import {
  adoptCodexBaseline, assessFollowUp, assessReview, attachCodexFollowUp, attachInvoiceFollowUp, attachReviewFollowUp, createReviewCase, createReviewPackage, importReview, importReviewPackage,
  MAX_REPORT_BYTES, MAX_REVIEW_NOTE, MAX_REVIEW_PACKAGE_BYTES, removeReview, resolveReviewCase,
  applyCodexOriginalRepair, previewCodexOriginalRepair, previewInvoiceEvidenceRestore, restoreInvoiceEvidence, restoreReviews, reviewDecisions, saveInvoiceCandidate, saveReview, saveReviewDecision,
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

  function codexFolderEvidence({ codex, candidateResult }, side = 'original') {
    const heading = side === 'original' ? 'codex-evidence-title' : 'codex-follow-up-title';
    const { hashes, files } = codex.evidence;
    const grants = candidateResult.findings.filter(finding => finding.code === 'GRANT_MISSING');
    const missing = grants.map(({ eventId, grantId }) => {
      const event = codex.chain.events.find(record => record.id === eventId);
      if (!event) return '';
      return evidenceDetails(event.label, { snapshot: { event, missingGrantId: grantId } },
        `${event.action.action} · Missing grant ${grantId}`);
    });
    const rows = Object.entries(hashes).map(([name, hash]) => {
      const retained = Object.hasOwn(files, name);
      const summary = `<code>${escape(name)}</code> · ${retained ? 'Rechecked from saved bytes' : 'Verified at import only'}`;
      return retained ? `<details class="run-difference" data-codex-file="${escape(name)}" data-codex-side="${side}" data-file-index="${records.push(files[name]) - 1}">
        <summary>${summary}</summary><code class="receipt-digest">SHA-256 ${escape(hash)}</code><pre tabindex="0"></pre></details>`
        : `<div class="codex-digest-only">${summary}<code class="receipt-digest">SHA-256 ${escape(hash)}</code></div>`;
    });
    return `<section class="invoice-results" aria-labelledby="${heading}">
      <h4 id="${heading}">${side === 'original' ? 'Codex folder evidence' : 'Corrected Codex folder evidence'}</h4>
      <p>The capture manifest lists ${Object.keys(hashes).length} files.
        ${codex.verifiedFileCount} saved files passed the current receipt check.</p>
      ${missing.length ? '<h4>Actions with missing grants</h4>' + missing.join('') : ''}
      <details class="review-differences"><summary>Inspect files and digests</summary>${rows.join('')}</details></section>`;
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

  function codexLocalHistory(item) {
    if (!item.codex) return '';
    const entries = (item.localHistory ?? []).map(entry => {
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
    });
    return `<section id="codex-local-history" aria-labelledby="codex-history-title"><h3 id="codex-history-title">Local repair history</h3>
      ${entries.length ? `<ol>${entries.join('')}</ol>` : '<p class="muted">No local repairs or closures recorded.</p>'}</section>`;
  }

  function renderCase(item, original, followUp) {
    if (item.report.status === 'pass' && !followUp.flagged && !item.decision) return '';
    const { assessment, canResolve, pinChanged, resolved } = followUp;
    const comparison = (label, record, check) => `<div class="compare-run"><h3>${label}</h3>
      <code>${escape(record.report.candidateId ?? 'No run ID')}</code>
      <p class="panel-description">Reported · ${regressionLabels[record.report.status]}</p>
      <p class="panel-description">${check?.verdict ? `Rechecked · ${regressionLabels[check.verdict.status]}` : 'Evidence check unavailable'}</p></div>`;
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
      ${item.followUp ? `<div class="compare-sides review-case-verdicts">${comparison('Original run', item, original)}
        ${comparison('Follow-up run', item.followUp, assessment)}</div>
        ${receiptSummary}
        ${assessment || receiptDetails ? `<details class="review-differences" id="${item.codex ? 'codex-follow-up-evidence' : 'invoice-follow-up-evidence'}"><summary>Inspect follow-up evidence</summary>
          ${assessment ? renderEvidence(item.followUp, assessment) + followUpRecords : ''}${receiptDetails}
          ${assessment?.codex ? codexFolderEvidence(assessment, 'follow-up') : ''}</details>` : ''}` : ''}
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
    return `<details class="review-differences"><summary>Export review package or case</summary>
      <p class="panel-description">The download includes the original report${matching}.</p>
      ${codexReceiptOption ? '<p class="panel-description" id="codex-export-help">Including receipts adds the saved Codex ledgers and before/after files for the original and any verified follow-up. They can contain source text and tool-call details. A resolved case also includes its verifiable closure.</p>' : ''}
      ${contents.length ? `<p class="panel-description">The case download also includes the ${contents.join(', ')}.</p>` : ''}
      ${receiptOption ? `<p class="panel-description" id="invoice-export-help">Including invoice receipts adds the available original
        and follow-up receipt files and any verified closure to the case download. Execution receipts may contain logs.</p>` : ''}
      <div class="review-note-actions"><label><input type="checkbox" id="include-review-note" ${item.note ? '' : 'disabled'}> Include saved review note</label>
      ${codexReceiptOption ? '<label><input type="checkbox" id="include-codex-receipts" aria-describedby="codex-export-help"> Include Codex receipts in case download</label>' : ''}
      ${receiptOption ? '<label><input type="checkbox" id="include-invoice-receipts" aria-describedby="invoice-export-help"> Include invoice receipts in case download</label>' : ''}
      <button type="button" id="download-review-package">Download review package</button>
      ${item.decision ? '<button type="button" id="download-review-case">Download review case</button>' : ''}</div></details>`;
  }

  function blockedCodexView(item, message, explanation) {
    return `<section class="review-case"><h3><span class="badge unknown">Open</span> · ${escape(message)}</h3>
      ${explanation}
      ${item.decision ? `<p id="codex-blocked-decision"><strong>${escape(reviewDecisions[item.decision.kind])}</strong> · ${escape(item.decision.reason)}</p>` : ''}
      ${item.note ? `<p>Saved review note · ${escape(item.note)}</p>` : ''}
      <button type="button" id="resolve-review-case" disabled>Close as resolved</button></section>
      ${codexLocalHistory(item)}
      <button type="button" id="remove-review">Remove from inbox</button>`;
  }

  async function render({ focus = false } = {}) {
    const currentRevision = ++revision;
    const { items, warning } = restoreReviews(getStorage);
    const id = new URLSearchParams(location.hash.slice(reviewRoute.length)).get('item');
    selected = items.find(item => item.id === id);
    restoreDraft = undefined;
    records = [];
    if (warning) announce(warning, true);
    if (!savingInvoice) updateInvoiceWorkflows();
    list.innerHTML = [...items].sort((a, b) => Number(a.reviewed) - Number(b.reviewed)
      || priority[a.report.status] - priority[b.report.status]).map(item => `<a class="chain-card review-card ${item.id === id ? 'selected' : ''}"
        href="${itemRoute(item.id)}" ${item.id === id ? 'aria-current="true"' : ''}>
        <span class="badge ${tones[item.report.status]}">${regressionLabels[item.report.status]}</span>
        ${item.codex ? '<strong>Codex folder</strong>' : ''}
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
      const assessment = await assessReview(item).catch(error => {
        if (item.codex) return { error: error.message };
        throw error;
      });
      const followUp = await assessFollowUp(item, assessment, getStorage);
      const invoice = followUp.originalInvoice;
      const receiptResults = invoice?.checked ? invoiceMarkup(invoice.checked)
        : invoice?.error ? `<p class="import-error">${escape(invoice.error)}</p>` : '';
      if (currentRevision !== revision) return;
      const checklist = item.codex ? codexChecklist(item, assessment, followUp) : '';
      if (assessment.error) {
        detail.innerHTML = blockedCodexView(item, 'Original Codex evidence could not be verified', checklist + evidenceRestorePanel(item));
        return;
      }
      const title = assessment.states.candidate === 'matched' ? item.candidate.title : 'Saved regression report';
      detail.innerHTML = `<div class="panel-heading"><h3>${escape(title)}</h3>
        <span class="badge ${tones[item.report.status]}">Reported · ${regressionLabels[item.report.status]}</span></div>
        ${item.invoice || item.codex ? `<p class="panel-description">${item.codex ? 'Case workflow' : 'Pinned workflow'} · ${escape((item.invoice ?? item.codex).workflow)}</p>` : ''}
        ${checklist}
        ${renderEvidence(item, assessment)}
        ${receiptResults}
        ${assessment.codex ? codexFolderEvidence(assessment) : ''}
        ${item.report.reasons.length ? `<details class="review-differences"><summary>Reasons recorded by the offline report</summary>
          <ul>${item.report.reasons.slice(0, 12).map(reason => `<li>${escape(reason.message)}</li>`).join('')}</ul>
          ${item.report.reasons.length > 12 ? `<p>Showing 12 of ${item.report.reasons.length} recorded reasons.</p>` : ''}</details>` : ''}
        ${renderCase(item, assessment, followUp)}
        ${codexLocalHistory(item)}
        <form id="review-note-form">
          <label for="review-note">Review note</label>
          <textarea id="review-note" rows="3" maxlength="${MAX_REVIEW_NOTE}">${escape(item.note)}</textarea>
          <div class="review-note-actions"><label><input type="checkbox" id="review-complete" ${item.reviewed ? 'checked' : ''}> Mark as reviewed</label>
          <button type="submit">Save review</button><button type="button" id="remove-review">Remove from inbox</button></div>
        </form>
        ${renderExport(item, assessment, followUp)}`;
    } catch (error) {
      if (currentRevision !== revision) return;
      const message = `<p class="import-error">${escape(error.message)}</p>`;
      detail.innerHTML = item.codex ? blockedCodexView(item, 'Case verification could not finish',
        message + '<p>Check the case export and reopen it in a fresh profile.</p>')
        : message + '<button type="button" id="remove-review">Remove from inbox</button>';
    }
  }

  window.addEventListener('storage', event => {
    if ((event.key === WORKFLOW_BASELINE_KEY || event.key === null) && selected?.codex && location.hash.startsWith(reviewRoute)) render();
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
        await attachCodexFollowUp(getStorage, item, evidence);
      } else if (item.invoice) {
        const { evidence } = await importInvoiceFolder(input.files);
        await attachInvoiceFollowUp(getStorage, item, evidence);
      } else {
        if (file.size > MAX_REVIEW_PACKAGE_BYTES) throw new Error('Choose a review package no larger than 2 MiB.');
        await attachReviewFollowUp(getStorage, item, await file.text());
      }
      announce('Follow-up saved.');
      if (location.hash === itemRoute(item.id)) await render();
    } catch (error) {
      announce(`Could not attach the follow-up. ${error.message}`, true);
      if (item.codex && location.hash === itemRoute(item.id)) await render();
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
        await apply(getStorage, draft.item, draft.contents);
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
        const baseline = await adoptCodexBaseline(getStorage, item);
        onBaselineAdopted(baseline);
        announce('Included baseline pinned in this browser.');
      } catch (error) { announce(`Could not pin the included baseline. ${error.message}`, true); }
      if (location.hash === itemRoute(item.id)) await render({ focus: true });
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
      const receiptCheckbox = detail.querySelector('#include-invoice-receipts, #include-codex-receipts');
      const includeReceipts = completeCase && receiptCheckbox?.checked === true;
      const includeInvoiceReceipts = includeReceipts && Boolean(item.invoice);
      const includeCodexReceipts = includeReceipts && Boolean(item.codex);
      if (receiptCheckbox) receiptCheckbox.checked = false;
      event.target.disabled = true;
      try {
        const contents = completeCase ? await createReviewCase(item, note, { includeInvoiceReceipts, includeCodexReceipts, getStorage })
          : await createReviewPackage(item.report, item, note);
        const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = completeCase ? 'review-case.json' : 'review-package.json';
        detail.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        const included = [note && 'saved note', includeInvoiceReceipts && 'invoice receipts', includeCodexReceipts && 'Codex receipts'].filter(Boolean);
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
