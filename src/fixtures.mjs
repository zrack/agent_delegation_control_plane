// Deliberately synthetic and fixed. No personal, provider, or production records.
const cap = action => ({ action, resource: 'crm://accounts/northstar' });
function example(id, title, summary, minute) {
  const time = seconds => `2026-09-13T10:${minute}:${seconds}Z`;
  const principal = { id: 'user:avery', name: 'Avery Chen', role: 'Account operations · fictional user' };
  const grant = (suffix, parent, issuer, subject, actions, expiry, canDelegate) => ({
    id: `${id}-g${suffix}`, parentGrantId: parent === null ? null : `${id}-g${parent}`,
    issuer, subject, principal: principal.id, capabilities: actions.map(cap),
    validFrom: '2026-09-13T10:00:00Z', expiresAt: `2026-09-13T10:${expiry}:00Z`, canDelegate,
  });
  return {
    id, title, summary, principal, rootGrantId: `${id}-g1`, source: 'Synthetic fixture',
    completedAt: time('12'), intent: 'Review the Northstar account. Read account data only.',
    grants: [
      grant(1, null, principal.id, 'coordinator', ['account:read'], '50', true),
      grant(2, 1, 'coordinator', 'research-agent', ['account:read'], '40', true),
      grant(3, 2, 'research-agent', 'summary-agent', ['account:read'], '30', false),
    ],
    events: [
      { id: `${id}-e1`, parentEventId: null, actor: 'coordinator', label: 'Coordinator', job: 'Route the account review', authorityId: `${id}-g1`, action: { ...cap('account:read'), at: time('02'), outcome: 'completed' } },
      { id: `${id}-e2`, parentEventId: `${id}-e1`, actor: 'research-agent', label: 'Research agent', job: 'Read the account record', authorityId: `${id}-g2`, action: { ...cap('account:read'), at: time('07'), outcome: 'completed' } },
      { id: `${id}-e3`, parentEventId: `${id}-e2`, actor: 'summary-agent', label: 'Summary agent', job: 'Prepare account context', authorityId: `${id}-g3`, action: { ...cap('account:read'), at: time('12'), outcome: 'completed' } },
    ],
  };
}
const valid = example('CH-001', 'Account review', 'Authority narrows across every hop.', '04');
const overreach = example('CH-002', 'Unexpected account export', 'A downstream agent receives export permission.', '08');
overreach.events[2].actor = 'export-agent';
overreach.events[2].label = 'Export agent';
overreach.events[2].job = 'Export the account record';
overreach.events[2].action.action = 'account:export';
overreach.grants[2].subject = 'export-agent';
overreach.grants[2].capabilities = [cap('account:export')];
const missing = example('CH-003', 'Incomplete authority trail', 'The research agent’s grant is absent.', '12');
missing.grants.splice(1, 1);
export const chains = [overreach, valid, missing];
