import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { importInvoiceFolder } from '../../src/invoice-import.mjs';

function folder() {
  const stamp = '2026-01-01T00:00:00Z';
  const end = '2026-01-01T00:02:00Z';
  const scope = [
    { action: 'code:execute', resource: 'sandbox:RUN-test' },
    { action: 'artifact:verify', resource: 'sandbox:RUN-test:results.json' },
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
    id: 'RUN-test', principal: { id: 'owner' }, rootGrantId: 'g1',
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
const manifestFor = files => ({
  case: 'invoice-b',
  files: Object.fromEntries(Object.entries(files).map(([name, contents]) => [name, digest(contents)])),
});
function selectedFiles(files, manifest = manifestFor(files)) {
  return Object.entries({ ...files, 'manifest.json': JSON.stringify(manifest) })
    .map(([name, contents]) => Object.assign(new Blob([contents]), { webkitRelativePath: 'invoice-b/' + name }));
}

test('checks authority, exact invoice output, and execution independently from one selected folder', async () => {
  const files = selectedFiles(folder());
  files.push({ webkitRelativePath: 'invoice-b/nested/validation.json' });
  files.push({ webkitRelativePath: 'invoice-b/program.py' });
  const check = await importInvoiceFolder(files);
  assert.equal(check.caseId, 'invoice-b');
  assert.ok(Object.values(check.receiptStates).every(state => state === 'matched'));
  assert.equal(check.authority.label, 'Within scope');
  assert.equal(check.output.label, 'Totals verified');
  assert.equal(check.output.totals.total_cents, 107);
  assert.equal(check.execution.label, 'Execution recorded complete');
  assert.deepEqual(check.execution.attempts, { allowed: 2, denied: 0 });
});

test('a missing validation receipt makes output unverifiable with authority and execution still checked', async () => {
  const files = folder();
  const manifest = manifestFor(files);
  delete files['validation.json'];
  const check = await importInvoiceFolder(selectedFiles(files, manifest));
  assert.equal(check.receiptStates['validation.json'], 'missing');
  assert.equal(check.output.label, 'Unverifiable');
  assert.equal(check.authority.tone, 'valid');
  assert.equal(check.execution.tone, 'valid');
});

test('altered output bytes cannot receive a passing verdict', async () => {
  const files = folder();
  const manifest = manifestFor(files);
  files['results.json'] += '\n';
  const check = await importInvoiceFolder(selectedFiles(files, manifest));
  assert.equal(check.receiptStates['results.json'], 'mismatch');
  assert.equal(check.output.label, 'Hash mismatch');
  assert.equal(check.authority.tone, 'valid');
  assert.equal(check.execution.tone, 'valid');
  const updated = await importInvoiceFolder(selectedFiles(files));
  assert.equal(updated.receiptStates['results.json'], 'matched');
  assert.equal(updated.output.label, 'Evidence disagrees');
});

test('a matching execution receipt can report a failure independently of output and authority', async () => {
  const files = folder();
  files['execution.json'] = JSON.stringify({ status: 'artifact_invalid', exit_code: 0, input_unchanged: false, cleaned: true });
  const check = await importInvoiceFolder(selectedFiles(files));
  assert.equal(check.receiptStates['execution.json'], 'matched');
  assert.equal(check.execution.label, 'Execution needs review');
  assert.equal(check.execution.receipt.status, 'Artifact collection failed');
  assert.equal(check.output.tone, 'valid');
  assert.equal(check.authority.tone, 'valid');
});

test('a listed file without a usable hash is not accepted and missing manifests reject the import', async () => {
  const files = folder();
  const manifest = manifestFor(files);
  delete manifest.files['execution.json'];
  const check = await importInvoiceFolder(selectedFiles(files, manifest));
  assert.equal(check.receiptStates['execution.json'], 'unlisted');
  assert.equal(check.execution.tone, 'unknown');
  assert.equal(check.output.tone, 'valid');
  await assert.rejects(importInvoiceFolder(selectedFiles(files).filter(file => !file.webkitRelativePath.endsWith('/manifest.json'))),
    /folder containing manifest\.json/);
});

test('malformed or non-integer output is invalid even when the manifest hash matches', async () => {
  const files = folder();
  for (const output of [
    files['results.json'].replace('107', '107.0'),
    files['results.json'].replace('{', '{"total_cents":0,'),
  ]) {
    const candidate = { ...files, 'results.json': output };
    const check = await importInvoiceFolder(selectedFiles(candidate));
    assert.equal(check.receiptStates['results.json'], 'invalid');
    assert.equal(check.output.tone, 'unknown');
  }
});
