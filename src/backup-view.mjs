import { MAX_BACKUP_BYTES, applyRestore, backupChoices, createBackup, inspectBackup, previewRestore } from './backup.mjs';

export function connectBackup({ rawStorage, getStorage, onRestore }) {
  const panel = document.querySelector('#inbox-backup');
  const element = id => panel.querySelector('#backup-' + id);
  const source = element('source'), destination = element('destination'), result = element('result');
  const file = element('file'), preview = element('preview'), apply = element('apply'), cancel = element('cancel');
  const message = element('status');
  let inspected, ready, request = 0;
  const checked = (root, kind) => [...root.querySelectorAll('input:checked')].filter(i => i.dataset.kind === kind).map(i => i.value);

  function option(root, kind, value, text, disabled = false, selected = false) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.kind = kind;
    input.value = value;
    input.checked = selected;
    input.disabled = disabled;
    label.append(input, ' ' + text);
    root.append(label);
  }

  function refreshSource() {
    source.replaceChildren();
    try {
      const { cases, pins } = backupChoices(getStorage);
      for (const row of cases) option(source, 'case', row.id, row.title + (row.workflow ? ' · ' + row.workflow : ''));
      for (const pin of pins) option(source, 'pin', pin.name, 'Include pin · ' + pin.name + ' · ' + pin.runId);
      if (!cases.length) source.textContent = 'The inbox is empty.';
    } catch (error) { message.textContent = error.message; }
  }
  function resetRestore(text = '') {
    request++; inspected = ready = undefined;
    file.value = '';
    destination.replaceChildren(); result.replaceChildren();
    preview.hidden = apply.hidden = cancel.hidden = true;
    message.textContent = text;
  }
  function resetSharing() {
    for (const name of ['receipts', 'notes', 'history']) element(name).checked = false;
  }
  panel.addEventListener('toggle', () => {
    if (panel.open) refreshSource();
    else { resetRestore(); resetSharing(); }
  });
  element('export').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const raw = await createBackup(rawStorage(), { caseIds: checked(source, 'case'), pinNames: checked(source, 'pin'),
        receipts: element('receipts').checked, notes: element('notes').checked, senderHistory: element('history').checked });
      const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'adcp-inbox-backup.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      resetSharing(); refreshSource();
      message.textContent = 'Backup downloaded.';
    } catch (error) { message.textContent = error.message; }
    finally { button.disabled = false; }
  });
  file.addEventListener('change', async () => {
    const chosen = file.files[0]; resetRestore();
    if (!chosen) return;
    const version = request;
    try {
      if (chosen.size > MAX_BACKUP_BYTES) throw new Error('Choose a backup no larger than 4 MiB.');
      const report = await inspectBackup(rawStorage(), await chosen.text());
      if (request !== version) return;
      inspected = report;
      for (const row of report.rows) option(destination, 'case', row.id, row.title + (row.present ? ' · already saved, preserved' : ' · new')
        + (row.receipts ? ' · includes receipts' : '') + (row.note ? ' · includes a note' : '')
        + (row.senderEvents ? ' · sender events ' + row.senderEvents : ''), row.present, !row.present);
      for (const p of report.pins) {
        const details = p.state === 'conflict' ? 'conflicts with local evidence, preserved' : p.state === 'matched' ? 'already pinned' : 'available to accept';
        option(destination, 'pin', p.name, 'Receiver pin · ' + p.name + ' · ' + details + ' · ' + p.runId + ' · SHA-256 ' + p.fingerprint
          + (p.state === 'conflict' && p.existing ? ' · current ' + p.existing.runId + ' · ' + p.existing.fingerprint : ''), p.state !== 'available');
      }
      preview.hidden = cancel.hidden = false;
      message.textContent = 'Choose cases. Accept a receiver pin only after checking its fingerprint independently.';
    } catch (error) { if (request === version) resetRestore(error.message); }
  });
  destination.addEventListener('change', () => {
    request++; ready = undefined; apply.hidden = true; result.replaceChildren();
  });
  cancel.addEventListener('click', () => resetRestore('Restore canceled.'));
  preview.addEventListener('click', async () => {
    if (!inspected) return;
    const version = ++request;
    ready = undefined; result.replaceChildren(); apply.hidden = true;
    try {
      const plan = await previewRestore(rawStorage(), inspected, checked(destination, 'case'), checked(destination, 'pin'));
      if (version !== request) return;
      for (const row of plan.outcomes) {
        const p = document.createElement('p');
        p.textContent = [row.title, row.previously ? 'Existing case: ' + row.previously + ' → ' + row.disposition : row.disposition, ...row.warnings].join(' · '); result.append(p);
      }
      if (plan.pinNames.length) {
        const p = document.createElement('p'); p.textContent = 'Pins to add: ' + plan.pinNames.join(', '); result.append(p);
      }
      ready = plan; apply.hidden = false;
      message.textContent = 'Preview complete. Confirm to save the selection.';
    } catch (error) { if (version === request) message.textContent = error.message; }
  });
  apply.addEventListener('click', async () => {
    if (!ready || apply.disabled) return;
    const plan = ready; ready = undefined;
    for (const el of [apply, preview, cancel, file, destination]) el.disabled = true;
    try {
      await applyRestore(rawStorage(), plan);
      resetRestore('Selected cases and pins restored.');
      refreshSource(); onRestore();
    } catch (error) { resetRestore(error.message); }
    finally { for (const el of [apply, preview, cancel, file, destination]) el.disabled = false; }
  });
}
