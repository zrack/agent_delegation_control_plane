import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { WORKFLOW_BASELINE_KEY } from '../../src/storage.mjs';

const origin = process.env.ADCP_TEST_ORIGIN;
export const kit = process.env.ADCP_TEST_KIT;
export const work = process.env.ADCP_TEST_WORK;

// Isolate each recipient's browser storage while exercising the same dashboard origin.
export async function browserSession(t) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  return browser;
}

export async function profile(browser, t) {
  const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
  const unexpected = [];
  await context.route('**/*', route => {
    const target = new URL(route.request().url());
    if (target.origin === origin || ['blob:', 'data:'].includes(target.protocol)) return route.continue();
    unexpected.push('Request outside dashboard origin');
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => unexpected.push(error.name + ': ' + error.message));
  t.after(async () => {
    await context.close();
    assert.deepEqual(unexpected, [], 'Dashboard should run without errors or nonlocal requests');
  });
  await page.goto(origin);
  assert.equal(await page.evaluate(() => localStorage.length), 0, 'A new profile must start with empty storage');
  return page;
}

export async function importCase(page, file) {
  await page.locator('#review-link').click();
  await page.locator('#review-package-file').setInputFiles(file);
  await page.waitForURL(url => url.hash.startsWith('#review?item='));
  await page.locator('#review-detail .review-case, #review-detail #review-note-form').first().waitFor();
}

export async function savePin(page, folder, { replace = false } = {}) {
  await page.locator('#codex-folder').setInputFiles(folder);
  await page.waitForURL(url => url.hash.startsWith('#CODEX-'));
  const id = new URL(page.url()).hash.slice(1).split('/')[0];
  await page.locator('#compare-link').click();
  await page.locator('#baseline-run').selectOption(id);
  await page.getByText('Save or replace a workflow baseline', { exact: true }).click();
  await page.locator('#workflow-name').fill('Follow-up review');
  await page.locator('#save-workflow-baseline').click();
  if (replace) await page.locator('#confirm-baseline-replacement').click();
  await page.locator('#workflow-status').filter({ hasText: 'Saved baseline ' + id }).waitFor();
}

export async function pinImportedRun(page, workflowName) {
  await page.locator('#imported-pin-workflow').fill(workflowName);
  await page.getByRole('button', { name: 'Pin this run as a workflow baseline', exact: true }).click();
}

// Observe the saved pin without using internal APIs to create or change it.
export const savedPin = page => page.evaluate(key => localStorage.getItem(key), WORKFLOW_BASELINE_KEY);

export async function disposition(page) {
  const badge = page.locator('#review-detail .review-case .badge').first();
  await badge.waitFor();
  return { state: await badge.innerText(), ready: await page.locator('#resolve-review-case').isEnabled() };
}

export async function expand(page, summary) {
  const control = page.getByText(summary, { exact: true });
  if (!(await control.evaluate(node => node.parentElement.open))) await control.click();
}
