import { importEditTestFolder } from './edit-test-import.mjs';

const authorityLabels = {
  'within-scope': 'Within scope', violation: 'Violation',
  unverifiable: 'Unverifiable', unassessed: 'Unassessed',
};
const receiptLabels = {
  verified: 'Verified', mismatch: 'Mismatch', missing: 'Missing',
  unverified: 'Unverified', 'not-applicable': 'No completed test to verify',
};
const statusLabels = {
  verified: 'Verified against the selected records.',
  open: 'Open. The evidence does not support a verified edit and test.',
  'invalid-input': 'Invalid input. Choose an edit-and-test run folder.',
};

function element(tag, text) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  return node;
}

function fields(entries) {
  const list = element('dl');
  list.className = 'event-details';
  for (const [name, value] of entries) {
    const row = element('div');
    row.append(element('dt', name), element('dd', value ?? 'Unavailable'));
    list.append(row);
  }
  return list;
}

function panel(title) {
  const section = element('section');
  section.className = 'compare-run';
  section.append(element('h3', title));
  return section;
}

function stagePanel(title, stage) {
  const section = panel(title);
  if (!stage?.eventId && !stage?.attemptId) {
    section.append(element('p', 'No attempt or completed action was supplied for this stage.'));
    return section;
  }
  section.append(fields([
    ['Actor', stage.actor], ['Recorded action', stage.action], ['Target resource', stage.resource],
    ['Recorded outcome', stage.completed ? stage.outcome : 'No completed action recorded'],
    ['Started at', stage.startedAt], ['Completed at', stage.completedAt],
    ['Attempt ID', stage.attemptId], ['Action ID', stage.eventId],
    ...(title === 'Verifier' ? [['Depends on action', stage.dependsOnEventId]] : []),
    [title === 'Editor' ? 'Editor base revision' : 'Verifier revision', stage.revision],
  ]));
  section.append(element('h4', 'Supporting grant'), fields([
    ['Authority', authorityLabels[stage.authority]], ['Referenced grant', stage.grantId],
  ]));
  const grant = stage.grant;
  if (!grant) {
    section.append(element('p', 'The supplied records do not establish a matching grant.'));
    return section;
  }
  section.append(fields([
    ['Issuer', grant.issuer], ['Subject', grant.subject], ['Parent grant', grant.parentGrantId ?? 'Root grant'],
    ['Principal', grant.principal], ['Valid from', grant.validFrom], ['Expires at', grant.expiresAt],
    ['May delegate', grant.canDelegate ? 'Yes' : 'No'],
  ]));
  section.append(element('h4', 'Granted actions and resources'));
  const scopes = element('ul');
  for (const pair of grant.capabilities) scopes.append(element('li', `${pair.action} · ${pair.resource}`));
  section.append(scopes.childElementCount ? scopes : element('p', 'No capabilities recorded.'));
  return section;
}

function digestCheck(expected, actual) {
  if (!expected || !actual) return 'Unavailable';
  return expected === actual ? 'Match' : 'Mismatch';
}

function receiptPanels(receipt, editor) {
  const section = panel('Test receipt');
  if (receipt.status === 'not-applicable') {
    section.append(fields([['Receipt check', receiptLabels[receipt.status]]]));
    return [section];
  }
  section.append(fields([
    ['Receipt', 'test-receipt.json'], ['Receipt check', receiptLabels[receipt.status]],
    ['Receipt digest', digestCheck(receipt.expectedSha256, receipt.actualSha256)],
    ['Expected SHA-256', receipt.expectedSha256], ['Computed SHA-256', receipt.actualSha256],
    ['Tested revision', receipt.testedRevision], ['Tested tree', receipt.tree],
    ['Edited source SHA-256', editor?.afterSha256], ['Tested source SHA-256', receipt.testedSourceSha256],
    ['Test file SHA-256', receipt.testSha256], ['Recorded test command', receipt.command?.join(' ')],
    ['Recorded test result', Number.isInteger(receipt.exitCode) ? (receipt.exitCode === 0 ? 'Passed' : 'Failed') : null],
    ['Recorded exit code', receipt.exitCode],
  ]));
  if (!receipt.outputs?.length) return [section];
  const outputs = panel('Test output digests');
  for (const output of receipt.outputs) {
    outputs.append(element('h4', output.file), fields([
      ['Digest check', digestCheck(output.expectedSha256, output.actualSha256)],
      ['Expected SHA-256', output.expectedSha256], ['Computed SHA-256', output.actualSha256],
    ]));
  }
  return [section, outputs];
}

function renderResult(container, result) {
  if (result.runId) container.append(element('h2', `Run ${result.runId}`));
  if (result.diagnostics?.length) {
    const diagnostics = panel('Diagnostics');
    const list = element('ul');
    for (const { code, file, message } of result.diagnostics) {
      const item = element('li');
      item.append(element('code', [code, file].filter(Boolean).join(' · ')), ' ', message);
      list.append(item);
    }
    diagnostics.append(list);
    container.append(diagnostics);
  }
  if (result.status !== 'invalid-input') {
    const stages = element('div');
    stages.className = 'compare-sides';
    stages.append(stagePanel('Editor', result.editor), stagePanel('Verifier', result.verifier));
    container.append(stages);
    if (result.receipt) container.append(...receiptPanels(result.receipt, result.editor));
  }
}

export function connectEditTestInspector() {
  const picker = document.querySelector('#edit-test-folder');
  const status = document.querySelector('#edit-test-status');
  const results = document.querySelector('#edit-test-results');
  let selection = 0;
  if (!('webkitdirectory' in picker)) {
    picker.disabled = true;
    status.textContent = 'This browser does not support folder selection.';
    return;
  }
  picker.addEventListener('change', async () => {
    const current = ++selection;
    results.replaceChildren();
    delete results.dataset.status;
    status.textContent = 'Checking the selected folder…';
    try {
      const pending = importEditTestFolder(picker.files);
      picker.value = '';
      const result = await pending;
      if (current !== selection) return;
      renderResult(results, result);
      results.dataset.status = result.status;
      status.textContent = statusLabels[result.status];
    } catch (error) {
      if (current !== selection) return;
      results.replaceChildren();
      if (error?.code === 'INVALID_EDIT_TEST_INPUT') {
        renderResult(results, { status: 'invalid-input', diagnostics: [error] });
      }
      results.dataset.status = 'invalid-input';
      status.textContent = statusLabels['invalid-input'];
    }
  });
}
