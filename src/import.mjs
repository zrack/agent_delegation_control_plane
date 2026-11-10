// Structural intake only. Imported claims never authenticate identities or completeness.
export const MAX_IMPORT_BYTES = 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, label, max = 1000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must be a nonempty string of at most ${max} characters.`);
  return value;
};
const id = (value, label) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(value)) throw new Error(`${label} has an unsupported identifier.`);
  return value;
};
const parent = (value, label) => value === null ? null : id(value, label);
const list = (value, label, min = 0, max = 200) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${label} must contain ${min}–${max} records.`);
  return value;
};
const pair = value => {
  if (!object(value)) throw new Error('Capability must be an action/resource pair.');
  return { action: text(value.action, 'Action', 200), resource: text(value.resource, 'Resource') };
};
const optional = (value, fallback) => value === undefined ? fallback : text(value, 'Description', 2000);

export function parseInvestigation(contents) {
  if (typeof contents !== 'string' || new TextEncoder().encode(contents).length > MAX_IMPORT_BYTES) throw new Error('Choose an investigation JSON file smaller than 1 MB.');
  let envelope;
  try { envelope = JSON.parse(contents); } catch { throw new Error('The file is not valid JSON.'); }
  if (!object(envelope) || envelope.schemaVersion !== 1 || !object(envelope.chain)) throw new Error('Expected a version 1 investigation export with a chain.');
  const source = envelope.chain;
  const chainId = id(source.id, 'Chain ID');
  if (chainId.startsWith('CH-')) throw new Error('Imported IDs cannot replace built-in examples.');
  if (!object(source.principal)) throw new Error('Principal evidence is missing.');
  const grants = list(source.grants, 'Grants').map(grant => {
    if (!object(grant) || typeof grant.canDelegate !== 'boolean') throw new Error('Each grant must declare whether delegation is allowed.');
    return { id: id(grant.id, 'Grant ID'), parentGrantId: parent(grant.parentGrantId, 'Parent grant'),
      issuer: id(grant.issuer, 'Issuer'), subject: id(grant.subject, 'Subject'), principal: id(grant.principal, 'Grant principal'),
      capabilities: list(grant.capabilities, 'Capabilities', 0, 100).map(pair),
      validFrom: text(grant.validFrom, 'Grant start', 100), expiresAt: text(grant.expiresAt, 'Grant expiry', 100), canDelegate: grant.canDelegate };
  });
  const events = list(source.events, 'Events', 1).map(event => {
    if (!object(event) || !object(event.action) || event.action.outcome !== 'completed') throw new Error('Only completed actions can be investigated in this viewer.');
    const normalized = { id: id(event.id, 'Event ID'), parentEventId: parent(event.parentEventId, 'Parent event'),
      actor: id(event.actor, 'Actor'), authorityId: id(event.authorityId, 'Authority'),
      label: optional(event.label, event.actor), job: optional(event.job, 'Inspect the recorded action'),
      action: { ...pair(event.action), at: text(event.action.at, 'Action time', 100), outcome: 'completed' } };
    if (object(event.evidence)) normalized.evidence = Object.fromEntries(['callId', 'tool', 'artifactSha256'].filter(key => event.evidence[key] !== undefined).map(key => [key, text(event.evidence[key], 'Evidence reference', 300)]));
    return normalized;
  });
  for (const [records, label] of [[grants, 'grant'], [events, 'event']]) {
    if (new Set(records.map(record => record.id)).size !== records.length) throw new Error(`Duplicate ${label} identifiers make this export ambiguous.`);
  }
  return { id: chainId, title: optional(source.title, 'Imported investigation'), summary: optional(source.summary, 'Completed actions from a local file.'),
    principal: { id: id(source.principal.id, 'Principal ID'), name: optional(source.principal.name, source.principal.id), role: optional(source.principal.role, 'Identity supplied by file') },
    rootGrantId: id(source.rootGrantId, 'Root grant'), intent: optional(source.intent, 'Intent supplied in imported records'),
    completedAt: optional(source.completedAt, events.at(-1).action.at), source: optional(source.source, 'Imported records'),
    grants, events, imported: true };
}

export function mergeInvestigation(chains, imported) {
  if (!imported.imported || chains.some(chain => !chain.imported && chain.id === imported.id)) throw new Error('This import would replace a built-in example.');
  return [...chains.filter(chain => chain.id !== imported.id), imported];
}
