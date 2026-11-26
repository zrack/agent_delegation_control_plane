// Only fixed labels, bounded identifiers and checked digests may enter shareable text.
import { regressionLabels } from './comparison.mjs';
import { codexReceiptNames } from './codex-import.mjs';

const closureLabels = { resolved: 'Verified resolved', ready: 'Open, ready to close', blocked: 'Open, blocked', clear: 'No closure needed' };
const receiptStates = { missing: 'missing', unlisted: 'manifest digest missing', mismatch: 'digest mismatch', invalid: 'unverifiable' };
const invoiceReceipts = ['investigation.json', 'results.json', 'expected.json', 'validation.json', 'execution.json', 'attempts.json'];
const pinLabels = { matched: 'matches the recorded baseline', conflict: 'conflicts with the recorded baseline',
  missing: 'absent', unreadable: 'unreadable' };
const snapshots = { matched: 'verified against report', missing: 'missing', mismatch: 'fingerprint mismatch', unavailable: 'no recorded fingerprint' };
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(value) ? '`' + value + '`' : 'unavailable';
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? token(value) : 'unavailable';

function comparison(stage, report, assessment) {
  const recorded = regressionLabels[report?.status] ?? 'unavailable';
  const checked = regressionLabels[assessment?.verdict?.status] ?? 'unverifiable';
  return stage + ' comparison — recorded: ' + recorded + '. Rechecked: ' + checked + '.';
}

function grantReferences(stage, run, assessment, related = []) {
  if (!run || !assessment?.verdict || assessment.states?.candidate !== 'matched') return [];
  const findings = assessment.candidateResult.findings.filter(finding => finding.grantId);
  const grants = new Map(run.grants.map(g => [g.id, g]));
  const refs = new Set();
  for (const finding of findings) {
    const present = grants.has(finding.grantId);
    const label = present ? 'grant' : 'missing grant';
    refs.add(label + ' ' + token(finding.grantId) + (finding.eventId ? ' for action ' + token(finding.eventId) : ''));
  }
  // Prefer grants that changed or were missing on the original investigation.
  for (const id of related) if (grants.has(id)) refs.add('grant ' + token(id));
  if (!refs.size) for (const reason of assessment.verdict.reasons ?? []) {
    const row = reason.row;
    const event = row?.after?.event ?? run.events.find(event => event.id === (reason.eventId ?? row?.eventLinks?.[1]));
    const grantId = event?.authorityId ?? (Array.isArray(row?.after?.capabilities) ? row.after.id : undefined);
    if (grantId && grants.has(grantId)) refs.add('grant ' + token(grantId));
  }
  if (!refs.size) {
    for (const event of run.events) {
      if (event.authorityId && grants.has(event.authorityId)) refs.add('grant ' + token(event.authorityId));
    }
  }
  if (!refs.size) return [stage + ' grant references: unverifiable.'];
  const shown = [...refs].slice(0, 3);
  return [stage + ' grant references: ' + shown.join('; ') + (refs.size > shown.length ? ' (additional references in case).' : '.')];
}

function receiptLines(stage, item, assessment, invoice, error) {
  if (item?.codex) {
    if (assessment?.codex) return [stage + ' verified output receipt: after.md SHA-256 ' + digest(assessment.codex.evidence.hashes['after.md'])];
    const name = codexReceiptNames.find(key => error?.includes(key));
    return [stage + ' receipts: ' + (name ? name + ' failed verification' : 'unverifiable') + '.'];
  }
  if (!item?.invoice) return [];
  const states = invoice?.checked?.receiptStates ?? invoice?.receiptStates;
  if (!states) return [stage + ' receipts: unverifiable.'];
  const issues = invoiceReceipts.filter(name => states[name] !== 'matched').map(name => name + ' ' + (receiptStates[states[name]] ?? 'unverifiable'));
  const lines = issues.length ? [stage + ' receipt checks: ' + issues.join('; ') + '.'] : [];
  if (invoice?.checked && states['results.json'] === 'matched') {
    lines.push(stage + ' verified output receipt: results.json SHA-256 ' + digest(item.invoice.evidence.hashes['results.json']));
  }
  if (!lines.length) lines.push(stage + ' receipt set: unverifiable.');
  return lines;
}

function nextAction(closure, item, original, followUp) {
  if (closure === 'resolved') return 'No outstanding closure action.';
  if (closure === 'clear') return 'No closure needed for the rechecked result.';
  if (closure === 'ready') return 'Review the passing follow-up, then explicitly close the case.';
  if (original?.error || (item.invoice && followUp?.originalInvoice?.error)) return 'Restore matching original receipts and recheck.';
  if (!original?.verdict) return 'Obtain matching baseline and candidate evidence and rerun the comparison.';
  if (followUp?.pinState?.status === 'conflict') return 'Review in a profile with the original baseline pin.';
  if (followUp?.pinState?.status === 'unreadable') return 'Restore access to receiver pins and recheck.';
  if (followUp?.pinChanged) return 'Verify and pin the original baseline before closing.';
  if (!item.decision) return 'Record a decision after inspecting the evidence.';
  if (!item.followUp) return 'Attach a corrected follow-up against the original baseline.';
  return 'Inspect the follow-up evidence and supply a passing correction for this case.';
}

export function caseSummary(item, original, followUp, closure) {
  const lines = ['ADCP case ' + digest(item.id), 'Disposition: ' + closureLabels[closure] + '.',
    comparison('Original', item.report, original)];
  for (const side of ['baseline', 'candidate']) {
    const state = original?.states?.[side];
    const fingerprint = item.report[side + 'Fingerprint'];
    lines.push('Original ' + side + ': ' + token(item.report[side + 'Id']) + ', ' + (snapshots[state] ?? 'unverifiable')
      + (state === 'matched' ? ', SHA-256 ' + digest(fingerprint) : '') + '.');
  }
  if (followUp?.pinState) lines.push('Receiver pin: ' + (pinLabels[followUp.pinState.status] ?? 'unverifiable') + '.');
  lines.push(...grantReferences('Original', item.candidate, original),
    ...receiptLines('Original', item, original, followUp?.originalInvoice, original?.error));
  if (item.followUp) {
    lines.push(comparison('Follow-up', item.followUp.report, followUp?.assessment));
    if (followUp?.assessment?.states?.candidate === 'matched') lines.push('Follow-up candidate: ' +
      token(item.followUp.report.candidateId) + ', verified against report, SHA-256 ' + digest(item.followUp.report.candidateFingerprint) + '.');
    lines.push(...grantReferences('Follow-up', item.followUp.candidate, followUp?.assessment,
      (original?.candidateResult?.findings ?? []).map(finding => finding.grantId)),
      ...receiptLines('Follow-up', item.followUp, followUp?.assessment, followUp?.invoice, followUp?.error));
  }
  lines.push('Next action: ' + nextAction(closure, item, original, followUp));
  return lines.join('\n');
}
