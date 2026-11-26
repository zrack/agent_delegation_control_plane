import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { importInvoiceFolder } from '../../src/invoice-import.mjs';
import { parseInvestigation } from '../../src/import.mjs';
import { attachInvoiceFollowUp, createReviewCase, resolveReviewCase, restoreReviews, saveInvoiceCandidate, saveReviewDecision } from '../../src/review.mjs';
import { restoreWorkflowBaselines, runFingerprint, saveInvestigation, saveWorkflowBaseline } from '../../src/storage.mjs';

export function folder(id = 'SANDBOX-000000000001') {
  const stamp = '2026-01-01T00:00:00Z';
  const end = '2026-01-01T00:02:00Z';
  const scope = [
    { action: 'code:execute', resource: `sandbox:${id}` },
    { action: 'artifact:verify', resource: `sandbox:${id}:results.json` },
  ];
  const result = { invoice_count: 1, subtotal_cents: 100, tax_cents: 7, total_cents: 107 };
  const files = {
    'results.json': JSON.stringify(result),
    'expected.json': JSON.stringify(result),
    'validation.json': JSON.stringify({ passed: true, actual: result }),
    'execution.json': JSON.stringify({ status: 'completed', exit_code: 0, input_unchanged: true, cleaned: true }),
  };
  const evidence = scope.map(({ action }, index) => ({
    callId: 'call-' + index, tool: action, artifactSha256: digest(files['results.json']),
  }));
  const identity = { principal: 'owner', validFrom: stamp, expiresAt: end };
  files['investigation.json'] = JSON.stringify({ schemaVersion: 1, chain: {
    id, principal: { id: 'owner' }, rootGrantId: 'g1',
    grants: [
      { ...identity, id: 'g1', parentGrantId: null, issuer: 'owner', subject: 'Coder', capabilities: scope, canDelegate: true },
      { ...identity, id: 'g2', parentGrantId: 'g1', issuer: 'Coder', subject: 'Verifier', capabilities: [scope[1]], canDelegate: false },
    ],
    events: ['Coder', 'Verifier'].map((actor, index) => ({
      id: 'e' + (index + 1), actor, parentEventId: index ? 'e1' : null, authorityId: 'g' + (index + 1),
      action: { ...scope[index], outcome: 'completed', at: '2026-01-01T00:01:00Z' }, evidence: evidence[index],
    })),
  } });
  files['attempts.json'] = JSON.stringify(['Coder', 'Verifier'].map((actor, index) => ({
    actor, ...scope[index], callId: evidence[index].callId, outcome: 'allowed',
  })));
  return files;
}

const digest = text => createHash('sha256').update(text).digest('hex');
export const manifestFor = files => ({
  case: 'invoice-b',
  files: Object.fromEntries(Object.entries(files).map(([name, contents]) => [name, digest(contents)])),
});
export function selectedFiles(files, manifest = manifestFor(files)) {
  return Object.entries({ ...files, 'manifest.json': JSON.stringify(manifest) })
    .map(([name, contents]) => Object.assign(new Blob([contents]), { webkitRelativePath: 'invoice-b/' + name }));
}

export async function savedWorkflow() {
  const records = new Map();
  const getStorage = () => ({
    getItem: key => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
  });
  const baseline = parseInvestigation(folder()['investigation.json']);
  saveInvestigation(getStorage, baseline);
  saveWorkflowBaseline(getStorage, 'Invoices', baseline, await runFingerprint(baseline));
  return { getStorage, baseline, pin: restoreWorkflowBaselines(getStorage).baselines[0] };
}

export async function invoiceCases(directory) {
  const { getStorage, pin } = await savedWorkflow();
  const files = folder('SANDBOX-000000000002');
  const manifest = manifestFor(files);
  const corrected = await importInvoiceFolder(selectedFiles(files, manifest));
  async function closedCase(original) {
    const failed = await importInvoiceFolder(selectedFiles(original, manifest));
    const id = await saveInvoiceCandidate(getStorage, pin, failed.evidence);
    const current = () => restoreReviews(getStorage).items.find(item => item.id === id);
    saveReviewDecision(getStorage, current(), 'fix-required', 'Recheck the fictional invoice receipts.');
    await attachInvoiceFollowUp(getStorage, current(), corrected.evidence);
    await resolveReviewCase(getStorage, current());
    return JSON.parse(await createReviewCase(current(), 'Fictional note for the receiver.', { includeInvoiceReceipts: true, getStorage }));
  }

  const missing = { ...files };
  delete missing['validation.json'];
  const repairedMissing = await closedCase(missing);
  const repairedOutput = await closedCase({ ...files, 'results.json': files['results.json'] + '\n' });
  const damaged = structuredClone(repairedMissing);
  damaged.followUp.invoice.evidence.files['results.json'] = btoa('edited after export');
  const damagedOriginal = structuredClone(repairedOutput);
  damagedOriginal.invoice.evidence.files['expected.json'] = btoa('edited after export');
  const changedBaseline = structuredClone(repairedOutput);
  changedBaseline.baseline.chain.title = 'Other baseline evidence';
  const unclosed = structuredClone(repairedOutput);
  delete unclosed.resolution;
  const execution = JSON.stringify({ status: 'execution_failed', exit_code: 1, input_unchanged: true, cleaned: true });
  const failedRun = await importInvoiceFolder(selectedFiles({ ...files, 'execution.json': execution }));
  const current = restoreReviews(getStorage).items.find(item => item.invoice.fingerprint === repairedOutput.invoice.fingerprint);
  await attachInvoiceFollowUp(getStorage, current, failedRun.evidence);
  const updated = restoreReviews(getStorage).items.find(item => item.id === current.id);
  const failedExecution = JSON.parse(await createReviewCase(updated, undefined, { includeInvoiceReceipts: true, getStorage }));
  const sources = { repairedMissing, repairedOutput, damaged, damagedOriginal, changedBaseline, unclosed, failedExecution };
  for (const [name, bundle] of Object.entries(sources)) {
    await writeFile(join(directory, name + '.json'), JSON.stringify(bundle));
  }
  for (const [name, id] of [['matching', 'SANDBOX-000000000001'], ['conflict', 'SANDBOX-000000000003']]) {
    const path = join(directory, name);
    await mkdir(path);
    const raw = folder(id)['investigation.json'];
    await writeFile(join(path, 'investigation.json'), raw);
    await writeFile(join(path, 'pin.json'), JSON.stringify({
      schemaVersion: 1, runId: id, fingerprint: await runFingerprint(parseInvestigation(raw)),
    }));
  }
}
