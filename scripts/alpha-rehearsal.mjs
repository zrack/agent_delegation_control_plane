// Build a repeatable offline rehearsal from fictional records only.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chains } from '../src/fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const checker = join(root, 'scripts/regression.mjs');
const source = 'Fictional alpha rehearsal';

function invoiceRun(sample, minute) {
  const id = `SANDBOX-0000000000a${sample}`;
  const principal = { id: 'owner:alpha-invoice', name: 'Fictional invoice owner', role: 'Invoice operations' };
  const execute = { action: 'code:execute', resource: `sandbox:${id}` };
  const verify = { action: 'artifact:verify', resource: `${execute.resource}:results.json` };
  const at = seconds => `2026-09-13T10:${minute}:${seconds}Z`;
  const from = at('00');
  const expiry = `2026-09-13T10:${minute}:50Z`;
  const grant = (suffix, parentGrantId, issuer, subject, capabilities, canDelegate) => ({
    id: `${id}-g${suffix}`, parentGrantId, issuer, subject, principal: principal.id,
    capabilities, validFrom: from, expiresAt: expiry, canDelegate,
  });
  const rootGrant = grant(1, null, principal.id, 'Coder', [execute, verify], true);
  const childGrant = grant(2, rootGrant.id, 'Coder', 'Verifier', [verify], false);
  const artifactSha256 = createHash('sha256').update(`fictional invoice result ${sample}`).digest('hex');
  const event = (suffix, parentEventId, actor, authorityId, action, time, tool) => ({
    id: `${id}-e${suffix}`, parentEventId, actor, authorityId, label: actor,
    action: { ...action, at: time, outcome: 'completed' },
    evidence: { tool, callId: `alpha-${sample}-${suffix}`, artifactSha256 },
  });
  const run = event(1, null, 'Coder', rootGrant.id, execute, at('10'), 'calculate_invoices');
  const check = event(2, run.id, 'Verifier', childGrant.id, verify, at('20'), 'validate_results');
  return { id, title: 'Invoice workflow', summary: 'Completed fictional invoice workflow.', source, principal,
    rootGrantId: rootGrant.id, intent: 'Calculate fictional invoice totals and verify the result.', completedAt: check.action.at,
    grants: [rootGrant, childGrant], events: [run, check] };
}

function accountRun(example, id) {
  return { ...structuredClone(example), id, title: 'Account workflow', summary: 'Completed fictional account workflow.', source };
}

const envelope = chain => JSON.stringify({ schemaVersion: 1, chain });

function runCheck(expectedExit, ...args) {
  const result = spawnSync(process.execPath, [checker, ...args], { encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw result.error;
  if (result.status !== expectedExit) throw new Error(`Offline checker returned ${result.status}, expected ${expectedExit}.`);
}

function generatePackages(scratch) {
  const [overreach, valid, missing] = chains;
  const accountBaseline = accountRun(valid, 'ALPHA-ACCOUNT-BASELINE');
  const exported = accountRun(overreach, 'ALPHA-ACCOUNT-02');
  const incomplete = accountRun(missing, 'ALPHA-ACCOUNT-03');
  const corrected = accountRun(overreach, 'ALPHA-ACCOUNT-04');
  corrected.events[2] = { ...valid.events[2], id: corrected.events[2].id, parentEventId: corrected.events[2].parentEventId,
    authorityId: corrected.events[2].authorityId, action: { ...valid.events[2].action, at: corrected.events[2].action.at } };
  corrected.grants[2] = { ...corrected.grants[2], subject: valid.grants[2].subject, capabilities: valid.grants[2].capabilities };
  const restored = accountRun(missing, 'ALPHA-ACCOUNT-05');
  restored.grants.splice(1, 0, { ...valid.grants[1], id: 'CH-003-g2', parentGrantId: 'CH-003-g1' });

  const baselineDirectories = {};
  for (const [name, chain] of [['invoice', invoiceRun(1, '04')], ['account', accountBaseline]]) {
    const directory = join(scratch, name);
    mkdirSync(directory);
    writeFileSync(join(directory, 'investigation.json'), envelope(chain));
    runCheck(0, 'pin', '--baseline-dir', directory);
    baselineDirectories[name] = directory;
  }

  const packages = {};
  for (const [filename, baseline, candidate, expected] of [
    ['case-01.json', 'invoice', invoiceRun(2, '08'), 0],
    ['case-02.json', 'account', exported, 1],
    ['case-03.json', 'account', incomplete, 2],
    ['follow-up-02.json', 'account', corrected, 0],
    ['follow-up-03.json', 'account', restored, 0],
  ]) {
    const input = join(scratch, 'candidate.json');
    const output = join(scratch, filename);
    writeFileSync(input, envelope(candidate));
    runCheck(expected, 'check', '--baseline-dir', baselineDirectories[baseline], '--candidate', input, '--package', output);
    packages[filename] = readFileSync(output, 'utf8');
  }
  const altered = JSON.parse(packages['follow-up-02.json']);
  altered.candidate.chain.events[2].action.action = 'account:export';
  packages['follow-up-01.json'] = JSON.stringify(altered);
  return packages;
}

function buildKit(destination) {
  const scratch = mkdtempSync(join(tmpdir(), 'adcp-alpha-rehearsal-'));
  try {
    const packages = generatePackages(scratch);
    const docs = join(root, 'docs/alpha-rehearsal');
    mkdirSync(dirname(destination), { recursive: true });
    mkdirSync(destination, { mode: 0o700 });
    try {
      const reviewer = join(destination, 'reviewer');
      const facilitator = join(destination, 'facilitator');
      mkdirSync(reviewer, { mode: 0o700 });
      mkdirSync(facilitator, { mode: 0o700 });
      for (const [file, contents] of Object.entries(packages)) {
        writeFileSync(join(reviewer, file), contents, { mode: 0o600, flag: 'wx' });
      }
      for (const [directory, name] of [[reviewer, 'TASK_SHEET.md'], [facilitator, 'ANSWER_KEY.md']]) {
        writeFileSync(join(directory, name), readFileSync(join(docs, name)), { mode: 0o600, flag: 'wx' });
      }
    } catch (error) {
      rmSync(destination, { recursive: true, force: true });
      throw error;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  const { values } = parseArgs({ options: { output: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('Usage: node scripts/alpha-rehearsal.mjs [--output NEW_DIRECTORY]');
  } else {
    const destination = resolve(values.output ?? join(root, 'output/private-alpha-rehearsal'));
    buildKit(destination);
    console.log(`Rehearsal kit saved to ${destination}. Give reviewers the reviewer folder and retain the facilitator folder.`);
  }
} catch (error) {
  console.error(error.code === 'EEXIST' ? 'The output directory already exists. Choose a new directory.' : error.message);
  process.exitCode = 1;
}
