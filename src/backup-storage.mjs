// A pending journal exposes the previous three collections until the final removal commits.
import { MAX_STORAGE_BYTES, STORAGE_KEY, WORKFLOW_BASELINE_KEY, runFingerprint } from './storage.mjs';
import { MAX_REPORT_BYTES, REVIEW_STORAGE_KEY } from './review.mjs';

export const JOURNAL = 'adcp.pending-backup-restore.v1';
export const collectionKeys = [STORAGE_KEY, WORKFLOW_BASELINE_KEY, REVIEW_STORAGE_KEY];
const limits = [MAX_STORAGE_BYTES, 12 * 1024, MAX_REPORT_BYTES];
const size = s => new TextEncoder().encode(s).length;
const stale = () => new Error('Saved data changed since preview. Preview the backup again.');
const blocked = () => new Error('Backup recovery is pending. Reload the dashboard before changing saved data.');

function readJournal(storage) {
  const raw = storage.getItem(JOURNAL);
  if (raw === null) return null;
  try {
    if (raw.length > 10 * 1024 * 1024) throw new Error();
    const { version, before, after } = JSON.parse(raw);
    if (version !== 1 || !Array.isArray(before) || !Array.isArray(after) || before.length !== 3 || after.length !== 3
      || before.some((s, i) => s !== null && (typeof s !== 'string' || size(s) > limits[i]))
      || after.some(h => typeof h !== 'string' || !/^[a-f0-9]{64}$/.test(h))) throw new Error();
    return { before, after };
  } catch {
    throw new Error('The backup recovery record is unreadable. Preserve this browser profile before making changes.');
  }
}

export function guardedStorage(storage) {
  return {
    getItem(key) {
      const i = collectionKeys.indexOf(key);
      const journal = i !== -1 && readJournal(storage);
      return journal ? journal.before[i] : storage.getItem(key);
    },
    setItem(key, value) {
      if (collectionKeys.includes(key) && storage.getItem(JOURNAL) !== null) throw blocked();
      storage.setItem(key, value);
    },
    removeItem(key) {
      if (collectionKeys.includes(key) && storage.getItem(JOURNAL) !== null) throw blocked();
      storage.removeItem(key);
    },
  };
}

const current = storage => collectionKeys.map(key => storage.getItem(key));
const same = (a, b) => a.every((v, i) => v === b[i]);
export function readBackupState(storage) {
  if (storage.getItem(JOURNAL) !== null) throw blocked();
  return current(storage);
}

function write(storage, key, value) {
  if (value === null) storage.removeItem(key);
  else storage.setItem(key, value);
}

function browserLock(action) {
  if (!globalThis.navigator?.locks) throw new Error('Use a browser with Web Locks support on loopback to restore a backup.');
  return navigator.locks.request(JOURNAL, action);
}

// Run the whole domain operation under the restore lock, including its last
// read of the collection. An older view can then save a note on one case
// without writing a pre-restore copy of all the other cases back to storage.
export function writeLocal(operation, ...args) {
  if (!globalThis.navigator?.locks) return operation(...args);
  return browserLock(() => operation(...args));
}

async function rollback(storage, journal) {
  const found = current(storage);
  const hashes = await Promise.all(found.map(runFingerprint));
  if (!same(found, current(storage)) || found.some((v, i) => v !== journal.before[i] && hashes[i] !== journal.after[i])) {
    throw new Error('Another tab changed saved data during restore. Recovery retained both versions. Preserve this profile before reconciling it.');
  }
  for (const [i, key] of collectionKeys.entries()) {
    if (found[i] !== journal.before[i]) write(storage, key, journal.before[i]);
  }
  storage.removeItem(JOURNAL);
}

export async function recoverBackupRestore(storage, lock = browserLock) {
  if (storage.getItem(JOURNAL) === null) return false;
  return lock(async () => {
    const journal = readJournal(storage);
    if (!journal) return false;
    await rollback(storage, journal);
    return true;
  });
}

export async function commitBackupState(storage, before, after, lock = browserLock) {
  const afterHashes = await Promise.all(after.map(runFingerprint));
  return lock(async () => {
    if (!same(before, readBackupState(storage))) throw stale();
    const journal = { version: 1, before, after: afterHashes };
    try {
      storage.setItem(JOURNAL, JSON.stringify(journal));
    } catch {
      throw new Error('The browser could not reserve restore space. The inbox and pins are unchanged.');
    }
    try {
      for (const [i, key] of collectionKeys.entries()) {
        if (storage.getItem(key) !== before[i]) throw stale();
        if (before[i] !== after[i]) write(storage, key, after[i]);
      }
      if (!same(after, current(storage))) throw stale();
      storage.removeItem(JOURNAL);
    } catch {
      try { await rollback(storage, journal); }
      catch (error) { throw new Error('Restore interrupted. Reload to retry recovery. ' + error.message); }
      throw new Error('The restore could not finish. The previous inbox, pins and runs were restored.');
    }
  });
}
