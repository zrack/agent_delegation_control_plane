// A second, fictional producer with independently specified expected outcomes in the tests.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const sha = value => createHash('sha256').update(value).digest('hex');
const oid = value => createHash('sha1').update(value).digest('hex'); // Git object identifier shape in the fixture.
const json = value => JSON.stringify(value) + '\n';
const ledger = rows => rows.map(json).join('');
export const privateMarker = 'fictional-output-body-do-not-display';
export const expectedRevision = oid('fictional edit');
export const expectedOutput = sha(privateMarker + '\n');

export function manifest(files) {
  return Object.entries(files).filter(([name]) => name !== 'SHA256SUMS')
    .map(([name, value]) => sha(value) + '  ' + name + '\n').join('');
}

export function editTestFiles(scenario = 'passing') {
  const runId = 'packing-fictional';
  const repository = 'repo:packing-demo';
  const validFrom = '2026-01-01T10:00:00.123456+00:00';
  const expiresAt = '2026-01-01T11:00:00.000000+00:00';
  const edit = { action: 'file:write', resource: repository + '/src/packing.py' };
  const verify = { action: 'test:execute', resource: repository + '/tests/test_packing.py' };
  const grant = (id, parentGrantId, issuer, subject, capabilities, canDelegate) =>
    ({ id, parentGrantId, issuer, subject, principal: 'demo-owner', capabilities, canDelegate, validFrom, expiresAt });
  const grants = [grant('root', null, 'demo-owner', 'demo-coordinator', [edit, verify], true),
    grant('edit', 'root', 'demo-coordinator', 'demo-editor', [edit], false),
    grant('verify', 'root', 'demo-coordinator', 'demo-tester', [verify], false)];
  const attempts = [
    { runId, attemptId: 'attempt-edit', actor: 'demo-editor', grantId: 'edit', ...edit, revision: oid('fictional parent'), startedAt: '2026-01-01T10:01:00.123456+00:00' },
    { runId, attemptId: 'attempt-verify', actor: 'demo-tester', grantId: 'verify', ...verify, revision: expectedRevision, startedAt: '2026-01-01T10:02:00.123456+00:00' },
  ];
  const setup = { runId, repository, baseRevision: attempts[0].revision, originalSourceSha256: sha('original'),
    frozenTestSha256: sha('precommitted tests'), grantFileSha256: sha(ledger(grants)), setupAt: validFrom,
    grantRoles: { 'demo-editor': 'fictional/editor', 'demo-tester': 'fictional/verifier' },
    expectedResultsSha256: sha('hand-calculated examples') };
  const editor = { ...attempts[0], completedAt: '2026-01-01T10:01:01.000000+00:00', eventId: 'event-edit', outcome: 'completed',
    evidence: { beforeSha256: setup.originalSourceSha256, afterSha256: sha('edited') } };
  const verifier = { ...attempts[1], completedAt: '2026-01-01T10:02:02.000000+00:00', eventId: 'event-verify', outcome: 'passed', dependsOnEventId: editor.eventId };
  const stdout = Buffer.alloc(0);
  const stderr = Buffer.from(privateMarker + '\n');
  const receipt = { runId, attemptId: verifier.attemptId, eventId: verifier.eventId, grantId: verifier.grantId, actor: verifier.actor,
    resource: verifier.resource, startedAt: verifier.startedAt, completedAt: verifier.completedAt, testedRevision: expectedRevision,
    tree: oid('fictional tree'), testSha256: setup.frozenTestSha256, testedSourceSha256: editor.evidence.afterSha256,
    command: ['python3', '-I', '-B', '-m', 'unittest', 'discover', '-s', 'tests', '-v'], python: '3.12.0', exitCode: 0,
    stdoutFile: 'test-stdout.bin', stdoutSha256: sha(stdout), stderrFile: 'test-stderr.txt', stderrSha256: sha(stderr) };
  const receiptBytes = json(receipt);
  verifier.evidence = { receiptFile: 'test-receipt.json', receiptSha256: sha(receiptBytes) };

  const files = { 'setup.json': json(setup), 'grants.jsonl': ledger(grants), 'attempts.jsonl': ledger(attempts),
    'actions.jsonl': ledger([editor, verifier]), 'test-receipt.json': receiptBytes, 'test-stdout.bin': stdout, 'test-stderr.txt': stderr };
  switch (scenario) {
    case 'passing': break;
    case 'missing-grant':
      files['grants.jsonl'] = ledger(grants.slice(0, 2));
      files['setup.json'] = json({ ...setup, grantFileSha256: sha(files['grants.jsonl']) });
      break;
    case 'altered-receipt':
      files['test-receipt.json'] += ' ';
      break;
    case 'altered-output':
      files['test-stderr.txt'] = Buffer.from([0xff, 0x00, 0x61]);
      break;
    case 'attempt-only':
      files['actions.jsonl'] = ledger([editor]);
      break;
    case 'failed-test': {
      const failed = json({ ...receipt, exitCode: 1 });
      files['test-receipt.json'] = failed;
      files['actions.jsonl'] = ledger([editor, { ...verifier, outcome: 'failed', evidence: { ...verifier.evidence, receiptSha256: sha(failed) } }]);
      break;
    }
    default: throw new Error('Unknown fictional scenario: ' + scenario);
  }
  // Refreshing the outer manifest deliberately leaves the inner evidence links unchanged.
  files.SHA256SUMS = manifest(files);
  return files;
}

export function selectedFiles(files) {
  return Object.entries(files).map(([name, bytes]) =>
    Object.assign(new Blob([bytes]), { webkitRelativePath: 'capture/' + name }));
}
export async function writeFolder(directory, files) {
  await mkdir(directory, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(directory, name), bytes);
  return directory;
}
