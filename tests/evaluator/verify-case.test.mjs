import test from 'node:test';
import { invoiceCases } from '../fixtures/invoice-case.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('offline verifier reproduces receiver outcomes and preserves selected inputs', t => {
  const tmp = mkdtempSync(join(tmpdir(), 'adcp-verify-case-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const output = join(tmp, 'build');
  const built = spawnSync('python3', ['scripts/build_codex_handoff.py', '--output', output], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const kit = join(output, 'adcp-codex-handoff-demo');
  const matrix = JSON.parse(readFileSync(join(kit, 'facilitator/outcomes.json')));
  const pinArgs = (pin, workflow = matrix.workflow) => ['--workflow', workflow, '--baseline-dir', join(kit, 'receiver-baselines', pin)];
  const verify = (file, args = []) => {
    const run = spawnSync(process.execPath, ['scripts/verify-case.mjs', '--json', '--case', file, ...args], { encoding: 'utf8' });
    return { exit: run.status, json: JSON.parse(run.stdout), raw: run.stdout };
  };
  const pinFile = join(kit, 'receiver-baselines/matching/pin.json');
  const originalPin = readFileSync(pinFile, 'utf8');
  for (const row of matrix.scenarios) {
    const file = resolve(kit, row.caseFile);
    const raw = readFileSync(file, 'utf8');
    const args = row.pin === 'missing' ? [] : pinArgs(row.pin);
    const result = verify(file, args);
    assert.equal(result.json.input, 'valid', row.id);
    assert.equal(result.json.disposition, row.disposition, row.id);
    assert.equal(result.exit, row.disposition === 'resolved' ? 0 : 1, row.id);
    assert.ok(result.json.reasons.some(r => r.code === row.reason), row.id);
    assert.equal(result.raw, verify(file, args).raw);
    assert.equal(readFileSync(file, 'utf8'), raw);
    assert.equal(readFileSync(pinFile, 'utf8'), originalPin);
  }
  const legacy = verify(join(kit, 'donors/matching-case.json'), pinArgs('matching'));
  assert.equal(legacy.json.disposition, 'resolved');
  const selected = join(kit, 'cases/history-on.json');
  const wrongName = verify(selected, pinArgs('matching', 'Different review'));
  assert.equal(wrongName.json.checks.pin, 'missing');
  const modified = join(tmp, 'modified.json');
  const bundle = JSON.parse(readFileSync(selected));
  bundle.resolution = '0'.repeat(64);
  bundle.note = 'FICTIONAL-NOTE-DO-NOT-PRINT';
  writeFileSync(modified, JSON.stringify(bundle));
  const unverified = verify(modified, pinArgs('matching'));
  assert.equal(unverified.exit, 1);
  assert.ok(unverified.json.reasons.some(r => r.code === 'unverified-closure-record'));
  assert.ok(!unverified.raw.includes(bundle.note));
  delete bundle.resolution;
  writeFileSync(modified, JSON.stringify(bundle));
  assert.equal(verify(modified, pinArgs('matching')).json.disposition, 'open-ready');
  bundle.schemaVersion = 2;
  writeFileSync(modified, JSON.stringify(bundle));
  assert.equal(verify(modified).json.reasons[0].code, 'unsupported-case-format');
  writeFileSync(modified, '{');
  assert.equal(verify(modified).exit, 2);
  writeFileSync(pinFile, originalPin.replace(/[0-9a-f]{64}/g, '0'.repeat(64)));
  assert.equal(verify(selected, pinArgs('matching')).json.reasons[0].code, 'invalid-receiver-baseline');
});

test('invoice verifier separates original receipt findings, corrected evidence, and receiver pin choice', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'adcp-verify-invoices-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await invoiceCases(dir);
  function verify(name, pin, workflow = 'Invoices', json = true) {
    const caseFile = join(dir, name + '.json');
    const before = readFileSync(caseFile);
    const args = ['scripts/verify-case.mjs', '--case', caseFile];
    if (json) args.push('--json');
    if (pin) args.push('--workflow', workflow, '--baseline-dir', join(dir, pin));
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.deepEqual(readFileSync(caseFile), before);
    assert.doesNotMatch(result.stdout, /Fictional note for the receiver|edited after export/);
    assert.equal(result.stderr, '');
    return { exit: result.status, value: json ? JSON.parse(result.stdout) : result.stdout };
  }
  const rows = [
    ['repairedMissing', undefined, 0, 'resolved', 'verified-closure'],
    ['repairedOutput', 'matching', 0, 'resolved', 'verified-closure'],
    ['repairedMissing', 'conflict', 1, 'open-blocked', 'conflicting-pin'],
    ['unclosed', 'matching', 1, 'open-ready', 'explicit-closure-needed'],
    ['unclosed', undefined, 1, 'open-blocked', 'missing-pin'],
    ['damaged', 'matching', 1, 'open-blocked', 'follow-up-evidence-invalid'],
    ['damagedOriginal', 'matching', 1, 'open-blocked', 'original-evidence-invalid'],
    ['changedBaseline', 'matching', 1, 'open-blocked', 'baseline-evidence-mismatch'],
    ['failedExecution', 'matching', 1, 'open-blocked', 'follow-up-execution-not-passing'],
  ];
  for (const [name, pin, code, disposition, reason] of rows) {
    const { exit, value } = verify(name, pin);
    assert.equal(exit, code, name);
    assert.equal(value.disposition, disposition, name);
    assert.ok(value.reasons.some(item => item.code === reason), name);
  }
  const missing = verify('repairedMissing').value;
  assert.equal(missing.checks.pin, 'missing');
  assert.equal(missing.invoice.baselineEvidence, 'matched');
  assert.equal(missing.invoice.original.receipts['validation.json'], 'missing');
  assert.equal(missing.invoice.original.snapshot, 'verified');
  assert.equal(missing.invoice.followUp.output, 'Totals verified');
  assert.equal(missing.invoice.followUp.authority, 'Within scope');
  assert.equal(missing.invoice.followUp.execution, 'Execution recorded complete');
  assert.equal(verify('damaged', 'matching').value.invoice.followUp.receipts['results.json'], 'mismatch');
  assert.equal(verify('damagedOriginal', 'matching').value.invoice.original.snapshot, 'unverified');
  assert.equal(verify('changedBaseline', 'matching').value.invoice.baselineEvidence, 'mismatch');
  const failingExecution = verify('failedExecution', 'matching').value;
  assert.equal(failingExecution.checks.followUp, 'pass');
  assert.equal(failingExecution.invoice.followUp.execution, 'Execution needs review');
  assert.equal(failingExecution.invoice.followUp.snapshot, 'verified');
  assert.ok(Object.values(failingExecution.invoice.followUp.receipts).every(value => value === 'matched'));
  const wrong = verify('repairedMissing', 'matching', 'Different workflow');
  assert.equal(wrong.exit, 2);
  assert.equal(wrong.value.reasons[0].code, 'receiver-workflow-mismatch');
  const human = verify('repairedOutput', undefined, undefined, false);
  assert.match(human.value, /results.json: mismatch/);
  assert.match(human.value, /Follow-up invoice snapshot: verified/);
});
