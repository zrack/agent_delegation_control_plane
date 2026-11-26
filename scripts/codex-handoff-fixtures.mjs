// Generate the fictional exports with the same repair, closure and export paths used by the viewer.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importCodexFolder } from '../src/codex-import.mjs';
import {
  applyCodexOriginalRepair, createReviewCase, importReviewPackage, resolveReviewCase, restoreReviews,
} from '../src/review.mjs';
import { runFingerprint, saveInvestigation, saveWorkflowBaseline } from '../src/storage.mjs';

const source = fileURLToPath(new URL('../docs/codex-handoff/fixtures/', import.meta.url));
const output = process.argv[2];
if (!output || process.argv.length !== 3) throw new Error('Expected the empty staging directory from build_codex_handoff.py.');
const workflow = 'Follow-up review';
const values = new Map();
const storage = { getItem: key => values.get(key) ?? null, setItem: (key, val) => values.set(key, val) };
const getStorage = () => storage;
const current = () => restoreReviews(getStorage).items[0];
const encode = text => Buffer.from(text).toString('base64');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function saveJSON(file, value) {
  const destination = join(output, file);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

async function makePin(name) {
  const folder = join(output, 'pins', name);
  await mkdir(folder, { recursive: true });
  const capture = JSON.parse(await readFile(join(source, 'matching-capture.json'), 'utf8'));
  const names = ['actions.jsonl', 'grants.jsonl', 'attempts.jsonl', 'before.md', 'after.md',
    'codex-events.jsonl', 'quickstart.diff', 'manifest.json'];
  for (const file of names) await writeFile(join(folder, file), capture[file], { flag: 'wx' });
  if (name === 'conflicting') {
    // A different completed fictional capture with a distinct manifest and run ID.
    const path = join(folder, 'codex-events.jsonl');
    const events = (await readFile(path, 'utf8')).replaceAll('fixture-item-', 'alternate-item-');
    await writeFile(path, events);
    const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'));
    manifest['codex-events.jsonl'] = digest(events);
    await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
  const selection = await Promise.all((await readdir(folder)).map(async file =>
    Object.assign(new Blob([await readFile(join(folder, file))]), { webkitRelativePath: name + '/' + file })));
  const { chain } = await importCodexFolder(selection);
  const fingerprint = await runFingerprint(chain);
  await saveJSON('receiver-baselines/' + name + '/investigation.json', { schemaVersion: 1, chain });
  await saveJSON('receiver-baselines/' + name + '/pin.json', { schemaVersion: 1, runId: chain.id, fingerprint });
  return { chain, fingerprint };
}

const matching = await makePin('matching');
const conflict = await makePin('conflicting');
assert.notEqual(matching.chain.id, conflict.chain.id);
saveInvestigation(getStorage, matching.chain);
saveWorkflowBaseline(getStorage, workflow, matching.chain, matching.fingerprint);

const donorText = await readFile(join(source, 'alpha15-case.json'), 'utf8');
const donor = JSON.parse(donorText);
assert.equal(donor.report.baselineFingerprint, matching.fingerprint);
await mkdir(join(output, 'donors'));
await writeFile(join(output, 'donors/matching-case.json'), donorText, { flag: 'wx' });
const mismatched = structuredClone(donor);
mismatched.codex.workflow = 'Separate quickstart review';
mismatched.followUp.codex.workflow = mismatched.codex.workflow;
delete mismatched.resolution;
await saveJSON('donors/mismatched-workflow.json', mismatched);

const corrupt = encode('A fictional modified output.\n');
const damaged = structuredClone(donor);
damaged.codex.evidence.files['after.md'] = corrupt;
damaged.note = 'Check the original quickstart output before closing.';
await importReviewPackage(getStorage, JSON.stringify(damaged));
await applyCodexOriginalRepair(getStorage, current(), donorText);

async function exportCase(shareHistory) {
  const item = current();
  const bundle = JSON.parse(await createReviewCase(item, item.note, {
    includeCodexReceipts: true, includeSenderHistory: shareHistory, getStorage,
  }));
  // Only these fictional event times vary from build to build. Canonicalize the exported
  // examples without mutating the viewer or claiming the fixture is a live capture.
  for (const event of bundle.senderHistory?.entries ?? []) {
    event.at = event.kind === 'repair' ? '2026-01-01T01:00:00.000Z' : '2026-01-01T01:02:00.000Z';
  }
  return bundle;
}

await saveJSON('cases/open-follow-up.json', await exportCase(true));
await resolveReviewCase(getStorage, current());
const shared = await exportCase(true);
await saveJSON('cases/history-on.json', shared);
await saveJSON('cases/history-off.json', await exportCase(false));
const alteredOriginal = structuredClone(shared);
alteredOriginal.codex.evidence.files['after.md'] = corrupt;
await saveJSON('cases/altered-original.json', alteredOriginal);
const alteredFollowUp = structuredClone(shared);
alteredFollowUp.followUp.codex.evidence.files['after.md'] = encode('Fictional changed follow-up output.\n');
await saveJSON('cases/altered-follow-up.json', alteredFollowUp);
