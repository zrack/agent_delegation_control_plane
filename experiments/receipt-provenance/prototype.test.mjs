import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attest, keyId, verifyReceipt } from './prototype.mjs';

test('only a receiver-trusted, currently active key can attest these bytes in this context', () => {
  const caseBytes = Buffer.from('fictional receipt bytes');
  const keys = generateKeyPairSync('ed25519');
  const context = { issuer: 'fictional-producer', workflow: 'fictional-review', runId: 'run-01' };
  const envelope = attest(caseBytes, context, keys.privateKey, keys.publicKey);
  const record = { publicKey: keys.publicKey, issuer: context.issuer, status: 'active', workflow: context.workflow };
  const trust = new Map([[keyId(keys.publicKey), record]]);
  const check = (env = envelope, bytes = caseBytes, expected = context) => verifyReceipt(bytes, env, expected, trust);
  assert.equal(check(), 'signature-and-digest-verified');
  assert.equal(check(envelope, Buffer.from('different')), 'subject-mismatch');
  assert.equal(check(envelope, caseBytes, { ...context, runId: 'run-02' }), 'context-mismatch');
  assert.equal(check(envelope, caseBytes, { ...context, workflow: 'other' }), 'key-out-of-scope');
  assert.equal(check(envelope, caseBytes, { ...context, issuer: 'other' }), 'key-out-of-scope');
  assert.equal(check({ ...envelope, payloadType: 'application/json' }), 'invalid-input');
  assert.equal(check({ ...envelope, signatures: [] }), 'invalid-input');
  assert.equal(check({ ...envelope, payload: envelope.payload + ' ' }), 'invalid-input');
  const changed = { ...envelope, payload: Buffer.from('{}').toString('base64') };
  assert.equal(check(changed), 'invalid-signature');
  const other = generateKeyPairSync('ed25519');
  const selfIssued = attest(caseBytes, context, other.privateKey, other.publicKey);
  assert.equal(check({ ...selfIssued, publicKey: other.publicKey }), 'unknown-key');
  record.status = 'revoked';
  assert.equal(check(), 'revoked-key');
});

test('a valid signature over another statement type does not validate the expected claim', () => {
  const keys = generateKeyPairSync('ed25519');
  const context = { issuer: 'fictional-producer', workflow: 'alpha', runId: '01' };
  const bytes = Buffer.from('a');
  const envelope = attest(bytes, context, keys.privateKey, keys.publicKey);
  const statement = JSON.parse(Buffer.from(envelope.payload, 'base64'));
  statement.predicateType = 'unrelated';
  const payload = Buffer.from(JSON.stringify(statement));
  const pae = Buffer.concat([Buffer.from('DSSEv1 28 application/vnd.in-toto+json ' + payload.length + ' '), payload]);
  envelope.payload = payload.toString('base64');
  envelope.signatures[0].sig = sign(null, pae, keys.privateKey).toString('base64');
  const trust = new Map([[keyId(keys.publicKey), { publicKey: keys.publicKey, issuer: context.issuer, workflow: 'alpha', status: 'active' }]]);
  assert.equal(verifyReceipt(bytes, envelope, context, trust), 'invalid-statement');
});

test('a trusted signature over a damaged package cannot replace the receipt and receiver recheck', t => {
  const root = mkdtempSync(join(tmpdir(), 'adcp-provenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const donor = JSON.parse(readFileSync(new URL('../../docs/codex-handoff/fixtures/alpha15-case.json', import.meta.url)));
  donor.codex.evidence.files['after.md'] = Buffer.from('Changed fictional evidence.').toString('base64');
  const bytes = Buffer.from(JSON.stringify(donor));
  const keys = generateKeyPairSync('ed25519');
  const context = { issuer: 'fictional-issuer', workflow: 'review', runId: donor.report.candidateId };
  const envelope = attest(bytes, context, keys.privateKey, keys.publicKey);
  const trust = new Map([[keyId(keys.publicKey), { publicKey: keys.publicKey, issuer: context.issuer, workflow: context.workflow, status: 'active' }]]);
  assert.equal(verifyReceipt(bytes, envelope, context, trust), 'signature-and-digest-verified');

  const selected = join(root, 'damaged.json');
  writeFileSync(selected, bytes);
  writeFileSync(join(root, 'investigation.json'), JSON.stringify(donor.baseline));
  writeFileSync(join(root, 'pin.json'), JSON.stringify({ schemaVersion: 1, runId: donor.report.baselineId, fingerprint: donor.report.baselineFingerprint }));
  const checked = spawnSync(process.execPath, ['scripts/verify-case.mjs', '--json', '--case', selected, '--baseline-dir', root, '--workflow', donor.codex.workflow], { encoding: 'utf8' });
  assert.equal(checked.status, 1);
  const { checks, disposition, reasons } = JSON.parse(checked.stdout);
  assert.equal(checks.pin, 'matched');
  assert.equal(disposition, 'open-blocked');
  assert.ok(reasons.some(r => r.code === 'original-receipt-mismatch'));
});
