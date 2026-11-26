# Review a fictional Codex handoff

**First case file to open: `cases/history-on.json`.** Before opening it, set up the matching pin in a fresh receiver profile as described below. Keep this sheet with the kit. The facilitator has a separate answer key.

From the source checkout that includes opt-in sender history, run `python3 scripts/serve.py`. Open the printed loopback address in a fresh Chromium profile. Use that same address and port when you reload. Each row below uses an empty receiver profile because the variants share one case identity and an existing review preserves local decisions.

## Set up a receiver

For a row specifying a pin folder, open **Investigate a run → Import a Codex run folder** and choose the entire specified folder. In **Compare runs**, select that imported run as the **Baseline run**. Expand **Save or replace a workflow baseline**, enter exactly `Follow-up review`, and select **Save baseline**. For “none”, begin with an empty profile and leave the workflow unpinned.

In **Regression inbox → Import review package or case**, choose the JSON specified in the row. Read the evidence before changing anything. Reload, reopen the case and record what you see. Leave the pin and case disposition as you found them.

| Row | Case file | Receiver pin folder |
| --- | --- | --- |
| 1 | `cases/history-on.json` | `pins/matching` |
| 2 | `cases/history-off.json` | `pins/matching` |
| 3 | `cases/history-on.json` | none |
| 4 | `cases/history-on.json` | `pins/conflicting` |
| 5 | `cases/altered-original.json` | `pins/matching` |
| 6 | `cases/altered-follow-up.json` | `pins/matching` |
| 7 | `cases/open-follow-up.json` | `pins/matching` |

For each row, record the disposition after reload, the checklist reason or evidence that supports it, who recorded the history shown, and what appears in local repair history. Identify the grant covering the corrected read and write and the evidence for the changed file. If a closure is available, distinguish the option to close from an already verified closure. Record setup time, time to a supported decision, and any help you needed.

## Make your own handoff

1. Start in a new sender profile with the matching pin. Import `cases/altered-original.json`. In **Restore original Codex receipts**, try `donors/mismatched-workflow.json`. Then choose `donors/matching-case.json`, inspect the preview, cancel it, and reload. Record any changes to the note, decision, pin or local history.
2. Preview the matching donor again. Apply the repair. Reload, inspect the before and after digests and open the corrected `grants.jsonl` under follow-up evidence. Decide whether to select **Close as resolved**. To complete the handoff, close only once you can explain your decision. Reload again.
3. Under **Export review package or case**, check **Include Codex receipts in case download**. Download once with sender history off and once with it on. Use distinct filenames.
4. Give the two exports to two fresh receiver profiles, each with its own matching pin. Import one export per profile and reload. Explain which evidence verifies the result, which account of the repair traveled with each file, and which actions each receiver performed locally. If you re-export from a receiver, inspect what history it can share.
