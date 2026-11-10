// Controlled scripted roles and fictional authority; no model agent or enforcement.
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateChain, statusLabels } from '../../src/evaluator.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
const tools = Object.freeze({ read_account: 'account:read', export_account: 'account:export' });
const branches = ['read', 'export-expansion', 'omitted-grant'];
const lines = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';
const json = value => JSON.stringify(value, null, 2) + '\n';

function requireRecord(record, fields) {
  if (!record || fields.some(field => typeof record[field] !== 'string' || !record[field])) {
    throw new Error(`Controlled source record missing required fields: ${fields.join(', ')}`);
  }
}

function capability(permission) {
  requireRecord(permission, ['tool', 'resource_id']);
  if (!Object.hasOwn(tools, permission.tool)) throw new Error(`Unsupported controlled tool: ${permission.tool}`);
  return { action: tools[permission.tool], resource: permission.resource_id };
}

export function normalizeCapture(meta, grants, events, omittedGrantIds = []) {
  const unique = (records, key) => {
    const seen = new Set();
    for (const record of records) {
      requireRecord(record, [key]);
      if (seen.has(record[key])) throw new Error(`Duplicate controlled record: ${record[key]}`);
      seen.add(record[key]);
    }
  };
  unique(grants, 'grant_id');
  unique(events, 'event_id');
  if (omittedGrantIds.some(id => !grants.some(grant => grant.grant_id === id))) {
    throw new Error('An omitted grant must exist in the preserved source.');
  }
  const exported = grants.filter(grant => !omittedGrantIds.includes(grant.grant_id));
  return {
    id: meta.id, title: meta.title,
    source: 'Controlled local file execution; fictional self-reported grants and scripted roles',
    principal: { id: meta.principal }, rootGrantId: `${meta.id}-g1`,
    grants: exported.map(grant => {
      requireRecord(grant, ['grant_id', 'issued_by', 'issued_to', 'on_behalf_of', 'valid_from', 'expires_at']);
      if (!Array.isArray(grant.permissions) || typeof grant.may_delegate !== 'boolean'
          || (grant.parent_id !== null && typeof grant.parent_id !== 'string')) throw new Error('Malformed controlled grant.');
      return {
        id: grant.grant_id, parentGrantId: grant.parent_id,
        issuer: grant.issued_by, subject: grant.issued_to, principal: grant.on_behalf_of,
        capabilities: grant.permissions.map(capability), validFrom: grant.valid_from,
        expiresAt: grant.expires_at, canDelegate: grant.may_delegate,
      };
    }),
    events: events.map(event => {
      requireRecord(event, ['event_id', 'actor_id', 'grant_id', 'tool', 'resource_id', 'finished_at', 'outcome']);
      if (event.outcome !== 'completed' || (event.parent_event_id !== null && typeof event.parent_event_id !== 'string')) {
        throw new Error('Only completed controlled events with explicit parent links are supported.');
      }
      return {
        id: event.event_id, parentEventId: event.parent_event_id, actor: event.actor_id,
        authorityId: event.grant_id, action: { ...capability(event), at: event.finished_at, outcome: event.outcome },
      };
    }),
  };
}

async function captureBranch(output, name) {
  const directory = join(output, name);
  await mkdir(directory);
  const id = `CAP-${name}`;
  const resource = 'fictional-account:northstar';
  const meta = { id, title: name, principal: 'fictional-user:review-owner' };
  const epoch = Date.now() - 1000;
  const actors = ['scripted-coordinator', 'scripted-researcher', 'scripted-worker'];
  const grants = [];
  const events = [];
  const input = join(directory, 'account.json');
  await writeFile(input, json({ fictional: true, account: 'Northstar', review: 'Local capture experiment only' }));

  for (let index = 0; index < actors.length; index++) {
    const tool = name === 'export-expansion' && index === 2 ? 'export_account' : 'read_account';
    const grant = {
      grant_id: `${id}-g${index + 1}`, parent_id: index === 0 ? null : grants[index - 1].grant_id,
      issued_by: index === 0 ? meta.principal : actors[index - 1], issued_to: actors[index],
      on_behalf_of: meta.principal, permissions: [{ tool, resource_id: resource }],
      valid_from: new Date(epoch).toISOString(), expires_at: new Date(epoch + (120 - index * 30) * 1000).toISOString(),
      may_delegate: index < 2,
    };
    grants.push(grant);
    await writeFile(join(directory, 'grants.jsonl'), JSON.stringify(grant) + '\n', { flag: 'a' });
    const startedAt = new Date().toISOString();
    const contents = await readFile(input);
    let exportDigest = null;
    if (tool === 'export_account') {
      // Intentionally allow this fictional export: the experiment is retrospective.
      await copyFile(input, join(directory, 'account-export.json'));
      exportDigest = digest(await readFile(join(directory, 'account-export.json')));
    }
    const event = {
      event_id: `${id}-e${index + 1}`, parent_event_id: index === 0 ? null : events[index - 1].event_id,
      actor_id: actors[index], grant_id: grant.grant_id, tool, resource_id: resource,
      started_at: startedAt, finished_at: new Date().toISOString(), outcome: 'completed',
      input_sha256: digest(contents), export_sha256: exportDigest,
    };
    events.push(event);
    await writeFile(join(directory, 'events.jsonl'), JSON.stringify(event) + '\n', { flag: 'a' });
  }

  const omitted = name === 'omitted-grant' ? [`${id}-g2`] : [];
  const normalized = normalizeCapture(meta, grants, events, omitted);
  const result = evaluateChain(normalized);
  const mapping = {
    event_records: events.map((event, index) => ({ normalized_id: event.event_id, file: 'events.jsonl', line: index + 1 })),
    grant_records: grants.filter(grant => !omitted.includes(grant.grant_id)).map(grant => ({
      normalized_id: grant.grant_id, file: 'grants.jsonl', line: grants.indexOf(grant) + 1,
    })),
    deliberately_omitted_grant_ids: omitted,
    source_grants: grants.length, exported_grants: normalized.grants.length,
    source_events: events.length, exported_events: normalized.events.length,
  };
  await writeFile(join(directory, 'normalized.json'), json(normalized));
  await writeFile(join(directory, 'mapping.json'), json(mapping));
  await writeFile(join(directory, 'evaluation.json'), json(result));
  return {
    branch: name, status: result.status, label: statusLabels[result.status], completeness: result.completeness,
    event_statuses: result.events, finding_codes: [...new Set(result.findings.map(finding => finding.code))],
    source_grants: grants.length, exported_grants: normalized.grants.length, source_events: events.length,
    deliberately_omitted_grant_ids: omitted, local_export_created: name === 'export-expansion',
  };
}

async function fileDigests(directory, root = directory) {
  const files = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await fileDigests(path, root));
    else files[relative(root, path)] = digest(await readFile(path));
  }
  return files;
}

export async function runCapture(output) {
  output = resolve(output);
  await mkdir(output); // Exclusive creation: an existing run is never overwritten.
  const outcomes = [];
  for (const branch of branches) outcomes.push(await captureBranch(output, branch));
  const report = `# Controlled local capture results\n\nGenerated ${new Date().toISOString()}. Scripted roles, fictional data and authority; actual local file operations.\n\n| Branch | Evaluator result | Source/exported grants | Local export |\n| --- | --- | --- | --- |\n${outcomes.map(item => `| ${item.branch} | ${item.label} | ${item.source_grants}/${item.exported_grants} | ${item.local_export_created ? 'Created' : 'None'} |`).join('\n')}\n\nRaw grants/events, normalized input, mappings and evaluations are retained per branch. The omitted middle grant exists in the preserved source; its investigation omission is intentional and disclosed.\n\nThis tests capture/normalization and retrospective evaluation. It is not authenticated identity, autonomous-agent or protocol integration, prevention, complete production capture, independent operator review or measured customer value. No dashboard ingestion was added.\n`;
  await writeFile(join(output, 'REPORT.md'), report);
  const manifest = { schema_version: 1, created_at: new Date().toISOString(), experiment: 'controlled-local-capture',
    record_source: 'Actual local file operations by scripted roles on generated fictional data',
    identity_trust: 'Fictional self-reports; not authenticated',
    implementation: { node: process.version,
      runner_sha256: digest(await readFile(new URL(import.meta.url))),
      evaluator_sha256: digest(await readFile(new URL('../../src/evaluator.mjs', import.meta.url))) },
    outcomes, files: await fileDigests(output) };
  await writeFile(join(output, 'manifest.json'), json(manifest));
  return { output, outcomes, manifest_sha256: digest(await readFile(join(output, 'manifest.json'))) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 4 || process.argv[2] !== '--output') {
    console.error('Usage: node experiments/controlled-capture/run.mjs --output NEW_DIRECTORY');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await runCapture(process.argv[3]), null, 2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
