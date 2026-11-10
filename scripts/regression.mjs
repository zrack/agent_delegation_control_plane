// Offline command-line entry point for the viewer's regression rules.
import { closeSync, constants, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { canPinBaseline, checkRegression, compareRuns, regressionLabels } from '../src/comparison.mjs';
import { evaluateChain } from '../src/evaluator.mjs';
import { MAX_IMPORT_BYTES, parseInvestigation } from '../src/import.mjs';
import { createReviewPackage } from '../src/review.mjs';
import { runFingerprint } from '../src/storage.mjs';

const exitCodes = { pass: 0, regression: 1, review: 2 };

function readText(path, limit) {
  const file = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = fstatSync(file);
    if (!info.isFile() || info.size > limit) throw new Error('Expected a bounded regular file.');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length <= limit) {
      const count = readSync(file, buffer, length, buffer.length - length);
      if (!count) return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
      length += count;
    }
    throw new Error('File exceeds its size limit.');
  } finally {
    closeSync(file);
  }
}

function readRun(path) {
  return parseInvestigation(readText(path, MAX_IMPORT_BYTES));
}

function report(status, reasons, records = {}) {
  return { schemaVersion: 1, status, label: regressionLabels[status], ...records, reasons };
}

function review(message, records) {
  return report('review', [{ impact: 'review', message }], records);
}

async function pinBaseline(directory) {
  const baseline = readRun(join(directory, 'investigation.json'));
  if (!canPinBaseline(baseline, evaluateChain(baseline))) throw new Error('The baseline must have complete within-scope authority and usable artifact references.');
  const pin = { schemaVersion: 1, runId: baseline.id, fingerprint: await runFingerprint(baseline) };
  writeFileSync(join(directory, 'pin.json'), JSON.stringify(pin) + '\n', { flag: 'wx', mode: 0o600 });
  return pin;
}

async function checkCandidate(directory, candidateFile) {
  const evidence = {};
  const checked = report => ({ report, evidence });
  let candidate;
  try {
    candidate = readRun(candidateFile);
  } catch {
    return checked(review('The candidate export is missing, unreadable, or invalid.'));
  }
  evidence.candidate = candidate;
  const records = { candidateId: candidate.id, candidateFingerprint: await runFingerprint(candidate) };
  let pin;
  let baseline;
  try {
    pin = JSON.parse(readText(join(directory, 'pin.json'), 1024));
    if (pin?.schemaVersion !== 1 || typeof pin.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(pin.fingerprint)) {
      throw new Error('Invalid baseline pin.');
    }
    baseline = readRun(join(directory, 'investigation.json'));
  } catch {
    return checked(review('The baseline pin or original export is missing, unreadable, or invalid.', records));
  }
  if (pin.runId !== baseline.id || pin.fingerprint !== await runFingerprint(baseline)) {
    return checked(review('The original export no longer matches the pinned baseline.', records));
  }
  evidence.baseline = baseline;
  records.baselineId = baseline.id;
  records.baselineFingerprint = pin.fingerprint;
  const baselineResult = evaluateChain(baseline);
  if (!canPinBaseline(baseline, baselineResult)) return checked(review('The pinned baseline no longer qualifies for comparison.', records));
  if (baseline.id === candidate.id) return checked(review('Choose a candidate with a different run ID from the baseline.', records));

  records.comparisonHash = '#compare?' + new URLSearchParams({ baseline: baseline.id, candidate: candidate.id });
  const candidateResult = evaluateChain(candidate);
  const comparison = compareRuns(baseline, candidate, baselineResult, candidateResult);
  const assessment = checkRegression(comparison, candidateResult);
  const grantReference = record => record?.event?.authorityId ?? record?.authorityId ?? record?.id ?? record?.rootGrantId;
  const reasons = assessment.reasons.map(({ impact, message, eventId, row }) => ({
    impact,
    message,
    baselineEventId: row?.eventLinks?.[0],
    candidateEventId: eventId ?? row?.eventLinks?.[1],
    baselineGrantId: grantReference(row?.before),
    candidateGrantId: grantReference(row?.after) ?? candidate.events.find(event => event.id === eventId)?.authorityId,
  }));
  return checked(report(assessment.status, reasons, records));
}

try {
  const [command, ...args] = process.argv.slice(2);
  const { values } = parseArgs({ args, options: {
    'baseline-dir': { type: 'string' }, candidate: { type: 'string' }, package: { type: 'string' },
  } });
  const directory = values['baseline-dir'];
  if (command === 'pin' && directory && values.candidate === undefined && values.package === undefined) {
    console.log(JSON.stringify(await pinBaseline(directory)));
  } else if (command === 'check' && directory && values.candidate) {
    const { report: result, evidence } = await checkCandidate(directory, values.candidate);
    console.log(JSON.stringify(result));
    process.exitCode = exitCodes[result.status];
    if (values.package !== undefined) {
      try {
        const bundle = await createReviewPackage(result, evidence);
        writeFileSync(values.package, bundle, { flag: 'wx', mode: 0o600 });
      } catch {
        console.error('The check completed, but the review package could not be saved. Use a new writable path and check the package size.');
        process.exitCode = 3;
      }
    }
  } else {
    console.error('Usage: node scripts/regression.mjs pin --baseline-dir DIR | check --baseline-dir DIR --candidate FILE [--package FILE]');
    process.exitCode = 3;
  }
} catch (error) {
  console.error(error.code === 'EEXIST' ? 'The pin already exists. Use a new baseline directory to pin a replacement.'
    : 'Could not complete the command. Check the arguments, baseline evidence, and file access.');
  process.exitCode = 3;
}
