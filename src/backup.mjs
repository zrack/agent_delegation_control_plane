import { canPinBaseline } from './comparison.mjs';
import { evaluateChain } from './evaluator.mjs';
import { assessFollowUp, assessReview, createReviewCase, importReviewPackage, restoreReviews, reviewClosureState } from './review.mjs';
import { restoreInvestigations, restoreWorkflowBaselines, runFingerprint, saveInvestigation, saveWorkflowBaseline, workflowKey } from './storage.mjs';
import { collectionKeys, commitBackupState, readBackupState } from './backup-storage.mjs';

export const MAX_BACKUP_BYTES = 4 * 1024 * 1024;
const bytes = v => new TextEncoder().encode(v).length;
const workflow = item => (item.codex ?? item.invoice)?.workflow;
const nameFor = item => item.candidate?.title ?? item.report.candidateId ?? 'Saved regression report';
const bounded = (xs, min = 0) => Array.isArray(xs) && xs.length >= min && xs.length <= 20;
const unchanged = (a, b) => a.every((v, i) => v === b[i]);

function shadow(before = [null, null, null]) {
  const values = new Map(collectionKeys.map((key, i) => [key, before[i]]));
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  return () => storage;
}

function checkedContents(getStorage) {
  const reviews = restoreReviews(getStorage);
  const pins = restoreWorkflowBaselines(getStorage);
  const runs = restoreInvestigations(getStorage);
  const warning = reviews.warning || pins.warning || runs.warning;
  if (warning) throw new Error(warning);
  return { items: reviews.items, pins: pins.baselines, runs: runs.chains };
}

export function backupChoices(getStorage) {
  const { items, pins } = checkedContents(getStorage);
  return { cases: items.map(item => ({ id: item.id, title: nameFor(item), workflow: workflow(item), receipts: Boolean(item.codex || item.invoice) })),
    pins: pins.filter(pin => items.some(item => workflow(item) && workflowKey(workflow(item)) === workflowKey(pin.name)
      && item.report.baselineId === pin.runId && item.report.baselineFingerprint === pin.fingerprint)) };
}

export async function createBackup(storage, { caseIds, pinNames = [], receipts = false, notes = false, senderHistory = false }) {
  if (!bounded(caseIds, 1) || new Set(caseIds).size !== caseIds.length || !bounded(pinNames)
    || new Set(pinNames).size !== pinNames.length) throw new Error('Select one or more saved cases and distinct applicable pins.');
  if (senderHistory && !receipts) throw new Error('Sharing sender history also requires including receipts.');
  const before = readBackupState(storage);
  const get = shadow(before);
  const { items, pins } = checkedContents(get);
  const cases = [];
  const selected = [];
  for (const id of caseIds) {
    const item = items.find(row => row.id === id);
    if (!item) throw new Error('A selected case is unavailable. Refresh the case list.');
    if (workflow(item) && !receipts) throw new Error('Select “Include folder receipts” to back up a Codex or invoice case.');
    const serialized = await createReviewCase(item, notes ? item.note : undefined, {
      getStorage: get, includeCodexReceipts: receipts, includeInvoiceReceipts: receipts, includeSenderHistory: senderHistory,
    });
    const portable = JSON.parse(serialized);
    if (item.followUp && !portable.followUp) throw new Error('The selected follow-up could not be backed up with its evidence.');
    if (item.resolution && !portable.resolution) throw new Error('A saved closure could not be verified for backup. Check the current pin and receipts before exporting this case.');
    cases.push(portable);
    selected.push(item);
  }
  const includedPins = pinNames.map(name => {
    const pin = pins.find(p => p.name === name);
    if (!pin || !selected.some(item => workflow(item) && workflowKey(workflow(item)) === workflowKey(name)
      && item.baseline && item.report.baselineId === pin.runId && item.report.baselineFingerprint === pin.fingerprint)) {
      throw new Error('Choose pins whose matching baseline is present in the selected cases.');
    }
    return pin;
  });
  const raw = JSON.stringify({ kind: 'adcp-inbox-backup', schemaVersion: 1, cases, pins: includedPins });
  if (bytes(raw) > MAX_BACKUP_BYTES) throw new Error('This backup exceeds 4 MiB. Select fewer cases.');
  if (!unchanged(before, readBackupState(storage))) throw new Error('Saved data changed. Refresh the case list and export again.');
  return raw;
}

function parseBackup(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_BACKUP_BYTES || bytes(raw) > MAX_BACKUP_BYTES) throw new Error('Choose a backup no larger than 4 MiB.');
  let backup;
  try { backup = JSON.parse(raw); } catch { throw new Error('The backup is not valid JSON.'); }
  if (backup?.schemaVersion !== 1 || backup.kind !== 'adcp-inbox-backup' || !bounded(backup.cases, 1) || !bounded(backup.pins)) {
    throw new Error('Choose a version 1 inbox backup with 1–20 cases and up to 20 pins.');
  }
  return backup;
}

export async function inspectBackup(storage, raw) {
  const before = readBackupState(storage);
  const local = checkedContents(shadow(before));
  const backup = parseBackup(raw);
  const rows = [];
  const sources = [];
  for (const record of backup.cases) {
    if (!['adcp-review-case', 'adcp-codex-review-case', 'adcp-invoice-review-case'].includes(record?.kind)
      || Object.hasOwn(record, 'localHistory')) throw new Error('The backup contains an unsupported case.');
    const serialized = JSON.stringify(record);
    const { items: [item] } = await importReviewPackage(shadow(), serialized);
    if (rows.some(row => row.id === item.id)) throw new Error('The backup repeats a case identity.');
    rows.push({ id: item.id, title: nameFor(item), workflow: workflow(item), present: local.items.some(i => i.id === item.id),
      receipts: Boolean(item.codex || item.invoice), note: Boolean(item.note), senderEvents: item.senderHistory?.entries.length ?? 0 });
    sources.push(item);
  }
  const pins = [];
  for (const pin of backup.pins) {
    if (typeof pin?.name !== 'string' || !pin.name || pin.name !== pin.name.trim() || pin.name.length > 80
      || /[\u0000-\u001f\u007f]/.test(pin.name) || pins.some(p => workflowKey(pin.name) === workflowKey(p.name))) throw new Error('Invalid or duplicate workflow pin in backup.');
    const matching = sources.filter(item => workflow(item) && workflowKey(workflow(item)) === workflowKey(pin.name)
      && item.baseline && item.baseline.id === pin.runId && item.report.baselineFingerprint === pin.fingerprint);
    const baseline = matching[0]?.baseline;
    if (!baseline || await runFingerprint(baseline) !== pin.fingerprint || !canPinBaseline(baseline, evaluateChain(baseline))) {
      throw new Error('A backup pin lacks a matching, qualified baseline in its cases.');
    }
    const existing = local.pins.find(p => workflowKey(p.name) === workflowKey(pin.name));
    const run = local.runs.find(r => r.id === pin.runId);
    const runConflict = run && await runFingerprint(run) !== pin.fingerprint;
    const state = runConflict ? 'conflict' : existing
      ? (existing.runId === pin.runId && existing.fingerprint === pin.fingerprint ? 'matched' : 'conflict') : 'available';
    pins.push({ name: pin.name, runId: pin.runId, fingerprint: pin.fingerprint, state, existing,
      caseIds: matching.map(i => i.id), baseline });
  }
  if (!unchanged(before, readBackupState(storage))) throw new Error('Saved data changed while reading the backup. Open it again.');
  return { rows, pins, before, raw };
}

async function disposition(item, getStorage) {
  const original = await assessReview(item).catch(error => {
    if (!item.codex) throw error;
    return { error: error.message };
  });
  const follow = await assessFollowUp(item, original, getStorage);
  const labels = { resolved: 'Resolved', ready: 'Open · Ready to close', clear: 'No closure needed', blocked: 'Open' };
  return labels[reviewClosureState(item, original, follow)];
}

export async function previewRestore(storage, inspected, caseIds, pinNames = []) {
  if (!unchanged(inspected.before, readBackupState(storage))) throw new Error('Saved data changed. Open the backup again.');
  if (!bounded(caseIds) || !bounded(pinNames) || (!caseIds.length && !pinNames.length)
      || caseIds.length !== new Set(caseIds).size || pinNames.length !== new Set(pinNames).size) throw new Error('Choose distinct cases or pins to restore.');
  const backup = parseBackup(inspected.raw);
  const stage = shadow(inspected.before);
  for (const name of pinNames) {
    const p = inspected.pins.find(x => x.name === name);
    if (!p || p.state !== 'available' || !p.caseIds.some(id => caseIds.includes(id) || inspected.rows.find(r => r.id === id)?.present)) {
      throw new Error('Accept only an available pin for a selected or already saved case.');
    }
    const savedRun = restoreInvestigations(stage).chains.find(r => r.id === p.runId);
    if (savedRun && await runFingerprint(savedRun) !== p.fingerprint) throw new Error('A saved baseline uses the same ID with different evidence.');
    if (!savedRun) saveInvestigation(stage, p.baseline);
    saveWorkflowBaseline(stage, p.name, p.baseline, p.fingerprint);
  }
  const outcomes = [];
  for (const id of caseIds) {
    const index = inspected.rows.findIndex(row => row.id === id);
    if (index < 0 || inspected.rows[index].present) throw new Error('An existing case or unknown case cannot be restored over local work.');
    const { items: [item], caseWarnings, mismatches } = await importReviewPackage(stage, JSON.stringify(backup.cases[index]));
    outcomes.push({ title: inspected.rows[index].title, disposition: await disposition(item, stage),
      warnings: [...caseWarnings, ...mismatches.map(side => 'Unmatched ' + side + ' evidence.')] });
  }
  const old = shadow(inspected.before);
  const accepted = new Set(pinNames.map(workflowKey));
  for (const item of restoreReviews(old).items) {
    if (workflow(item) && accepted.has(workflowKey(workflow(item)))) {
      const previously = await disposition(item, old), now = await disposition(item, stage);
      outcomes.push({ title: nameFor(item), previously, disposition: now, warnings: [] });
    }
  }
  const after = readBackupState(stage());
  return { before: inspected.before, after, outcomes, pinNames: [...pinNames] };
}

export function applyRestore(storage, preview, lock) {
  return commitBackupState(storage, preview.before, preview.after, lock);
}
