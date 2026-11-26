// Verify the fixed files emitted by integrations/openai-agents/run.py, all locally.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { MAX_IMPORT_BYTES, parseInvestigation } from '../src/import.mjs';

export const sdkFileLimits = Object.freeze({
  'manifest.json': 64 * 1024, 'account.json': 64 * 1024, 'summary.txt': 16 * 1024,
  'result.json': 128 * 1024, 'investigation.json': MAX_IMPORT_BYTES,
  'capture.jsonl': 2 * MAX_IMPORT_BYTES, 'mapping.json': 128 * 1024,
});
const names = Object.keys(sdkFileLimits).filter(name => name !== 'manifest.json');
const sha = value => createHash('sha256').update(value).digest('hex');
const roles = ['Coordinator', 'Researcher', 'Reporter'];
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(value);

function invalid(file, message, code = 'INVALID_SDK_CAPTURE', field) {
  throw Object.assign(new Error(message), { file, code, field });
}

function asText(bytes, file) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { invalid(file, 'Expected UTF-8 input.'); }
}

function parse(value, file) {
  try { return JSON.parse(value); }
  catch { invalid(file, 'Expected valid JSON in the named source file.'); }
}

function readLedger(bytes) {
  const lines = asText(bytes, 'capture.jsonl').trimEnd().split(/\r?\n/);
  if (lines.length > 300) invalid('capture.jsonl', 'The capture exceeds 300 source records.');
  const ids = new Set();
  return lines.map((line, index) => {
    const row = parse(line, 'capture.jsonl');
    if (!id(row?.recordId) || ids.has(row.recordId)) {
      invalid('capture.jsonl', 'Expected a unique record ID on every line.', 'INVALID_SDK_CAPTURE', 'records[' + index + ']');
    }
    ids.add(row.recordId);
    return row;
  });
}

function checkTool(row, call, role, parent, account, hashes) {
  const event = row.event;
  const writing = role === 'Reporter';
  const file = writing ? 'summary.txt' : 'account.json';
  if (event.actor !== role || event.parentEventId !== parent || call.name !== event.evidence?.tool ||
      call.name !== (writing ? 'save_summary' : 'read_account') ||
      event.action?.action !== (writing ? 'summary:write' : 'account:read') ||
      event.action?.resource !== (writing ? 'local-summary:northstar' : 'fictional-account:northstar')) {
    invalid('capture.jsonl', 'The completed action, parent or role differs from its expected tool call.');
  }
  if (event.evidence.artifactSha256 !== hashes[file]) {
    invalid(file, 'The file bytes disagree with the completed action digest.', 'ACTION_RECEIPT_MISMATCH');
  }
  const args = parse(call.arguments, 'capture.jsonl');
  if (writing) {
    if (typeof args?.summary !== 'string' || sha(args.summary) !== hashes[file]) {
      invalid(file, 'The saved output disagrees with the recorded tool input.', 'ACTION_RECEIPT_MISMATCH');
    }
    if (!equal(row.result, { saved: true, sha256: hashes[file] })) {
      invalid('capture.jsonl', 'The recorded write result disagrees with the saved output.', 'ACTION_RECEIPT_MISMATCH');
    }
  } else if (!equal(row.result, account)) {
    invalid('capture.jsonl', 'The recorded read result disagrees with the account file.', 'ACTION_RECEIPT_MISMATCH');
  }
}

function checkLedger(rows, chain, mapping, account, manifest, result) {
  const grants = [], events = [], expectedMap = [];
  const sdkSource = { grants: [], events: [] };
  const recordCalls = new Set();
  let roleIndex = 0, requests = 0, waitingForResponse = false, pendingCall;
  let finalMessage;
  for (const [index, row] of rows.entries()) {
    const role = roles[roleIndex];
    switch (row.kind) {
      case 'grant_issued':
        if (!id(row.grant?.id) || events.some(event => event.authorityId === row.grant.id)) {
          invalid('capture.jsonl', 'An issued grant must have an identifier and precede actions referencing it.');
        }
        grants.push(row.grant);
        sdkSource.grants.push(index);
        break;
      case 'model_request_started':
        if (row.agent !== role || waitingForResponse || pendingCall) {
          invalid('capture.jsonl', 'A model request must follow the active role and prior response or completion.');
        }
        waitingForResponse = true;
        requests++;
        continue;
      case 'model_response': {
        if (row.agent !== role || !waitingForResponse || !Array.isArray(row.output)) {
          invalid('capture.jsonl', 'A model response must match its request and active role.');
        }
        waitingForResponse = false;
        if (row.output.some(item => !['function_call', 'message', 'reasoning'].includes(item?.type))) {
          invalid('capture.jsonl', 'The response contains an unsupported output kind.', 'UNSUPPORTED_SDK_FORMAT');
        }
        const calls = row.output.filter(item => item?.type === 'function_call');
        if (calls.length > 1 || (calls.length && (!id(calls[0].call_id) || recordCalls.has(calls[0].call_id)))) {
          invalid('capture.jsonl', 'Expected at most one uniquely identified function call per response.');
        }
        pendingCall = calls[0];
        if (pendingCall) recordCalls.add(pendingCall.call_id);
        finalMessage = !pendingCall && events.length === roles.length
          ? row.output.findLast(item => item?.type === 'message' && item.role === 'assistant') : undefined;
        continue;
      }
      case 'tool_completed':
        if (!pendingCall || row.event?.evidence?.callId !== pendingCall.call_id || events.length !== roleIndex) {
          invalid('capture.jsonl', 'The completion must match one earlier model call in the active role.');
        }
        checkTool(row, pendingCall, role, events.at(-1)?.id ?? null, account, manifest.files);
        pendingCall = undefined;
        events.push(row.event);
        sdkSource.events.push(index);
        break;
      case 'sdk_handoff': {
        const next = roles[roleIndex + 1];
        if (!next || !pendingCall || pendingCall.call_id !== row.callId || pendingCall.name !== 'delegate_to_' + next.toLowerCase() ||
            row.fromAgent !== role || row.toAgent !== next || events.length !== roleIndex + 1 || row.parentEventId !== events.at(-1)?.id) {
          invalid('capture.jsonl', 'The handoff must match the called destination and the preceding completed action.');
        }
        roleIndex++;
        pendingCall = undefined;
        continue;
      }
      default: invalid('capture.jsonl', 'Unsupported source record kind.');
    }
    expectedMap.push({ file: 'capture.jsonl', line: index + 1, recordId: row.recordId,
      normalizedId: row.kind === 'grant_issued' ? row.grant.id : row.event.id });
  }
  if (events.length !== roles.length || roleIndex !== roles.length - 1 || waitingForResponse || pendingCall ||
      requests !== manifest.requests || requests > 10) {
    invalid('capture.jsonl', 'The recorded requests, handoffs or completed tool calls are inconsistent.');
  }
  const finalText = Array.isArray(finalMessage?.content)
    ? finalMessage.content.filter(part => part?.type === 'output_text').map(part => part.text) : null;
  if (!finalText || !finalText.every(part => typeof part === 'string') || finalText.join('') !== result.finalOutput) {
    invalid('result.json', 'The final output differs from the recorded final assistant response.');
  }
  if (!equal(mapping, expectedMap)) invalid('mapping.json', 'The source mapping disagrees with the recorded lines and IDs.');
  if (!equal(events, chain.events) || !equal(grants, chain.grants)) {
    invalid('investigation.json', 'Normalized grants or completed actions differ from their source records.');
  }
  return sdkSource;
}

export function inspectSdkFolder(read) {
  const manifest = parse(asText(read('manifest.json'), 'manifest.json'), 'manifest.json');
  // The existing producer emits an unversioned manifest and a version 1 investigation.
  if (manifest?.schemaVersion !== undefined && manifest.schemaVersion !== 1) {
    invalid('manifest.json', 'Unsupported SDK manifest version.', 'UNSUPPORTED_SDK_FORMAT');
  }
  if (manifest?.status !== 'completed' || !manifest.files || !equal(Object.keys(manifest.files).sort(), [...names].sort()) ||
      !equal(manifest.agents, roles) || manifest.handoffs !== 2 || manifest.completedTools !== 3 ||
      typeof manifest.model !== 'string' || !manifest.model) {
    invalid('manifest.json', 'Expected the completed account-review manifest with six hashed files, three roles and two handoffs.');
  }
  const files = {};
  for (const name of names) {
    const bytes = read(name);
    if (sha(bytes) !== manifest.files[name]) invalid(name, 'The file digest differs from manifest.json.', 'RECEIPT_HASH_MISMATCH');
    files[name] = bytes;
  }
  const raw = asText(files['investigation.json'], 'investigation.json');
  let chain;
  try { chain = parseInvestigation(raw); } catch (error) { error.file = 'investigation.json'; throw error; }
  const envelope = parse(raw, 'investigation.json');
  if (chain.id !== manifest.chainId || envelope.provenance?.kind !== 'model-agent-run' ||
      envelope.provenance.framework !== 'OpenAI Agents SDK' || envelope.provenance.model !== manifest.model) {
    invalid('investigation.json', 'Expected an account-review investigation matching the manifest run and model.');
  }
  const readJson = name => parse(asText(files[name], name), name);
  const result = readJson('result.json');
  if (result?.status !== 'completed' || result.finalAgent !== roles.at(-1) || result.model !== manifest.model ||
      !equal(result.usage, manifest.usage)) {
    invalid('result.json', 'The result and manifest must agree on the completed account review.');
  }
  const account = readJson('account.json');
  if (account?.fictional !== true || account.account !== 'Northstar') {
    invalid('account.json', 'Expected the fictional Northstar account-review input.');
  }
  const sdkSource = checkLedger(readLedger(files['capture.jsonl']), envelope.chain, readJson('mapping.json'),
    account, manifest, result);
  return { chain, verifiedFileCount: names.length, sdkSource };
}
