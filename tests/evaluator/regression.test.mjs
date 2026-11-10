import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chains } from '../../src/fixtures.mjs';
import { MAX_IMPORT_BYTES } from '../../src/import.mjs';

const script = fileURLToPath(new URL('../../scripts/regression.mjs', import.meta.url));
const [overreach, valid, missing] = chains;
const writeRun = (path, chain, id = `offline-${chain.id}`) =>
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, chain: { ...chain, id } }));

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'adcp-regression-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const baseline = join(directory, 'investigation.json');
  const candidate = join(directory, 'candidate.json');
  writeRun(baseline, valid);
  const run = (command, args = []) => {
    const result = spawnSync(process.execPath, [script, command, '--baseline-dir', directory, ...args],
      { encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    return { code: result.status, report: result.stdout ? JSON.parse(result.stdout) : null };
  };
  return { directory, baseline, candidate, pin: () => run('pin'), check: (args = []) => run('check', ['--candidate', candidate, ...args]) };
}

test('offline check returns the dashboard verdicts and references the affected evidence', t => {
  const { directory, candidate, pin, check } = setup(t);
  assert.equal(pin().code, 0);
  writeRun(candidate, valid, 'offline-second-run');
  const passed = check();
  assert.equal(passed.code, 0);
  assert.equal(passed.report.label, 'No regression found');
  assert.equal(passed.report.comparisonHash, '#compare?baseline=offline-CH-001&candidate=offline-second-run');

  writeRun(candidate, overreach);
  const packagePath = join(directory, 'review-package.json');
  const regression = check(['--package', packagePath]);
  assert.equal(regression.code, 1);
  assert.equal(regression.report.label, 'Regression detected');
  assert.equal(regression.report.reasons[0].candidateEventId, 'CH-002-e3');
  assert.equal(regression.report.reasons[0].candidateGrantId, 'CH-002-g3');
  const contents = readFileSync(packagePath, 'utf8');
  const bundle = JSON.parse(contents);
  assert.equal(bundle.report.status, 'regression');
  assert.equal(bundle.baseline.chain.id, regression.report.baselineId);
  assert.equal(bundle.candidate.chain.id, regression.report.candidateId);
  assert.equal(bundle.note, undefined);
  const existing = check(['--package', packagePath]);
  assert.equal(existing.code, 3);
  assert.equal(existing.report.status, 'regression');
  assert.equal(readFileSync(packagePath, 'utf8'), contents);

  writeRun(candidate, missing);
  const review = check();
  assert.equal(review.code, 2);
  assert.equal(review.report.label, 'Needs review');
  assert.ok(review.report.reasons.some(reason => reason.message.includes('Referenced grant supplied')
    && reason.candidateEventId === 'CH-003-e2' && reason.candidateGrantId === 'CH-003-g2'));
});

test('missing or changed baseline and oversized candidate require review without replacing the pin', t => {
  const { directory, baseline, candidate, pin, check } = setup(t);
  writeRun(candidate, valid, 'offline-second-run');
  assert.match(check().report.reasons[0].message, /baseline pin or original export is missing/);
  assert.equal(pin().code, 0);
  const pinFile = join(directory, 'pin.json');
  const original = readFileSync(pinFile, 'utf8');
  writeRun(baseline, { ...valid, summary: 'Different evidence under the same ID' });
  assert.match(check().report.reasons[0].message, /no longer matches/);
  assert.equal(pin().code, 3);
  assert.equal(readFileSync(pinFile, 'utf8'), original);
  rmSync(baseline);
  assert.equal(check().report.status, 'review');
  writeFileSync(candidate, Buffer.alloc(MAX_IMPORT_BYTES + 1));
  assert.match(check().report.reasons[0].message, /candidate export is missing, unreadable, or invalid/);
});
