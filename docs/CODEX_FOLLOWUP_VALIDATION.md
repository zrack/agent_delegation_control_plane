# Codex follow-up validation

Three fresh Chromium profiles exercised the development dashboard on loopback with the fictional folders from the [alpha.10 Codex inbox demo](https://github.com/zrack/agent_delegation_control_plane/releases/download/v0.1.0-alpha.10/adcp-codex-inbox-demo-v0.1.0-alpha.10.zip).

## Repeat the missing-grant correction

1. Import `complete-capture` and pin it under **Compare runs**. Import `missing-grant` and choose **Compare and save to inbox** against that workflow. The inbox displays **Needs review** for the editor’s read and write.
2. Save an **Evidence needed** decision with a reason. Under **Attach corrected Codex folder**, choose `clean-candidate`. This folder restores the editor grant and uses a distinct call ID for the write. The baseline, original case and correction each have a different run ID.
3. Inspect both grant ledgers. The original `grants.jsonl` contains only the root grant. The corrected ledger also contains the editor grant and its link to the root. The follow-up shows **No regression found** against the original baseline fingerprint. Reloading at this stage displays **Open**.
4. Choose **Close as resolved** and reload at the same address. The case displayed **Resolved** with its decision, reason and passing follow-up. Opening each grant ledger again displayed the bytes from its respective folder.

## Conditions that kept the case open

| Condition exercised | Observed result |
| --- | --- |
| Attached `altered-receipt` after saving the original decision | The `after.md` hash mismatch stopped attachment. The saved case and workflow pin were identical before and after the attempt. |
| Attached a distinct, manifest-valid follow-up that still lacked the editor grant | The follow-up reproduced **Needs review**. Closure stayed disabled after reload. This fixture used `clean-candidate` with the missing-grant ledger and its matching digest. |
| Replaced the workflow pin in another tab after closing the case | The first tab displayed **Open** and disabled closure. Reload reproduced the conflict, preserved the replacement pin and retained the review reason. |
| Replaced the pin after a passing attachment, before closure | The test delayed the first tab’s pin-change notification to keep its close button active. Clicking it still rejected the write. The saved case and replacement pin survived the attempt. |
| Changed the retained follow-up `after.md` bytes in a disposable browser profile after closing | Reload detected the digest mismatch, displayed **Open**, and disabled closure. The saved decision and original pin remained available. |
