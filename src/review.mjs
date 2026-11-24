// Reports are recorded claims. Only matching evidence can reproduce a verdict.
import { canPinBaseline, checkRegression, compareRuns, regressionLabels } from './comparison.mjs';
import { assessCodexEvidence, codexReceiptNames, portableCodexEvidence, previousCodexReceiptDigest } from './codex-import.mjs';
import { evaluateChain } from './evaluator.mjs';
import { parseInvestigation } from './import.mjs';
import { assessInvoiceFolder, portableInvoiceEvidence } from './invoice-import.mjs';
import {
  restoreInvestigations, restoreWorkflowBaselines, runFingerprint, saveInvestigation, saveWorkflowBaseline,
  STORAGE_KEY, workflowKey,
} from './storage.mjs';

export const REVIEW_STORAGE_KEY = 'adcp.regression-reviews.v1';
export const MAX_REPORT_BYTES = 2 * 1024 * 1024;
export const MAX_REVIEW_PACKAGE_BYTES = MAX_REPORT_BYTES;
export const MAX_REVIEW_NOTE = 1200;
export const MAX_SENDER_HISTORY_ENTRIES = 100;
export const reviewDecisions = Object.freeze({
  'fix-required': 'Fix required',
  'evidence-needed': 'Evidence needed',
  'expected-change': 'Expected change',
});
const packageKind = 'adcp-review-package';
const caseKind = 'adcp-review-case';
const invoiceCaseKind = 'adcp-invoice-review-case';
const codexCaseKind = 'adcp-codex-review-case';
const MAX_REVIEWS = 20;
const sides = ['baseline', 'candidate'];
const reviewFields = ['report', 'note', 'reviewed', ...sides, 'decision', 'followUp', 'resolution',
  'invoice', 'codex', 'suppliedBaseline', 'localHistory', 'senderHistory'];
const bytes = value => new TextEncoder().encode(value).length;
const isId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(value);
const isFingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function parseRegressionReport(contents) {
  if (typeof contents !== 'string' || contents.length > MAX_REPORT_BYTES || bytes(contents) > MAX_REPORT_BYTES) {
    throw new Error('Choose a regression report no larger than 2 MiB.');
  }
  let input;
  try { input = JSON.parse(contents); } catch { throw new Error('The regression report is not valid JSON.'); }
  if (input?.schemaVersion !== 1 || typeof input.status !== 'string' || !Object.hasOwn(regressionLabels, input.status)
    || !Array.isArray(input.reasons) || input.reasons.length > 1600) {
    throw new Error('Expected a version 1 offline regression report.');
  }
  const report = { schemaVersion: 1, status: input.status, reasons: input.reasons.map(reason => {
    if (!['regression', 'review'].includes(reason?.impact) || typeof reason.message !== 'string'
      || !reason.message.trim() || reason.message.length > 600) throw new Error('A report reason is invalid.');
    const result = { impact: reason.impact, message: reason.message };
    for (const side of sides) {
      for (const kind of ['EventId', 'GrantId']) {
        const key = side + kind;
        if (reason[key] === undefined) continue;
        if (!isId(reason[key])) throw new Error('A report evidence reference is invalid.');
        result[key] = reason[key];
      }
    }
    return result;
  }) };
  for (const side of sides) {
    const id = input[side + 'Id'];
    const fingerprint = input[side + 'Fingerprint'];
    if (input.status === 'review' && id === undefined && fingerprint === undefined) continue;
    if (!isId(id) || !isFingerprint(fingerprint)) throw new Error('A report is missing a valid run ID or fingerprint.');
    report[side + 'Id'] = id;
    report[side + 'Fingerprint'] = fingerprint;
  }
  return report;
}

async function evidenceState(report, side, chain) {
  const fingerprint = report[side + 'Fingerprint'];
  if (!fingerprint) return 'unavailable';
  if (chain === undefined) return 'missing';
  if (!chain || chain.id !== report[side + 'Id'] || await runFingerprint(chain) !== fingerprint) return 'mismatch';
  return 'matched';
}

const normalizeEvidence = chain => parseInvestigation(JSON.stringify({ schemaVersion: 1, chain }));

async function reviewBundle(kind, report, evidence, note) {
  const normalized = parseRegressionReport(JSON.stringify(report));
  const bundle = { kind, schemaVersion: 1, report: normalized };
  for (const side of sides) {
    if (await evidenceState(normalized, side, evidence[side]) === 'matched') {
      bundle[side] = { schemaVersion: 1, chain: normalizeEvidence(evidence[side]) };
    }
  }
  if (note !== undefined) {
    if (typeof note !== 'string' || note.length > MAX_REVIEW_NOTE) throw new Error('The review note is invalid.');
    if (note.trim()) bundle.note = note.trim();
  }
  return bundle;
}

function serializeBundle(bundle) {
  const raw = JSON.stringify(bundle);
  if (bytes(raw) > MAX_REVIEW_PACKAGE_BYTES) throw new Error('The review package exceeds 2 MiB.');
  return raw;
}

export async function createReviewPackage(report, evidence, note) {
  return serializeBundle(await reviewBundle(packageKind, report, evidence, note));
}

const caseResolutionFingerprint = async item => runFingerprint({
  original: await runFingerprint(item.report), decision: item.decision, followUp: item.followUp.id,
});

export async function createReviewCase(item, note, {
  includeInvoiceReceipts = false, includeCodexReceipts = false, includeSenderHistory = false, getStorage,
} = {}) {
  const withReceipts = Boolean(item.invoice && includeInvoiceReceipts === true);
  const bundle = await reviewBundle(withReceipts ? invoiceCaseKind : caseKind, item.report, item, note);
  if (item.decision) bundle.decision = validateDecision(item.decision.kind, item.decision.reason);
  if (item.codex) {
    const original = await assessReview(item);
    if (includeCodexReceipts === true) {
      if (!bundle.decision || !original.codex || !original.verdict) {
        throw new Error('Save a decision and verify the original Codex receipts before exporting this case.');
      }
      bundle.kind = codexCaseKind;
      bundle.codex = portableCodex(item.codex);
      if (item.followUp) {
        const checked = await assessFollowUp(item, original, getStorage);
        if (checked.incompatible || checked.error || !checked.assessment?.codex) {
          throw new Error(checked.error ?? 'The follow-up needs matching Codex evidence before it can be exported.');
        }
        bundle.followUp = { report: item.followUp.report, candidate: { schemaVersion: 1, chain: item.followUp.candidate },
          codex: portableCodex(item.followUp.codex) };
        if (checked.resolved) bundle.resolution = item.resolution;
      }
      if (includeSenderHistory === true) {
        const entries = senderHistoryEntries(item);
        if (entries.length) bundle.senderHistory = { caseId: item.id, entries };
      }
      if (getStorage) requireCurrentReview(readReviews(getStorage()), item);
    }
    return serializeBundle(bundle);
  }
  if (item.invoice && !withReceipts) return serializeBundle(bundle);
  const original = await assessReview(item);
  const { assessment, invoice, originalInvoice, resolved } = await assessFollowUp(item, original);
  if (withReceipts) {
    if (!bundle.decision || !original.verdict || !originalInvoice.checked) {
      throw new Error('Save a decision and restore the original invoice evidence before exporting receipts.');
    }
    bundle.invoice = portableInvoice(item.invoice);
    if (assessment?.verdict && invoice?.checked) {
      bundle.followUp = { report: item.followUp.report, candidate: { schemaVersion: 1, chain: item.followUp.candidate },
        invoice: portableInvoice(item.followUp.invoice) };
    }
    if (resolved) bundle.resolution = await resolutionFor(item);
    return serializeBundle(bundle);
  }
  if (bundle.decision && assessment?.states.baseline === 'matched' && assessment.states.candidate === 'matched') {
    bundle.followUp = { report: item.followUp.report, candidate: { schemaVersion: 1, chain: item.followUp.candidate } };
    if (resolved) bundle.resolution = await caseResolutionFingerprint(item);
  }
  return serializeBundle(bundle);
}

function readReviewPackage(contents, allowCase = false) {
  if (typeof contents !== 'string' || contents.length > MAX_REVIEW_PACKAGE_BYTES || bytes(contents) > MAX_REVIEW_PACKAGE_BYTES) {
    throw new Error('Choose a review package no larger than 2 MiB.');
  }
  let bundle;
  try { bundle = JSON.parse(contents); } catch { throw new Error('The review package is not valid JSON.'); }
  const kinds = allowCase ? [packageKind, caseKind, invoiceCaseKind, codexCaseKind] : [packageKind];
  if (bundle?.schemaVersion !== 1 || !kinds.includes(bundle.kind)) {
    throw new Error(allowCase ? 'Expected a version 1 review package or case.' : 'Expected a version 1 review package.');
  }
  if (bundle.note !== undefined && (typeof bundle.note !== 'string' || bundle.note.length > MAX_REVIEW_NOTE)) {
    throw new Error('The review note in the package is invalid.');
  }
  const evidence = {};
  for (const side of sides) {
    if (bundle[side] !== undefined) evidence[side] = parseInvestigation(JSON.stringify(bundle[side]));
  }
  return { reportText: JSON.stringify(bundle.report), evidence, note: bundle.note?.trim(), bundle };
}

export function importReviewPackage(getStorage, contents) {
  const { reportText, evidence, note, bundle } = readReviewPackage(contents, true);
  if (bundle.kind !== packageKind) return importReview(getStorage, reportText, evidence, note, bundle);
  return importReview(getStorage, reportText, evidence, note);
}

function validateDecision(kind, reason) {
  if (typeof kind !== 'string' || !Object.hasOwn(reviewDecisions, kind)) throw new Error('Choose a review decision.');
  if (typeof reason !== 'string' || reason.length > MAX_REVIEW_NOTE || !reason.trim()) throw new Error('Add a reason for this decision.');
  return { kind, reason: reason.trim() };
}

// Local history is display metadata. A damaged entry cannot prevent the
// evidence from being rechecked or turn an imported closure into a local one.
function readCodexHistory(history) {
  if (!Array.isArray(history)) return [];
  const entries = [];
  for (const entry of history) {
    if (typeof entry?.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(entry.at)
      || !Number.isFinite(Date.parse(entry.at))) continue;
    const { kind, at } = entry;
    if (kind === 'repair') {
      const { files } = entry;
      if (!Array.isArray(files) || !files.length || files.length > codexReceiptNames.length
        || !files.every(file => codexReceiptNames.includes(file?.name) && isFingerprint(file.after)
          && (file.before === 'missing' || file.before === 'unreadable' || isFingerprint(file.before)))
        || new Set(files.map(file => file.name)).size !== files.length) continue;
      entries.push({ kind, at, files: files.map(({ name, before, after }) => ({ name, before, after })) });
    } else if (kind === 'closure') {
      const { baselineId, baselineFingerprint, followUpId, followUpFingerprint } = entry;
      if (isId(baselineId) && isFingerprint(baselineFingerprint) && isId(followUpId) && isFingerprint(followUpFingerprint)) {
        entries.push({ kind, at, baselineId, baselineFingerprint, followUpId, followUpFingerprint });
      }
    }
  }
  return entries;
}

function historyEntryMatchesCase(entry, item) {
  if (entry.kind === 'repair') {
    return entry.files.every(file => file.after === item.codex?.evidence?.hashes?.[file.name]);
  }
  const followUp = item.followUp?.report;
  return entry.baselineId === item.report.baselineId && entry.baselineFingerprint === item.report.baselineFingerprint
    && entry.followUpId === followUp?.candidateId && entry.followUpFingerprint === followUp?.candidateFingerprint;
}

// Export only actions performed in this profile, scoped to the original
// receipts and the follow-up that the recipient will actually receive.
export function senderHistoryEntries(item) {
  const entries = readCodexHistory(item.localHistory).filter(entry => historyEntryMatchesCase(entry, item));
  return entries.slice(-MAX_SENDER_HISTORY_ENTRIES);
}

function readSenderHistory(history, item) {
  if (history?.caseId !== item.id || !Array.isArray(history.entries) || !history.entries.length
    || history.entries.length > MAX_SENDER_HISTORY_ENTRIES) return undefined;
  const entries = readCodexHistory(history.entries);
  if (entries.length !== history.entries.length || !entries.every(entry => historyEntryMatchesCase(entry, item))) return undefined;
  return { caseId: item.id, entries };
}

function readReviews(storage) {
  const raw = storage.getItem(REVIEW_STORAGE_KEY);
  if (raw === null) return [];
  if (raw.length > MAX_REPORT_BYTES || bytes(raw) > MAX_REPORT_BYTES) throw new Error('The inbox exceeds its storage limit.');
  const saved = JSON.parse(raw);
  if (saved?.schemaVersion !== 1 || !Array.isArray(saved.items) || saved.items.length > MAX_REVIEWS) {
    throw new Error('The saved inbox is unreadable.');
  }
  const ids = new Set();
  return saved.items.map(item => {
    if (!isFingerprint(item?.id) || ids.has(item.id) || typeof item.note !== 'string'
      || item.note.length > MAX_REVIEW_NOTE || typeof item.reviewed !== 'boolean') throw new Error('A saved review is invalid.');
    ids.add(item.id);
    const report = parseRegressionReport(JSON.stringify(item.report));
    const restored = { id: item.id, report, note: item.note, reviewed: item.reviewed };
    for (const side of sides) {
      if (item[side] !== undefined) restored[side] = item[side] === null ? null : normalizeEvidence(item[side]);
    }
    if (item.decision !== undefined) restored.decision = validateDecision(item.decision?.kind, item.decision?.reason);
    if (item.followUp !== undefined) {
      if (!isFingerprint(item.followUp?.id)) throw new Error('The saved follow-up is invalid.');
      restored.followUp = { id: item.followUp.id, report: parseRegressionReport(JSON.stringify(item.followUp.report)),
        candidate: normalizeEvidence(item.followUp.candidate) };
      if (item.followUp.invoice !== undefined) restored.followUp.invoice = item.followUp.invoice;
      if (item.followUp.codex !== undefined) restored.followUp.codex = item.followUp.codex;
    }
    if (item.resolution !== undefined) {
      if (!isFingerprint(item.resolution)) throw new Error('The saved resolution is invalid.');
      restored.resolution = item.resolution;
    }
    if (item.codex !== undefined) {
      if (!item.codex || item.invoice !== undefined) throw new Error('The saved Codex snapshot is invalid.');
      restored.codex = item.codex;
      const history = readCodexHistory(item.localHistory);
      if (history.length) restored.localHistory = history;
      const senderHistory = readSenderHistory(item.senderHistory, restored);
      if (senderHistory) restored.senderHistory = senderHistory;
    }
    if (item.invoice !== undefined) {
      restored.invoice = item.invoice;
      if (isId(item.suppliedBaseline?.runId) && isFingerprint(item.suppliedBaseline?.fingerprint)) {
        restored.suppliedBaseline = { runId: item.suppliedBaseline.runId, fingerprint: item.suppliedBaseline.fingerprint };
      }
    }
    return restored;
  });
}

export function restoreReviews(getStorage) {
  try { return { items: readReviews(getStorage()), warning: '' }; }
  catch { return { items: [], warning: 'The saved review inbox could not be read. Check browser site storage.' }; }
}

function writeReviews(storage, items) {
  const raw = JSON.stringify({ schemaVersion: 1, items });
  if (items.length > MAX_REVIEWS || bytes(raw) > MAX_REPORT_BYTES) {
    throw new Error('The inbox holds up to 20 reports or 2 MiB. Remove an older report to make room.');
  }
  storage.setItem(REVIEW_STORAGE_KEY, raw);
  return items;
}

function reviewId(report, invoice, codex) {
  if (codex) return runFingerprint({ report, workflow: codex.workflow, codexEvidenceFingerprint: codex.fingerprint });
  return runFingerprint(invoice ? { report, workflow: invoice.workflow, outputAtImport: invoice.outputAtImport, receiptFingerprint: invoice.fingerprint } : report);
}

export async function assessSavedInvoice(item) {
  const { invoice } = item;
  if (!isFingerprint(invoice?.fingerprint) || await runFingerprint(invoice.evidence) !== invoice.fingerprint) {
    throw new Error('Saved invoice receipts no longer match the snapshot. Reimport the original folder to check them.');
  }
  const checked = await assessInvoiceFolder(invoice.evidence);
  if (!checked.candidate || await evidenceState(item.report, 'candidate', checked.candidate) !== 'matched') {
    throw new Error('Saved invoice receipts do not match the candidate investigation.');
  }
  return checked;
}

async function comparisonReport(baseline, fingerprint, candidate) {
  if (baseline.id === candidate.id) throw new Error('Choose a candidate with a different run ID from the baseline.');
  const original = evaluateChain(baseline);
  if (!canPinBaseline(baseline, original)) throw new Error('The pinned baseline no longer qualifies for comparison.');
  const next = evaluateChain(candidate);
  const { status, reasons } = checkRegression(compareRuns(baseline, candidate, original, next), next);
  return parseRegressionReport(JSON.stringify({
    schemaVersion: 1, status,
    reasons: reasons.map(({ impact, message, eventId, row }) => ({
      impact, message, baselineEventId: row?.eventLinks?.[0], candidateEventId: eventId ?? row?.eventLinks?.[1],
    })),
    baselineId: baseline.id, baselineFingerprint: fingerprint,
    candidateId: candidate.id, candidateFingerprint: await runFingerprint(candidate),
  }));
}

async function invoiceSnapshot(workflow, evidence, output) {
  return { workflow, outputAtImport: output.label, evidence, fingerprint: await runFingerprint(evidence) };
}

export async function saveInvoiceCandidate(getStorage, pin, evidence) {
  const { candidate, output } = await assessInvoiceFolder(evidence);
  if (!candidate) throw new Error('The candidate needs an investigation that matches the invoice manifest.');
  const invoice = await invoiceSnapshot(pin.name, evidence, output);
  return saveFolderCandidate(getStorage, pin, candidate, { invoice });
}

async function codexSnapshot(workflow, evidence) {
  const checked = await assessCodexEvidence(evidence);
  const codex = { workflow, evidence: checked.evidence, fingerprint: await runFingerprint(checked.evidence) };
  return { candidate: checked.chain, codex };
}

export async function saveCodexCandidate(getStorage, pin, evidence) {
  const { candidate, codex } = await codexSnapshot(pin.name, evidence);
  return saveFolderCandidate(getStorage, pin, candidate, { codex });
}

async function saveFolderCandidate(getStorage, pin, candidate, snapshot) {
  const readPin = () => restoreWorkflowBaselines(getStorage).baselines.find(item => workflowKey(item.name) === workflowKey(pin.name));
  const readBaseline = () => restoreInvestigations(getStorage).chains.find(chain => chain.id === pin.runId);
  const pinChanged = () => {
    if (JSON.stringify(readPin()) !== JSON.stringify(pin)) throw new Error('This workflow pin changed. Select the baseline again.');
  };
  pinChanged();
  const baseline = readBaseline();
  if (!baseline || await runFingerprint(baseline) !== pin.fingerprint) {
    throw new Error('Reimport the original investigation for this pinned baseline.');
  }
  const report = await comparisonReport(baseline, pin.fingerprint, candidate);
  const id = await reviewId(report, snapshot.invoice, snapshot.codex);
  // Check again after hashing so a concurrent pin or baseline change cannot
  // save a comparison against a run the reviewer did not select.
  const storage = getStorage();
  const items = readReviews(storage);
  pinChanged();
  if (JSON.stringify(readBaseline()) !== JSON.stringify(baseline)) {
    throw new Error('The saved baseline investigation changed. Reimport the original run before trying again.');
  }
  const current = items.find(item => item.id === id);
  const item = { note: '', reviewed: false, ...current, id, report, baseline, candidate, ...snapshot };
  writeReviews(storage, [item, ...items.filter(record => record.id !== id)]);
  return id;
}

function portableCodex(codex) {
  const { workflow, fingerprint, evidence } = codex ?? {};
  if (typeof workflow !== 'string' || !workflow.trim() || workflow !== workflow.trim()
    || workflow.length > 80 || /[\u0000-\u001f\u007f]/.test(workflow) || !isFingerprint(fingerprint)) {
    throw new Error('The Codex receipt snapshot metadata is invalid.');
  }
  return { workflow, fingerprint, evidence: portableCodexEvidence(evidence) };
}

async function importCodexCase(getStorage, incoming, bundle, warnings) {
  incoming.decision = validateDecision(bundle.decision?.kind, bundle.decision?.reason);
  if (bundle.followUp !== undefined) {
    const file = bundle.followUp;
    const report = parseRegressionReport(JSON.stringify(file?.report));
    const candidate = parseInvestigation(JSON.stringify(file?.candidate));
    const codex = portableCodex(file?.codex);
    if (codex.workflow === incoming.codex.workflow && sameBaseline(incoming.report, report)
      && distinctCandidate(incoming.report, report) && await evidenceState(report, 'candidate', candidate) === 'matched') {
      incoming.followUp = { id: await reviewId(report, undefined, codex), report, candidate, codex };
    } else warnings.push('The Codex follow-up does not match the workflow, original baseline, or candidate.');
  }
  let original;
  try { original = await assessReview(incoming); }
  catch (error) {
    warnings.push(`Original Codex evidence: ${error.message}`);
    return;
  }
  const checked = await assessFollowUp(incoming, original, getStorage);
  if (checked.error) warnings.push(checked.error);
  if (checked.incompatible) warnings.push('The corrected folder does not match the original Codex case.');
  if (bundle.resolution !== undefined) {
    // Keep a verified historical decision even on an unpinned browser. The
    // current view independently requires the matching local pin for Resolved.
    if (checked.passes && original.verdict?.status === incoming.report.status
      && bundle.resolution === await resolutionFor(incoming)) incoming.resolution = bundle.resolution;
    else warnings.push('The recorded Codex closure could not be verified.');
  }
  if (checked.pinState.status === 'missing') warnings.push('The workflow has no local pin. Inspect the included baseline before pinning it.');
  if (checked.pinState.status === 'conflict') warnings.push('The existing workflow pin differs from the original baseline and was preserved.');
  if (checked.pinState.status === 'unreadable') warnings.push('The saved workflow pins could not be read.');
}

function portableInvoice(invoice) {
  const { workflow, outputAtImport, fingerprint, evidence } = invoice ?? {};
  if (typeof workflow !== 'string' || !workflow.trim() || workflow !== workflow.trim() || workflow.length > 80
    || /[\u0000-\u001f\u007f]/.test(workflow) || typeof outputAtImport !== 'string'
    || outputAtImport.length > 80 || !isFingerprint(fingerprint)) {
    throw new Error('The invoice receipt snapshot metadata is invalid.');
  }
  return { workflow, outputAtImport, evidence: portableInvoiceEvidence(evidence), fingerprint };
}

async function readInvoiceFollowUp(original, file) {
  const report = parseRegressionReport(JSON.stringify(file?.report));
  const candidate = parseInvestigation(JSON.stringify(file?.candidate));
  const invoice = portableInvoice(file?.invoice);
  if (!sameBaseline(original, report) || !sameInvoiceCandidate(original, report)
    || await evidenceState(report, 'candidate', candidate) !== 'matched') return undefined;
  return { id: await reviewId(report, invoice), report, candidate, invoice };
}

async function importInvoiceCase(getStorage, incoming, bundle, warnings) {
  incoming.decision = validateDecision(bundle.decision?.kind, bundle.decision?.reason);
  if (bundle.followUp !== undefined) {
    incoming.followUp = await readInvoiceFollowUp(incoming.report, bundle.followUp);
    if (!incoming.followUp) warnings.push('The invoice follow-up needs matching evidence against the original baseline.');
  }

  const original = await assessReview(incoming);
  const checked = await assessFollowUp(incoming, original);
  if (!checked.originalInvoice.checked) warnings.push('The original invoice receipts could not be verified.');
  if (checked.invoice?.error) warnings.push('The follow-up invoice receipts could not be verified.');
  if (bundle.resolution !== undefined) {
    const resolution = checked.canResolve ? await resolutionFor(incoming) : undefined;
    // A fresh browser can verify the packaged baseline without creating a pin.
    // A conflicting local pin takes precedence and leaves the imported case open.
    const { baselines, warning } = restoreWorkflowBaselines(getStorage);
    const pin = baselines.find(pin => workflowKey(pin.name) === workflowKey(incoming.invoice.workflow));
    if (warning || (pin && !folderPinMatches(getStorage, incoming))) {
      warnings.push('The saved workflow uses a different baseline or could not be read. Closure was not restored.');
    } else if (resolution && bundle.resolution === resolution) incoming.resolution = resolution;
    else warnings.push('Invoice closure could not be verified.');
  }
}

export async function importReview(getStorage, reportText, evidence, initialNote = '', portableCase) {
  const report = parseRegressionReport(reportText);
  const invoice = portableCase?.kind === invoiceCaseKind ? portableInvoice(portableCase.invoice) : undefined;
  const codex = portableCase?.kind === codexCaseKind ? portableCodex(portableCase.codex) : undefined;
  const id = await reviewId(report, invoice, codex);
  const attachments = {};
  const mismatches = [];
  for (const side of sides) {
    if (!evidence[side] || !report[side + 'Fingerprint']) continue;
    if (await evidenceState(report, side, evidence[side]) === 'matched') attachments[side] = normalizeEvidence(evidence[side]);
    else mismatches.push(side);
  }
  const incoming = { id, report, ...attachments };
  const caseWarnings = [];
  if (invoice) {
    incoming.invoice = invoice;
    await importInvoiceCase(getStorage, incoming, portableCase, caseWarnings);
  } else if (codex) {
    incoming.codex = codex;
    await importCodexCase(getStorage, incoming, portableCase, caseWarnings);
  } else if (portableCase) {
    if (portableCase.decision !== undefined) {
      incoming.decision = validateDecision(portableCase.decision?.kind, portableCase.decision?.reason);
    }
    if (portableCase.followUp !== undefined) {
      const followUp = parseRegressionReport(JSON.stringify(portableCase.followUp?.report));
      const candidate = parseInvestigation(JSON.stringify(portableCase.followUp?.candidate));
      if (incoming.decision && attachments.baseline && sameBaseline(report, followUp) && distinctCandidate(report, followUp)
        && await evidenceState(followUp, 'candidate', candidate) === 'matched') {
        incoming.followUp = { id: await runFingerprint(followUp), report: followUp, candidate };
      } else caseWarnings.push('The follow-up needs matching evidence against the original baseline.');
    }
    if (portableCase.resolution !== undefined) {
      const { canResolve } = await assessFollowUp(incoming, await assessReview(incoming));
      if (canResolve && portableCase.resolution === await caseResolutionFingerprint(incoming)) {
        incoming.resolution = incoming.followUp.id;
      }
      else caseWarnings.push('Closure could not be verified.');
    }
  }
  const suppliedBaseline = invoice && mismatches.includes('baseline')
    ? { runId: evidence.baseline.id, fingerprint: await runFingerprint(evidence.baseline) } : undefined;
  // Read local state after the asynchronous checks so imports preserve recent edits.
  const storage = getStorage();
  const items = readReviews(storage);
  const current = items.find(item => item.id === id);
  const next = { ...current, id, report, note: current?.note ?? initialNote, reviewed: current?.reviewed ?? false, ...attachments };
  if (codex) next.codex = current?.codex ?? codex;
  if (invoice) {
    next.invoice = current?.invoice ?? invoice;
    if (attachments.baseline) delete next.suppliedBaseline;
    else if (!next.baseline && suppliedBaseline) {
      // Retain identifiers for diagnosis without saving the rejected investigation.
      next.suppliedBaseline = suppliedBaseline;
    }
  }
  if (incoming.decision) {
    if (current?.decision || current?.followUp || current?.resolution) {
      caseWarnings.push('The existing local decision and follow-up were kept.');
    } else {
      next.decision = incoming.decision;
      next.followUp = incoming.followUp;
      next.resolution = incoming.resolution;
    }
  }
  if (codex && portableCase.senderHistory !== undefined) {
    // The case ID binds the workflow, original receipts and complete report.
    // Reimport can retain a different local follow-up, so check both cases.
    const history = readSenderHistory(portableCase.senderHistory, incoming);
    if (history && history.entries.every(entry => historyEntryMatchesCase(entry, next))) next.senderHistory = history;
    else caseWarnings.push('Sender-reported history was omitted because it was invalid or did not match the case evidence.');
  }
  for (const side of mismatches) next[side] ??= null;
  return { id, mismatches, caseWarnings, items: writeReviews(storage, [next, ...items.filter(item => item.id !== id)]) };
}

export function saveReview(getStorage, expected, note, reviewed) {
  if (note.length > MAX_REVIEW_NOTE) throw new Error('The note is too long.');
  const storage = getStorage();
  const items = readReviews(storage);
  const current = items.find(item => item.id === expected.id);
  if (!current || current.note !== expected.note || current.reviewed !== expected.reviewed
    || JSON.stringify(current.report) !== JSON.stringify(expected.report)) {
    throw new Error('This review changed in another tab. Reopen it before saving.');
  }
  return writeReviews(storage, items.map(item => item.id === current.id ? { ...item, note: note.trim(), reviewed } : item));
}

export function removeReview(getStorage, expected) {
  const storage = getStorage();
  const items = readReviews(storage);
  requireCurrentReview(items, expected);
  return writeReviews(storage, items.filter(item => item.id !== expected.id));
}

function requireCurrentReview(items, expected) {
  const current = items.find(item => item.id === expected.id);
  if (!current || reviewFields.some(key => JSON.stringify(current[key]) !== JSON.stringify(expected[key]))) {
    throw new Error('This review changed. Reopen it before trying again.');
  }
}

function updateCase(getStorage, expected, changes) {
  const storage = getStorage();
  const items = readReviews(storage);
  requireCurrentReview(items, expected);
  return writeReviews(storage, items.map(item => item.id === expected.id ? { ...item, ...changes } : item));
}

export function saveReviewDecision(getStorage, expected, kind, reason) {
  const decision = validateDecision(kind, reason);
  const resolution = JSON.stringify(decision) === JSON.stringify(expected.decision) ? expected.resolution : undefined;
  return updateCase(getStorage, expected, { decision, resolution });
}

function sameBaseline(original, followUp) {
  return Boolean(original.baselineFingerprint) && original.baselineId === followUp.baselineId
    && original.baselineFingerprint === followUp.baselineFingerprint;
}

function distinctCandidate(original, followUp) {
  return Boolean(followUp.candidateId) && followUp.candidateId !== original.candidateId
    && followUp.candidateId !== original.baselineId;
}

export async function attachReviewFollowUp(getStorage, expected, contents) {
  if (expected.codex) throw new Error('Codex folder cases require a follow-up folder with its receipts.');
  if (expected.invoice) throw new Error('Attach an invoice folder to recheck its receipts.');
  if (!expected.decision) throw new Error('Save a review decision first.');
  const { reportText, evidence } = readReviewPackage(contents);
  const report = parseRegressionReport(reportText);
  if (!expected.report.baselineFingerprint) throw new Error('The original report has no pinned baseline.');
  if (!sameBaseline(expected.report, report)) throw new Error('The follow-up uses a different baseline. Use the original pinned baseline.');
  if (!distinctCandidate(expected.report, report)) throw new Error('Choose a follow-up with its own candidate run ID.');
  if (await evidenceState(expected.report, 'baseline', expected.baseline) !== 'matched') {
    throw new Error('Restore the original baseline evidence before attaching a follow-up.');
  }
  if (await evidenceState(report, 'baseline', evidence.baseline) !== 'matched'
    || await evidenceState(report, 'candidate', evidence.candidate) !== 'matched') {
    throw new Error('The follow-up package needs both matching exports. Evidence is missing or altered.');
  }
  const followUp = { id: await runFingerprint(report), report, candidate: normalizeEvidence(evidence.candidate) };
  const resolution = JSON.stringify(expected.followUp) === JSON.stringify(followUp) ? expected.resolution : undefined;
  return updateCase(getStorage, expected, { followUp, resolution });
}

function invoicePasses(checked) {
  return checked?.authority.tone === 'valid' && checked.output.tone === 'valid' && checked.execution.tone === 'valid';
}

async function inspectInvoice(item) {
  try { return { checked: await assessSavedInvoice(item) }; }
  catch (error) {
    // Per-file results are diagnostic only when the saved snapshot fails verification.
    const diagnostic = await assessInvoiceFolder(item.invoice.evidence).catch(() => null);
    return { error: error.message, receiptStates: diagnostic?.receiptStates };
  }
}

function sameInvoiceCandidate(original, followUp) {
  // Restoring an original receipt keeps the run ID. In that case the
  // investigation must be identical to the one the case already reviewed.
  return followUp.candidateId === original.candidateId
    ? followUp.candidateFingerprint === original.candidateFingerprint : distinctCandidate(original, followUp);
}

function folderPinState(getStorage, item) {
  const { baselines, warning } = restoreWorkflowBaselines(getStorage);
  if (warning) return { status: 'unreadable' };
  const pin = baselines.find(pin => workflowKey(pin.name) === workflowKey((item.codex ?? item.invoice).workflow));
  if (!pin) return { status: 'missing' };
  const matching = pin.runId === item.report.baselineId && pin.fingerprint === item.report.baselineFingerprint;
  return { status: matching ? 'matched' : 'conflict', pin };
}

function folderPinMatches(getStorage, item) {
  return folderPinState(getStorage, item).status === 'matched';
}

function requireFolderPin(getStorage, item) {
  if (!folderPinMatches(getStorage, item)) {
    throw new Error('The workflow uses a different baseline or is unavailable. Restore the original pin before continuing.');
  }
}

export async function adoptCodexBaseline(getStorage, expected) {
  if (!expected.codex) throw new Error('Choose a Codex review case.');
  const original = await assessReview(expected);
  if (!original.codex || !original.verdict) {
    throw new Error('The included baseline and original Codex evidence must verify before pinning.');
  }
  const storage = getStorage();
  requireCurrentReview(readReviews(storage), expected);
  if (folderPinState(getStorage, expected).status !== 'missing') {
    throw new Error('A workflow pin already exists or cannot be checked. It was preserved.');
  }

  const { baseline } = expected;
  const saved = restoreInvestigations(getStorage);
  if (saved.warning) throw new Error(saved.warning);
  const existing = saved.chains.find(chain => chain.id === baseline.id);
  if (existing && JSON.stringify(existing) !== JSON.stringify(baseline)) {
    throw new Error('A different investigation already uses the included baseline run ID.');
  }

  const previous = storage.getItem(STORAGE_KEY);
  if (!existing) saveInvestigation(getStorage, baseline);
  const stored = storage.getItem(STORAGE_KEY);
  try {
    // No replacement is authorized. The storage helper checks the pin again
    // even if it changed after the reviewer inspected the package.
    saveWorkflowBaseline(getStorage, expected.codex.workflow, baseline, expected.report.baselineFingerprint);
  } catch (error) {
    if (!existing && storage.getItem(STORAGE_KEY) === stored) {
      if (previous === null) storage.removeItem(STORAGE_KEY);
      else storage.setItem(STORAGE_KEY, previous);
    }
    throw error;
  }
  return baseline;
}

export async function attachInvoiceFollowUp(getStorage, expected, evidence) {
  if (!expected.invoice || !expected.decision) throw new Error('Save an invoice review decision first.');
  requireFolderPin(getStorage, expected);
  if (!(await assessReview(expected)).verdict) throw new Error('Restore the original baseline and candidate evidence.');
  const original = await assessSavedInvoice(expected);
  const corrected = await assessInvoiceFolder(evidence);
  if (original.caseId !== corrected.caseId) throw new Error('Choose a follow-up folder for the same invoice case.');
  if (!corrected.candidate) throw new Error('The follow-up needs an investigation that matches its manifest.');
  const report = await comparisonReport(expected.baseline, expected.report.baselineFingerprint, corrected.candidate);
  const invoice = await invoiceSnapshot(expected.invoice.workflow, evidence, corrected.output);
  const followUp = { id: await reviewId(report, invoice), report, candidate: corrected.candidate, invoice };
  if (!sameInvoiceCandidate(expected.report, followUp.report)) {
    throw new Error('The follow-up changed the investigation under the original run ID. Use the original investigation or a new run ID.');
  }

  requireFolderPin(getStorage, expected);
  const resolution = expected.followUp?.id === followUp.id ? expected.resolution : undefined;
  return updateCase(getStorage, expected, { followUp, resolution });
}

function sameCodexWork(original, candidate) {
  // The importer verifies a single preflight action against before.md. Event
  // and tool-call identifiers can change between runs of the same task.
  const preflight = chain => chain.events.find(event => event.parentEventId === null && event.evidence.tool === 'preflight_read');
  const before = preflight(original);
  const after = preflight(candidate);
  return before && after && before.actor === after.actor && before.action.resource === after.action.resource
    && before.evidence.artifactSha256 === after.evidence.artifactSha256;
}

export async function attachCodexFollowUp(getStorage, expected, evidence) {
  if (!expected.codex || !expected.decision) throw new Error('Save a Codex review decision before attaching a follow-up folder.');
  requireFolderPin(getStorage, expected);
  const original = await assessReview(expected);
  if (!original.codex || !original.verdict || original.verdict.status === 'pass') {
    throw new Error('The original Codex comparison must reproduce a flagged result before attaching a follow-up.');
  }

  const { candidate, codex } = await codexSnapshot(expected.codex.workflow, evidence);
  if (!sameCodexWork(original.codex.chain, candidate)) {
    throw new Error('Choose a Codex follow-up for the same preflight actor, resource and starting document.');
  }
  const report = await comparisonReport(expected.baseline, expected.report.baselineFingerprint, candidate);
  if (!distinctCandidate(expected.report, report)) throw new Error('Choose a follow-up with its own candidate run ID.');
  const followUp = { id: await reviewId(report, undefined, codex), report, candidate, codex };
  requireFolderPin(getStorage, expected);
  const resolution = expected.followUp?.id === followUp.id ? expected.resolution : undefined;
  const changes = { followUp, resolution };
  if (expected.senderHistory && expected.followUp?.id !== followUp.id) {
    // Keep the original receipt repairs when a new follow-up replaces the
    // one named by the sender's closure.
    const item = { ...expected, followUp };
    const entries = expected.senderHistory.entries.filter(entry => historyEntryMatchesCase(entry, item));
    changes.senderHistory = entries.length ? { caseId: item.id, entries } : undefined;
  }
  return updateCase(getStorage, expected, changes);
}

const resolutionFor = item => item.invoice || item.codex
  ? runFingerprint({ original: item.id, decision: item.decision, followUp: item.followUp.id })
  : item.followUp.id;

export async function assessFollowUp(item, original, getStorage) {
  const { followUp } = item;
  const originalInvoice = item.invoice ? await inspectInvoice(item) : undefined;
  const flagged = Boolean((original.verdict && original.verdict.status !== 'pass')
    || (originalInvoice && !invoicePasses(originalInvoice.checked)));
  const pinState = item.codex || (item.invoice && getStorage) ? folderPinState(getStorage, item) : undefined;
  const pinChanged = Boolean(pinState && pinState.status !== 'matched');
  const open = { originalInvoice, flagged, pinState, pinChanged, canResolve: false, resolved: false };
  if (!followUp) return open;
  if (!sameBaseline(item.report, followUp.report)) return { ...open, incompatible: 'baseline' };
  if (Boolean(item.codex) !== Boolean(followUp.codex) || Boolean(item.invoice) !== Boolean(followUp.invoice)
    || (item.codex && item.codex.workflow !== followUp.codex.workflow)) return { ...open, incompatible: 'candidate' };
  const compatible = item.invoice ? sameInvoiceCandidate(item.report, followUp.report) : distinctCandidate(item.report, followUp.report);
  if (!compatible) return { ...open, incompatible: 'candidate' };

  const record = { ...followUp, baseline: item.baseline };
  let assessment;
  try { assessment = await assessReview(record); }
  catch (error) {
    if (item.codex) return { ...open, error: `Follow-up Codex evidence: ${error.message}` };
  }
  if (item.codex && (!original.codex || !assessment?.codex
    || !sameCodexWork(original.codex.chain, assessment.codex.chain))) return { ...open, assessment, incompatible: 'candidate' };
  const invoice = followUp.invoice ? await inspectInvoice(record) : undefined;
  const passingFollowUp = item.invoice ? invoiceFollowUpPasses(item, { assessment, invoice, originalInvoice })
    : followUp.report.status === 'pass' && assessment?.verdict?.status === 'pass';
  const passes = Boolean(item.decision && original.verdict && flagged && passingFollowUp);
  const resolved = passes && item.resolution === await resolutionFor(item);
  if (item.codex) {
    // Reload and explicit closure both require the original pin. Read it after
    // receipt verification so a change during hashing cannot restore closure.
    const pinState = folderPinState(getStorage, item);
    const pinChanged = pinState.status !== 'matched';
    return { ...open, assessment, pinState, pinChanged, passes, canResolve: passes && !pinChanged, resolved: resolved && !pinChanged };
  }
  return { ...open, assessment, invoice, passes, canResolve: passes && !pinChanged, resolved };
}

function invoiceFollowUpPasses(item, checked) {
  return checked.assessment?.verdict?.status === 'pass' && item.followUp?.report.status === 'pass'
    && checked.originalInvoice.checked && invoicePasses(checked.invoice?.checked)
    && checked.originalInvoice.checked.caseId === checked.invoice.checked.caseId
    && item.invoice.workflow === item.followUp.invoice.workflow;
}

async function matchingCodexOriginalRepair(item, contents) {
  if (!item.codex) throw new Error('Choose a saved Codex case to repair its original receipts.');
  const { bundle, reportText, evidence } = readReviewPackage(contents, true);
  if (bundle.kind !== codexCaseKind) throw new Error('Choose a Codex review case exported with receipts.');
  const report = parseRegressionReport(reportText);
  const donor = portableCodex(bundle.codex);
  // The case ID binds the complete report, workflow and original snapshot fingerprint.
  if (await reviewId(report, undefined, donor) !== item.id
    || await reviewId(item.report, undefined, item.codex) !== item.id) {
    throw new Error('This export does not match the saved Codex case. Check its original baseline, run, workflow and receipt snapshot.');
  }
  for (const side of sides) {
    if (await evidenceState(report, side, evidence[side]) !== 'matched') {
      throw new Error(`The export needs the matching original ${side} investigation.`);
    }
  }

  const saved = item.codex.evidence;
  const { hashes, files } = donor.evidence;
  if (saved?.hashes !== undefined && (!saved.hashes || Object.keys(saved.hashes).length !== Object.keys(hashes).length
    || Object.keys(hashes).some(name => hashes[name] !== saved.hashes[name]))) {
    throw new Error('The export does not match the original Codex manifest digests recorded in this case.');
  }
  // Rehash the donor bytes and reproduce the original comparison using the local
  // investigations. The donor's decision, notes, follow-up and closure are never copied.
  const codex = { ...item.codex, evidence: {
    ...saved, hashes: saved?.hashes ?? hashes, files: { ...saved?.files, ...files },
  } };
  const original = await assessReview({ ...item, codex });
  if (!original.codex || original.verdict.status !== item.report.status) {
    throw new Error('The verified receipts must reproduce the original result against the saved baseline and candidate.');
  }
  const restored = Object.keys(files).filter(name => files[name] !== saved?.files?.[name]);
  if (!restored.length) throw new Error('No original Codex receipt files need repair.');
  return { codex, restored };
}

export async function previewCodexOriginalRepair(getStorage, expected, contents) {
  const { restored } = await matchingCodexOriginalRepair(expected, contents);
  requireCurrentReview(readReviews(getStorage()), expected);
  return { restored, pinState: folderPinState(getStorage, expected) };
}

export async function applyCodexOriginalRepair(getStorage, expected, contents) {
  const { codex, restored } = await matchingCodexOriginalRepair(expected, contents);
  const files = await Promise.all(restored.map(async name => ({
    name,
    before: await previousCodexReceiptDigest(expected.codex.evidence?.files, name),
    after: codex.evidence.hashes[name],
  })));
  const entry = { kind: 'repair', at: new Date().toISOString(), files };
  return updateCase(getStorage, expected, { codex, resolution: undefined, localHistory: [...(expected.localHistory ?? []), entry] });
}

export async function previewInvoiceEvidenceRestore(getStorage, item, contents) {
  if (!item.invoice || !item.decision) throw new Error('Save an invoice review decision before restoring evidence.');
  const { bundle, reportText, evidence } = readReviewPackage(contents, true);
  if (bundle.kind !== invoiceCaseKind) throw new Error('Choose an invoice review case exported with receipts.');
  const report = parseRegressionReport(reportText);
  const invoice = portableInvoice(bundle.invoice);
  if (await reviewId(report, invoice) !== item.id) {
    throw new Error('This file belongs to a different invoice case. Choose a copy with the original report, workflow, and receipt snapshot.');
  }
  const replacement = { ...item, baseline: evidence.baseline, candidate: evidence.candidate, invoice };
  const original = await assessReview(replacement);
  if (!original.verdict) throw new Error('The replacement needs the original baseline and candidate investigations with matching fingerprints.');
  await assessSavedInvoice(replacement);

  const currentOriginal = await assessReview(item);
  const currentChecks = await assessFollowUp(item, currentOriginal);
  if (currentChecks.resolved) throw new Error('This invoice case is already resolved.');
  const changes = {};
  const restored = [];
  for (const side of sides) {
    if (currentOriginal.states[side] !== 'matched') {
      changes[side] = evidence[side];
      restored.push(side === 'baseline' ? 'Baseline investigation' : 'Candidate investigation');
    }
  }
  if (changes.baseline) changes.suppliedBaseline = undefined;
  if (!currentChecks.originalInvoice.checked) {
    changes.invoice = invoice;
    restored.push('Original receipt snapshot');
  }

  const repaired = { ...item, ...changes, resolution: undefined };
  const repairedOriginal = await assessReview(repaired);
  let checks = await assessFollowUp(repaired, repairedOriginal);
  if (!invoiceFollowUpPasses(repaired, checks)) {
    const followUp = bundle.followUp === undefined ? undefined : await readInvoiceFollowUp(item.report, bundle.followUp);
    if (!followUp) throw new Error('The replacement needs a matching follow-up checked against the original baseline.');
    changes.followUp = repaired.followUp = followUp;
    restored.push('Follow-up investigation and receipts');
    checks = await assessFollowUp(repaired, repairedOriginal);
  }
  if (!invoiceFollowUpPasses(repaired, checks)) {
    throw new Error('The replacement follow-up did not pass the baseline comparison and invoice receipt checks.');
  }
  if (!restored.length) throw new Error('The saved case already has matching evidence.');
  if (!checks.passes) throw new Error('The restored evidence does not reproduce an open case with a passing follow-up.');

  return { restored, changes, pinState: folderPinState(getStorage, item) };
}

export async function restoreInvoiceEvidence(getStorage, expected, contents) {
  const { changes } = await previewInvoiceEvidenceRestore(getStorage, expected, contents);
  return updateCase(getStorage, expected, { ...changes, resolution: undefined });
}

export async function resolveReviewCase(getStorage, expected) {
  if (expected.codex) requireFolderPin(getStorage, expected);
  const { canResolve, resolved } = await assessFollowUp(expected, await assessReview(expected), expected.codex ? getStorage : undefined);
  if (!canResolve) throw new Error(expected.invoice
    ? 'Closure requires matching baseline evidence and a passing invoice follow-up with verified receipts.'
    : 'Resolution requires a passing follow-up with matching evidence against the original pinned baseline.');
  const resolution = await resolutionFor(expected);
  if (expected.codex || expected.invoice) requireFolderPin(getStorage, expected);
  if (expected.codex) {
    if (resolved) throw new Error('This Codex case is already resolved.');
    const { baselineId, baselineFingerprint, candidateId, candidateFingerprint } = expected.followUp.report;
    const entry = { kind: 'closure', at: new Date().toISOString(), baselineId, baselineFingerprint,
      followUpId: candidateId, followUpFingerprint: candidateFingerprint };
    return updateCase(getStorage, expected, { resolution, localHistory: [...(expected.localHistory ?? []), entry] });
  }
  return updateCase(getStorage, expected, { resolution });
}

export async function assessReview(item) {
  const { report, baseline, candidate } = item;
  if (await reviewId(report, item.invoice, item.codex) !== item.id) throw new Error('The saved report no longer matches this inbox item.');
  let codex;
  if (item.codex) {
    const checked = await assessCodexEvidence(item.codex.evidence);
    if (await runFingerprint(checked.evidence) !== item.codex.fingerprint
      || await evidenceState(report, 'candidate', checked.chain) !== 'matched') {
      throw new Error('Saved Codex evidence no longer matches the candidate snapshot. Reimport the original folder.');
    }
    codex = checked;
  }
  const states = {
    baseline: await evidenceState(report, 'baseline', baseline),
    candidate: await evidenceState(report, 'candidate', candidate),
  };
  if (states.baseline !== 'matched' || states.candidate !== 'matched') return { states };
  const baselineResult = evaluateChain(baseline);
  if (baseline.id === candidate.id || !canPinBaseline(baseline, baselineResult)) return { states };
  const candidateResult = evaluateChain(candidate);
  const groups = compareRuns(baseline, candidate, baselineResult, candidateResult);
  const assessment = { states, groups, candidateResult, verdict: checkRegression(groups, candidateResult) };
  if (codex) assessment.codex = codex;
  return assessment;
}
