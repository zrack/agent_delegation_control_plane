# Codex folder review validation

A local Chromium rehearsal compared the alpha.9 review paths with **Compare and save to inbox** using the same fictional records and pinned baseline.

## Repeat the cases

1. Extract the [alpha.9 Codex folder demo](https://github.com/zrack/agent_delegation_control_plane/releases/download/v0.1.0-alpha.9/adcp-codex-run-folder-demo-v0.1.0-alpha.9.zip). Start the local dashboard in a fresh browser profile. Import `complete-capture` and pin it under **Compare runs**.
2. Make a working copy of `complete-capture` named `clean-candidate`. In the copy, append `-repeat` to the final write’s call ID in both `actions.jsonl` and `attempts.jsonl`. Recompute those two files’ SHA-256 digests in the copy’s `manifest.json`. This produces a distinct run ID with the same permissions and recorded actions.
3. Import each candidate folder. For an accepted folder, choose the saved workflow and click **Compare and save to inbox**. For the missing grant, inspect the two affected actions and save an **Evidence needed** decision with a reason. Reload at the same dashboard address, then reopen each saved case.

| Candidate | Observed result |
| --- | --- |
| `clean-candidate` | **No regression found**. The inbox reproduced the verdict after reload. |
| `missing-grant` | **Needs review**. Both the editor read and write referenced the missing edit grant. Their evidence links, the saved decision and the reason reopened after reload. |
| `altered-receipt` | Import stopped at the `after.md` digest mismatch. The selected investigation, pin and both saved cases stayed intact. |

In each accepted case, the browser rechecked the three ledgers and both Markdown receipts. Expanding `after.md` after reload displayed the original text. The diff and Codex event stream showed their digests and **Verified at import only**.

An additional fresh profile exercised two failure paths. Comparing the pinned run against itself produced a different-run-ID error and preserved the pin and both cases. Changing the saved clean case’s `after.md` bytes and reloading produced a hash mismatch. The browser withheld the current verdict for the damaged case and reopened the other case with its original decision.

## Time to a saved decision

The table gives median wall-clock milliseconds over three fresh Chromium profiles per route on one workstation. The baseline was already pinned. Each timed trial began when automation supplied the local candidate folder. Saving a decision included selecting **Evidence needed**, entering the same reason, and observing the save confirmation. Reload and evidence assertions ran outside the timed interval.

| Route | Clean case saved | Missing-grant case saved | Missing-grant decision saved |
| --- | ---: | ---: | ---: |
| Alpha.9 offline review package and browser inbox | 128 ms | 130 ms | 172 ms |
| Direct Codex folder comparison and inbox save | 96 ms | 101 ms | 148 ms |

For alpha.9, a local test helper normalized each folder through the released importer. The timed path included writing the candidate investigation, invoking the released offline checker to generate a review package, and importing that package into the browser. The direct path took one folder selection, one workflow selection and one save. Both paths identified the same missing grant. Alpha.9’s browser-only **Compare runs** path also displayed that verdict, in a median 142 ms, and required the separate package path to save an inbox decision.

The individual missing-grant decision times were 189, 171 and 172 ms for the package path and 148, 139 and 311 ms for the direct path. These are automated interaction timings. Human file selection, evidence-reading and deliberation time remain unmeasured.
