// Reports are recorded claims. Only matching evidence can reproduce a verdict.
import { canPinBaseline, checkRegression, compareRuns, regressionLabels } from './comparison.mjs';
import { evaluateChain } from './evaluator.mjs';
import { parseInvestigation } from './import.mjs';
import { runFingerprint } from './storage.mjs';

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
const MAX_REVIEWS = 20;
const sides = ['baseline', 'candidate'];
const reviewFields = ['report', 'note', 'reviewed', ...sides, 'decision', 'followUp', 'resolution'];
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

export async function createReviewPackage(report, evidence, note) {
  const normalized = parseRegressionReport(JSON.stringify(report));
  const bundle = { kind: packageKind, schemaVersion: 1, report: normalized };
  for (const side of sides) {
    if (await evidenceState(normalized, side, evidence[side]) === 'matched') {
      bundle[side] = { schemaVersion: 1, chain: normalizeEvidence(evidence[side]) };
    }
  }
  if (note !== undefined) {
    if (typeof note !== 'string' || note.length > MAX_REVIEW_NOTE) throw new Error('The review note is invalid.');
    if (note.trim()) bundle.note = note.trim();
  }
  const raw = JSON.stringify(bundle);
  if (bytes(raw) > MAX_REVIEW_PACKAGE_BYTES) throw new Error('The review package exceeds 2 MiB.');
  return raw;
}

function readReviewPackage(contents) {
  if (typeof contents !== 'string' || contents.length > MAX_REVIEW_PACKAGE_BYTES || bytes(contents) > MAX_REVIEW_PACKAGE_BYTES) {
    throw new Error('Choose a review package no larger than 2 MiB.');
  }
  let bundle;
  try { bundle = JSON.parse(contents); } catch { throw new Error('The review package is not valid JSON.'); }
  if (bundle?.kind !== packageKind || bundle.schemaVersion !== 1) throw new Error('Expected a version 1 review package.');
  if (bundle.note !== undefined && (typeof bundle.note !== 'string' || bundle.note.length > MAX_REVIEW_NOTE)) {
    throw new Error('The review note in the package is invalid.');
  }
  const evidence = {};
  for (const side of sides) {
    if (bundle[side] !== undefined) evidence[side] = parseInvestigation(JSON.stringify(bundle[side]));
  }
  return { reportText: JSON.stringify(bundle.report), evidence, note: bundle.note?.trim() };
}

export function importReviewPackage(getStorage, contents) {
  const { reportText, evidence, note } = readReviewPackage(contents);
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
    }
    if (item.resolution !== undefined) {
      if (!isFingerprint(item.resolution)) throw new Error('The saved resolution is invalid.');
      restored.resolution = item.resolution;
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

export async function importReview(getStorage, reportText, evidence, initialNote = '') {
  const report = parseRegressionReport(reportText);
  const id = await runFingerprint(report);
  const attachments = {};
  const mismatches = [];
  for (const side of sides) {
    if (!evidence[side] || !report[side + 'Fingerprint']) continue;
    if (await evidenceState(report, side, evidence[side]) === 'matched') attachments[side] = normalizeEvidence(evidence[side]);
    else mismatches.push(side);
  }
  const storage = getStorage();
  const items = readReviews(storage);
  const current = items.find(item => item.id === id);
  const next = { ...current, id, report, note: current?.note ?? initialNote, reviewed: current?.reviewed ?? false, ...attachments };
  for (const side of mismatches) next[side] ??= null;
  return { id, mismatches, items: writeReviews(storage, [next, ...items.filter(item => item.id !== id)]) };
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

export async function assessFollowUp(item, original) {
  const { followUp } = item;
  if (!followUp || !sameBaseline(item.report, followUp.report) || !distinctCandidate(item.report, followUp.report)) {
    return { canResolve: false, resolved: false };
  }
  const assessment = await assessReview({ ...followUp, baseline: item.baseline }).catch(() => undefined);
  const canResolve = Boolean(item.decision && original.verdict && original.verdict.status !== 'pass'
    && followUp.report.status === 'pass' && assessment?.verdict?.status === 'pass');
  return { assessment, canResolve, resolved: canResolve && item.resolution === followUp.id };
}

export async function resolveReviewCase(getStorage, expected) {
  const { canResolve } = await assessFollowUp(expected, await assessReview(expected));
  if (!canResolve) throw new Error('Resolution requires a passing follow-up with matching evidence against the original pinned baseline.');
  return updateCase(getStorage, expected, { resolution: expected.followUp.id });
}

export async function assessReview(item) {
  const { report, baseline, candidate } = item;
  if (await runFingerprint(report) !== item.id) throw new Error('The saved report no longer matches this inbox item.');
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
