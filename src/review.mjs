// Reports are recorded claims. Only matching evidence can reproduce a verdict.
import { canPinBaseline, checkRegression, compareRuns, regressionLabels } from './comparison.mjs';
import { evaluateChain } from './evaluator.mjs';
import { parseInvestigation } from './import.mjs';
import { assessInvoiceFolder, portableInvoiceEvidence } from './invoice-import.mjs';
import { restoreInvestigations, restoreWorkflowBaselines, runFingerprint, workflowKey } from './storage.mjs';

export const REVIEW_STORAGE_KEY = 'adcp.regression-reviews.v1';
export const MAX_REPORT_BYTES = 2 * 1024 * 1024;
export const MAX_REVIEW_PACKAGE_BYTES = MAX_REPORT_BYTES;
export const MAX_REVIEW_NOTE = 1200;
export const reviewDecisions = Object.freeze({
  'fix-required': 'Fix required',
  'evidence-needed': 'Evidence needed',
  'expected-change': 'Expected change',
});
const packageKind = 'adcp-review-package';
const caseKind = 'adcp-review-case';
const invoiceCaseKind = 'adcp-invoice-review-case';
const MAX_REVIEWS = 20;
const sides = ['baseline', 'candidate'];
const reviewFields = ['report', 'note', 'reviewed', ...sides, 'decision', 'followUp', 'resolution', 'invoice', 'suppliedBaseline'];
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

export async function createReviewCase(item, note, { includeInvoiceReceipts = false } = {}) {
  const withReceipts = Boolean(item.invoice && includeInvoiceReceipts === true);
  const bundle = await reviewBundle(withReceipts ? invoiceCaseKind : caseKind, item.report, item, note);
  if (item.decision) bundle.decision = validateDecision(item.decision.kind, item.decision.reason);
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
  const kinds = allowCase ? [packageKind, caseKind, invoiceCaseKind] : [packageKind];
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
    }
    if (item.resolution !== undefined) {
      if (!isFingerprint(item.resolution)) throw new Error('The saved resolution is invalid.');
      restored.resolution = item.resolution;
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

function reviewId(report, invoice) {
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

async function invoiceComparison(baseline, fingerprint, workflow, evidence, { candidate, output }) {
  if (baseline.id === candidate.id) throw new Error('Choose a candidate with a different run ID from the baseline.');
  const original = evaluateChain(baseline);
  if (!canPinBaseline(baseline, original)) throw new Error('The pinned baseline no longer qualifies for comparison.');
  const next = evaluateChain(candidate);
  const { status, reasons } = checkRegression(compareRuns(baseline, candidate, original, next), next);
  const report = parseRegressionReport(JSON.stringify({
    schemaVersion: 1, status,
    reasons: reasons.map(({ impact, message, eventId, row }) => ({
      impact, message, baselineEventId: row?.eventLinks?.[0], candidateEventId: eventId ?? row?.eventLinks?.[1],
    })),
    baselineId: baseline.id, baselineFingerprint: fingerprint,
    candidateId: candidate.id, candidateFingerprint: await runFingerprint(candidate),
  }));
  const invoice = { workflow, outputAtImport: output.label, evidence, fingerprint: await runFingerprint(evidence) };
  return { id: await reviewId(report, invoice), report, candidate, invoice };
}

export async function saveInvoiceCandidate(getStorage, pin, evidence) {
  const { candidate, output } = await assessInvoiceFolder(evidence);
  if (!candidate) throw new Error('The candidate needs an investigation that matches the invoice manifest.');
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
  const { id, report, invoice } = await invoiceComparison(baseline, pin.fingerprint, pin.name, evidence, { candidate, output });
  // Check again after hashing so a concurrent pin or baseline change cannot
  // save a comparison against a run the reviewer did not select.
  const storage = getStorage();
  const items = readReviews(storage);
  pinChanged();
  if (JSON.stringify(readBaseline()) !== JSON.stringify(baseline)) {
    throw new Error('The saved baseline investigation changed. Reimport the original run before trying again.');
  }
  const current = items.find(item => item.id === id);
  const item = { note: '', reviewed: false, ...current, id, report, baseline, candidate, invoice };
  writeReviews(storage, [item, ...items.filter(record => record.id !== id)]);
  return id;
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
    if (warning || (pin && !invoicePinMatches(getStorage, incoming))) {
      warnings.push('The saved workflow uses a different baseline or could not be read. Closure was not restored.');
    } else if (resolution && bundle.resolution === resolution) incoming.resolution = resolution;
    else warnings.push('Invoice closure could not be verified.');
  }
}

export async function importReview(getStorage, reportText, evidence, initialNote = '', portableCase) {
  const report = parseRegressionReport(reportText);
  const invoice = portableCase?.kind === invoiceCaseKind ? portableInvoice(portableCase.invoice) : undefined;
  const id = await reviewId(report, invoice);
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

function invoicePinState(getStorage, item) {
  const { baselines, warning } = restoreWorkflowBaselines(getStorage);
  if (warning) return { status: 'unreadable' };
  const pin = baselines.find(pin => workflowKey(pin.name) === workflowKey(item.invoice.workflow));
  if (!pin) return { status: 'missing' };
  const matching = pin.runId === item.report.baselineId && pin.fingerprint === item.report.baselineFingerprint;
  return { status: matching ? 'matched' : 'conflict', pin };
}

function invoicePinMatches(getStorage, item) {
  return invoicePinState(getStorage, item).status === 'matched';
}

function requireInvoicePin(getStorage, item) {
  if (!invoicePinMatches(getStorage, item)) {
    throw new Error('The workflow uses a different baseline or is unavailable. Restore the original pin before continuing.');
  }
}

export async function attachInvoiceFollowUp(getStorage, expected, evidence) {
  if (!expected.invoice || !expected.decision) throw new Error('Save an invoice review decision first.');
  requireInvoicePin(getStorage, expected);
  if (!(await assessReview(expected)).verdict) throw new Error('Restore the original baseline and candidate evidence.');
  const original = await assessSavedInvoice(expected);
  const corrected = await assessInvoiceFolder(evidence);
  if (original.caseId !== corrected.caseId) throw new Error('Choose a follow-up folder for the same invoice case.');
  if (!corrected.candidate) throw new Error('The follow-up needs an investigation that matches its manifest.');
  const followUp = await invoiceComparison(expected.baseline, expected.report.baselineFingerprint,
    expected.invoice.workflow, evidence, corrected);
  if (!sameInvoiceCandidate(expected.report, followUp.report)) {
    throw new Error('The follow-up changed the investigation under the original run ID. Use the original investigation or a new run ID.');
  }

  requireInvoicePin(getStorage, expected);
  const resolution = expected.followUp?.id === followUp.id ? expected.resolution : undefined;
  return updateCase(getStorage, expected, { followUp, resolution });
}

const resolutionFor = item => item.invoice
  ? runFingerprint({ original: item.id, decision: item.decision, followUp: item.followUp.id })
  : item.followUp.id;

export async function assessFollowUp(item, original, getStorage) {
  const { followUp } = item;
  const originalInvoice = item.invoice ? await inspectInvoice(item) : undefined;
  const flagged = Boolean((original.verdict && original.verdict.status !== 'pass')
    || (originalInvoice && !invoicePasses(originalInvoice.checked)));
  const pinState = item.invoice && getStorage ? invoicePinState(getStorage, item) : undefined;
  const pinChanged = Boolean(pinState && pinState.status !== 'matched');
  const open = { originalInvoice, flagged, pinState, pinChanged, canResolve: false, resolved: false };
  if (!followUp) return open;
  if (!sameBaseline(item.report, followUp.report)) return { ...open, incompatible: 'baseline' };
  const compatible = item.invoice ? followUp.invoice && sameInvoiceCandidate(item.report, followUp.report)
    : !followUp.invoice && distinctCandidate(item.report, followUp.report);
  if (!compatible) return { ...open, incompatible: 'candidate' };

  const record = { ...followUp, baseline: item.baseline };
  const assessment = await assessReview(record).catch(() => undefined);
  const invoice = followUp.invoice ? await inspectInvoice(record) : undefined;
  const passingFollowUp = item.invoice ? invoiceFollowUpPasses(item, { assessment, invoice, originalInvoice })
    : followUp.report.status === 'pass' && assessment?.verdict?.status === 'pass';
  const passes = Boolean(item.decision && original.verdict && flagged && passingFollowUp);
  return { ...open, assessment, invoice, passes, canResolve: passes && !pinChanged,
    resolved: passes && item.resolution === await resolutionFor(item) };
}

function invoiceFollowUpPasses(item, checked) {
  return checked.assessment?.verdict?.status === 'pass' && item.followUp?.report.status === 'pass'
    && checked.originalInvoice.checked && invoicePasses(checked.invoice?.checked)
    && checked.originalInvoice.checked.caseId === checked.invoice.checked.caseId
    && item.invoice.workflow === item.followUp.invoice.workflow;
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

  return { restored, changes, pinState: invoicePinState(getStorage, item) };
}

export async function restoreInvoiceEvidence(getStorage, expected, contents) {
  const { changes } = await previewInvoiceEvidenceRestore(getStorage, expected, contents);
  return updateCase(getStorage, expected, { ...changes, resolution: undefined });
}

export async function resolveReviewCase(getStorage, expected) {
  const { canResolve } = await assessFollowUp(expected, await assessReview(expected));
  if (!canResolve) throw new Error(expected.invoice
    ? 'Closure requires matching baseline evidence and a passing invoice follow-up with verified receipts.'
    : 'Resolution requires a passing follow-up with matching evidence against the original pinned baseline.');
  const resolution = await resolutionFor(expected);
  if (expected.invoice) requireInvoicePin(getStorage, expected);
  return updateCase(getStorage, expected, { resolution });
}

export async function assessReview(item) {
  const { report, baseline, candidate } = item;
  if (await reviewId(report, item.invoice) !== item.id) throw new Error('The saved report no longer matches this inbox item.');
  const states = {
    baseline: await evidenceState(report, 'baseline', baseline),
    candidate: await evidenceState(report, 'candidate', candidate),
  };
  if (states.baseline !== 'matched' || states.candidate !== 'matched') return { states };
  const baselineResult = evaluateChain(baseline);
  if (baseline.id === candidate.id || !canPinBaseline(baseline, baselineResult)) return { states };
  const candidateResult = evaluateChain(candidate);
  const groups = compareRuns(baseline, candidate, baselineResult, candidateResult);
  return { states, groups, candidateResult, verdict: checkRegression(groups, candidateResult) };
}
