// Generate importable fictional records using the existing offline regression checker.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const principal = { id: 'docs-owner', name: 'Fictional documentation owner', role: 'Repository owner' };
const coordinator = 'coding-coordinator';
const editor = 'coding-agent';
const quickstart = 'repo://fictional-workbench/docs/quickstart.md';
const releaseNotes = 'repo://fictional-workbench/docs/release-notes.md';
const readQuickstart = { action: 'file:read', resource: quickstart };
const writeQuickstart = { action: 'file:write', resource: quickstart };
const root = fileURLToPath(new URL('../', import.meta.url));
const checker = join(root, 'scripts/regression.mjs');

function run(name, minute, { resource = quickstart, missingGrant = false } = {}) {
  const id = 'CODING-DEMO-' + name.toUpperCase();
  const at = seconds => `2026-11-17T16:${minute}:${seconds}Z`;
  const rootGrantId = id + '-root';
  const editGrantId = id + '-edit';
  const grants = [
    {
      id: rootGrantId, parentGrantId: null, principal: principal.id, issuer: principal.id, subject: coordinator,
      capabilities: [readQuickstart, writeQuickstart], validFrom: at('00'), expiresAt: at('59'), canDelegate: true,
    },
    {
      id: editGrantId, parentGrantId: rootGrantId, principal: principal.id, issuer: coordinator, subject: editor,
      capabilities: [writeQuickstart], validFrom: at('05'), expiresAt: at('45'), canDelegate: false,
    },
  ];
  if (missingGrant) grants.pop();
  const event = (suffix, parentEventId, actor, label, authorityId, action, seconds, tool, sample) => ({
    id: id + '-' + suffix, parentEventId, actor, label, authorityId,
    action: { ...action, at: at(seconds), outcome: 'completed' },
    evidence: { callId: id + '-call-' + suffix, tool, artifactSha256: createHash('sha256').update(sample).digest('hex') },
  });
  const read = event('read', null, coordinator, 'Coding coordinator', rootGrantId,
    readQuickstart, '10', 'read_file', '# Fictional workbench quickstart\n');
  const edit = event('write', read.id, editor, 'Coding agent', editGrantId,
    { ...writeQuickstart, resource }, '20', 'write_file', `# Fictional ${name} edit to ${resource}\n`);
  return {
    schemaVersion: 1,
    chain: {
      id, title: 'Coding agent · ' + name.replaceAll('-', ' '),
      summary: 'Fictional completed records for the ADCP coding-agent review demo.',
      source: 'Fictional coding-agent demo', principal, rootGrantId,
      intent: 'Update only docs/quickstart.md in the fictional workbench repository.',
      completedAt: edit.action.at, grants, events: [read, edit],
    },
  };
}

const envelope = value => JSON.stringify(value, null, 2) + '\n';

function runCheck(expected, ...args) {
  const result = spawnSync(process.execPath, [checker, ...args], { encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw result.error;
  if (result.status !== expected) {
    throw new Error(`Offline checker returned ${result.status}, expected ${expected}.`);
  }
}

function buildDemo(destination) {
  const scratch = mkdtempSync(join(tmpdir(), 'adcp-coding-agent-demo-'));
  try {
    const baseline = envelope(run('baseline', '00'));
    writeFileSync(join(scratch, 'investigation.json'), baseline);
    runCheck(0, 'pin', '--baseline-dir', scratch);

    const files = { 'baseline.investigation.json': baseline };
    const candidate = join(scratch, 'candidate.json');
    for (const [name, minute, options, expected] of [
      ['out-of-scope', '01', { resource: releaseNotes }, 1],
      ['missing-grant', '02', { missingGrant: true }, 2],
      ['corrected', '03', {}, 0],
    ]) {
      const filename = name + '.review-package.json';
      const pack = join(scratch, filename);
      writeFileSync(candidate, envelope(run(name, minute, options)));
      runCheck(expected, 'check', '--baseline-dir', scratch, '--candidate', candidate, '--package', pack);
      files[filename] = envelope(JSON.parse(readFileSync(pack, 'utf8')));
    }

    mkdirSync(dirname(destination), { recursive: true });
    mkdirSync(destination, { mode: 0o700 });
    try {
      for (const [filename, contents] of Object.entries(files)) {
        writeFileSync(join(destination, filename), contents, { mode: 0o600, flag: 'wx' });
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
    console.log('Usage: node scripts/coding-agent-demo.mjs [--output NEW_DIRECTORY]');
  } else {
    const destination = resolve(values.output ?? join(root, 'output/coding-agent-review-demo'));
    buildDemo(destination);
    console.log(`Coding-agent demo saved to ${destination}`);
  }
} catch (error) {
  console.error(error.code === 'EEXIST' ? 'The output directory already exists. Choose a new directory.' : error.message);
  process.exitCode = 1;
}
