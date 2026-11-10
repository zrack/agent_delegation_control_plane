import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assessFollowUp, assessReview, attachReviewFollowUp, importReviewPackage, resolveReviewCase,
  restoreReviews, saveReviewDecision } from '../../src/review.mjs';

const script = fileURLToPath(new URL('../../scripts/alpha-rehearsal.mjs', import.meta.url));

test('fresh rehearsal output is reproducible, separate, and exercises the real inbox and closure rules', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'adcp-alpha-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = join(directory, 'one');
  const second = join(directory, 'two');
  const generate = output => spawnSync(process.execPath, [script, '--output', output], {
    cwd: directory, encoding: 'utf8', timeout: 30_000,
  });
  for (const destination of [first, second]) {
    const result = generate(destination);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  }

  const reviewerFiles = ['TASK_SHEET.md', 'case-01.json', 'case-02.json', 'case-03.json',
    'follow-up-01.json', 'follow-up-02.json', 'follow-up-03.json'];
  for (const path of [first, second]) {
    assert.deepEqual(readdirSync(join(path, 'reviewer')).sort(), reviewerFiles);
    assert.deepEqual(readdirSync(join(path, 'facilitator')), ['ANSWER_KEY.md']);
  }
  for (const file of reviewerFiles) {
    assert.deepEqual(readFileSync(join(first, 'reviewer', file)), readFileSync(join(second, 'reviewer', file)));
  }
  const duplicate = generate(first);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /already exists/);
  const read = name => readFileSync(join(first, 'reviewer', name), 'utf8');
  const store = new Map();
  const getStorage = () => ({ getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) });
  const expected = [['01', 'pass'], ['02', 'regression'], ['03', 'review']];
  for (const [index, verdict] of expected) {
    const { items: [original] } = await importReviewPackage(getStorage, read(`case-${index}.json`));
    assert.equal((await assessReview(original)).verdict.status, verdict);
    if (verdict === 'pass') continue;
    const kind = verdict === 'regression' ? 'fix-required' : 'evidence-needed';
    const [decided] = saveReviewDecision(getStorage, original, kind, 'Check the supplied follow-up.');
    if (index === '02') {
      await assert.rejects(attachReviewFollowUp(getStorage, decided, read('follow-up-01.json')), /missing or altered/);
      await assert.rejects(resolveReviewCase(getStorage, decided), /passing follow-up/);
    }
    const [attached] = await attachReviewFollowUp(getStorage, decided, read(`follow-up-${index}.json`));
    await resolveReviewCase(getStorage, attached);
    const saved = restoreReviews(getStorage).items.find(item => item.id === original.id);
    assert.equal((await assessFollowUp(saved, await assessReview(saved))).resolved, true);
  }
});
