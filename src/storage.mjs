// Browser-local evidence is untrusted input, including after a reload.
import { MAX_IMPORT_BYTES, parseInvestigation, mergeInvestigation } from './import.mjs';

export const STORAGE_KEY = 'adcp.investigations.v1';
export const WORKFLOW_BASELINE_KEY = 'adcp.workflow-baselines.v1';
export const MAX_SAVED_RUNS = 20;
export const MAX_STORAGE_BYTES = 2 * MAX_IMPORT_BYTES;
const MAX_WORKFLOW_NAME = 80;
const MAX_BASELINE_BYTES = 12 * 1024;
const bytes = value => new TextEncoder().encode(value).length;

function read(getStorage) {
  const raw = getStorage().getItem(STORAGE_KEY);
  if (raw === null) return { chains: [], skipped: 0 };
  if (raw.length > MAX_STORAGE_BYTES || bytes(raw) > MAX_STORAGE_BYTES) throw new Error('Saved runs exceed the local storage limit.');
  const saved = JSON.parse(raw);
  if (saved?.schemaVersion !== 1 || !Array.isArray(saved.runs) || saved.runs.length > MAX_SAVED_RUNS) throw new Error('Unsupported saved-run collection.');
  const chains = [];
  let skipped = 0;
  for (const envelope of saved.runs) {
    try {
      const chain = parseInvestigation(JSON.stringify(envelope));
      if (chains.some(item => item.id === chain.id)) throw new Error('Duplicate saved run.');
      chains.push(chain);
    } catch { skipped++; }
  }
  return { chains, skipped };
}

export function restoreInvestigations(getStorage) {
  try {
    const restored = read(getStorage);
    return { chains: restored.chains, warning: restored.skipped ? 'Some saved runs could not be restored. Reimport their original files, or clear imported runs to reset local storage.' : '' };
  } catch {
    return { chains: [], warning: 'Saved runs could not be read. Browser storage may be unavailable or damaged. The examples still work; clear imported runs to reset local storage.' };
  }
}

export function saveInvestigation(getStorage, chain) {
  // Merge against the latest stored collection so another tab's imports survive.
  // Never silently overwrite unreadable records or evict an older investigation.
  const stored = read(getStorage);
  if (stored.skipped) throw new Error('Some saved records are unreadable. Clear imported runs before saving again.');
  const imported = parseInvestigation(JSON.stringify({ schemaVersion: 1, chain }));
  const merged = mergeInvestigation(stored.chains, imported);
  if (merged.length > MAX_SAVED_RUNS) throw new Error(`Local storage holds at most ${MAX_SAVED_RUNS} runs. Clear imported runs before saving more.`);
  const raw = JSON.stringify({ schemaVersion: 1, runs: merged.map(item => ({ schemaVersion: 1, chain: item })) });
  if (bytes(raw) > MAX_STORAGE_BYTES) throw new Error('Saved runs would exceed 2 MiB. Clear imported runs before saving more.');
  getStorage().setItem(STORAGE_KEY, raw);
}

export function clearInvestigations(getStorage) {
  // Leave every other application's storage untouched.
  getStorage().removeItem(STORAGE_KEY);
}

export const workflowKey = name => name.trim().toLowerCase();
const validWorkflowName = name => typeof name === 'string' && name === name.trim()
  && name.length > 0 && name.length <= MAX_WORKFLOW_NAME && !/[\u0000-\u001f\u007f]/.test(name);
const validRunId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(id);
const validFingerprint = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function readWorkflowBaselines(getStorage) {
  const raw = getStorage().getItem(WORKFLOW_BASELINE_KEY);
  if (raw === null) return [];
  if (raw.length > MAX_BASELINE_BYTES || bytes(raw) > MAX_BASELINE_BYTES) throw new Error('Saved workflows exceed the storage limit.');
  const data = JSON.parse(raw);
  if (data?.schemaVersion !== 1 || !Array.isArray(data.baselines) || data.baselines.length > MAX_SAVED_RUNS) {
    throw new Error('Unsupported saved workflows.');
  }
  const seen = new Set();
  return data.baselines.map(item => {
    if (!validWorkflowName(item?.name) || !validRunId(item.runId) || !validFingerprint(item.fingerprint)) {
      throw new Error('A saved workflow is invalid.');
    }
    const key = workflowKey(item.name);
    if (seen.has(key)) throw new Error('Duplicate saved workflow.');
    seen.add(key);
    return { name: item.name, runId: item.runId, fingerprint: item.fingerprint };
  });
}

export function restoreWorkflowBaselines(getStorage) {
  try {
    return { baselines: readWorkflowBaselines(getStorage), warning: '' };
  } catch {
    return { baselines: [], warning: 'Saved workflows could not be read. Check browser site storage.' };
  }
}

function writeWorkflowBaselines(getStorage, baselines) {
  const raw = JSON.stringify({ schemaVersion: 1, baselines });
  if (bytes(raw) > MAX_BASELINE_BYTES) throw new Error('Saved workflows exceed the storage limit.');
  getStorage().setItem(WORKFLOW_BASELINE_KEY, raw);
  return baselines;
}

export async function runFingerprint(chain) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(chain)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function saveWorkflowBaseline(getStorage, name, chain, fingerprint, expectedBaseline) {
  const normalized = name.trim();
  if (!validWorkflowName(normalized)) throw new Error('Enter a workflow name of 1–80 characters without control characters.');
  if (!validRunId(chain.id) || !validFingerprint(fingerprint)) throw new Error('Could not pin this run.');
  if (chain.imported && !read(getStorage).chains.some(item => JSON.stringify(item) === JSON.stringify(chain))) {
    throw new Error('Import and save this run in the browser before pinning it as a baseline.');
  }
  const key = workflowKey(normalized);
  const baselines = readWorkflowBaselines(getStorage);
  const current = baselines.find(item => workflowKey(item.name) === key);
  if (JSON.stringify(current) !== JSON.stringify(expectedBaseline)) {
    throw new Error('This saved workflow changed. Review its baseline before trying again.');
  }
  const next = baselines.filter(item => workflowKey(item.name) !== key);
  if (next.length >= MAX_SAVED_RUNS) throw new Error(`Remove a saved workflow before adding another. The limit is ${MAX_SAVED_RUNS}.`);
  next.push({ name: normalized, runId: chain.id, fingerprint });
  return writeWorkflowBaselines(getStorage, next);
}

export function removeWorkflowBaseline(getStorage, baseline) {
  const baselines = readWorkflowBaselines(getStorage);
  const key = workflowKey(baseline.name);
  const current = baselines.find(item => workflowKey(item.name) === key);
  if (JSON.stringify(current) !== JSON.stringify(baseline)) throw new Error('This saved workflow changed. Select it again before removing it.');
  return writeWorkflowBaselines(getStorage, baselines.filter(item => workflowKey(item.name) !== key));
}
