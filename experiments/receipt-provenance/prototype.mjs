// Offline experiment. The trust list and workflow context belong to the receiver.
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validRunId, validWorkflowName } from '../../src/storage.mjs';
import { readBytes } from '../../scripts/bounded-file.mjs';

const mediaType = 'application/vnd.in-toto+json';
const statementType = 'https://in-toto.io/Statement/v1';
const predicateType = 'https://github.com/zrack/agent_delegation_control_plane/attestations/case-receipt/v1';
const maxCaseBytes = 2 * 1024 * 1024;
const maxPayloadBytes = 4096;
const issuerId = /^[a-zA-Z0-9._-]{1,100}$/;
const digest = value => createHash('sha256').update(value).digest('hex');

function validContext(context) {
  return typeof context?.issuer === 'string' && issuerId.test(context.issuer)
    && validWorkflowName(context.workflow) && validRunId(context.runId);
}

// Only these two header fields identify the original case. Closure and evidence
// are independently checked by scripts/verify-case.mjs.
function caseIdentity(bytes) {
  let bundle;
  try { bundle = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return null; }
  if (bundle?.schemaVersion !== 1) return null;
  let workflow;
  if (bundle.kind === 'adcp-codex-review-case') workflow = bundle.codex?.workflow;
  else if (bundle.kind === 'adcp-invoice-review-case') workflow = bundle.invoice?.workflow;
  const runId = bundle.report?.candidateId;
  return validWorkflowName(workflow) && validRunId(runId) ? { workflow, runId } : null;
}

export function keyId(publicKey) {
  return digest(publicKey.export({ format: 'der', type: 'spki' }));
}

// DSSE v1 pre-authentication encoding uses byte lengths and the exact payload bytes.
function signingBytes(payload) {
  return Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(mediaType)} ${mediaType} ${payload.length} `), payload]);
}

function boundedBase64(value, limit) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(limit / 3)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.length <= limit && bytes.toString('base64') === value ? bytes : null;
}

export function attest(bytes, context, privateKey, publicKey) {
  if (!Buffer.isBuffer(bytes) || bytes.length > maxCaseBytes || !validContext(context) ||
      privateKey?.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519' || publicKey?.type !== 'public' ||
      publicKey.asymmetricKeyType !== 'ed25519' || !createPublicKey(privateKey).equals(publicKey)) {
    throw new Error('Use a bounded case, workflow and run identifiers, and an Ed25519 key pair.');
  }
  const statement = {
    _type: statementType, subject: [{ name: 'review-case.json', digest: { sha256: digest(bytes) } }],
    predicateType, predicate: { issuer: context.issuer, workflow: context.workflow, runId: context.runId },
  };
  const payload = Buffer.from(JSON.stringify(statement));
  return { payloadType: mediaType, payload: payload.toString('base64'),
    signatures: [{ keyid: keyId(publicKey), sig: sign(null, signingBytes(payload), privateKey).toString('base64') }] };
}

export function verifyReceipt(bytes, envelope, context, trustedKeys) {
  if (!Buffer.isBuffer(bytes) || bytes.length > maxCaseBytes || !validContext(context) || !(trustedKeys instanceof Map) ||
      envelope?.payloadType !== mediaType || !Array.isArray(envelope.signatures) || envelope.signatures.length !== 1) {
    return 'invalid-input';
  }
  const payload = boundedBase64(envelope.payload, maxPayloadBytes);
  const claim = envelope.signatures[0];
  const signature = boundedBase64(claim?.sig, 64);
  if (!payload || signature?.length !== 64 || typeof claim.keyid !== 'string' || !/^[a-f0-9]{64}$/.test(claim.keyid)) return 'invalid-input';
  const key = trustedKeys.get(claim.keyid);
  if (!key || key.publicKey?.type !== 'public' || key.publicKey.asymmetricKeyType !== 'ed25519' || keyId(key.publicKey) !== claim.keyid) return 'unknown-key';
  if (key.status === 'revoked') return 'revoked-key';
  if (key.status !== 'active' || key.issuer !== context.issuer || key.workflow !== context.workflow) return 'key-out-of-scope';
  if (!verify(null, signingBytes(payload), key.publicKey, signature)) return 'invalid-signature';
  let statement;
  try { statement = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)); }
  catch { return 'invalid-statement'; }
  if (statement?._type !== statementType || statement.predicateType !== predicateType ||
      !Array.isArray(statement.subject) || statement.subject.length !== 1 || statement.subject[0]?.name !== 'review-case.json') {
    return 'invalid-statement';
  }
  if (statement.predicate?.issuer !== context.issuer || statement.predicate.workflow !== context.workflow || statement.predicate.runId !== context.runId) return 'context-mismatch';
  if (statement.subject[0].digest?.sha256 !== digest(bytes)) return 'subject-mismatch';
  const identity = caseIdentity(bytes);
  if (!identity) return 'invalid-case-header';
  if (identity.workflow !== context.workflow || identity.runId !== context.runId) return 'case-context-mismatch';
  return 'signature-and-digest-verified';
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.length !== 3) {
    console.error('Usage: node experiments/receipt-provenance/prototype.mjs FICTIONAL_CASE.json');
    process.exitCode = 2;
  } else {
    try {
      const bytes = readBytes(process.argv[2], maxCaseBytes, { noFollow: true });
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const identity = caseIdentity(bytes);
      if (!identity) throw new Error();
      const context = { issuer: 'fictional-producer', ...identity };
      const envelope = attest(bytes, context, privateKey, publicKey);
      const trust = new Map([[keyId(publicKey), { publicKey, issuer: context.issuer, workflow: context.workflow, status: 'active' }]]);
      console.log(verifyReceipt(bytes, envelope, context, trust));
    } catch {
      console.error('Choose a fictional version 1 Codex or invoice review case of at most 2 MiB with a workflow and original candidate ID.');
      process.exitCode = 2;
    }
  }
}
