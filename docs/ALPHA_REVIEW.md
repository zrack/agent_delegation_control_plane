# First-use alpha review

Use fictional records only. The viewer and rehearsal kit run locally without an
API key, account, Docker, or model calls.

## Try the portable invoice review demo

1. Extract **Source code (zip)** from [v0.1.0-alpha.6](https://github.com/zrack/agent_delegation_control_plane/releases/tag/v0.1.0-alpha.6).
   Run `python3 scripts/serve.py` from the extracted source with Python 3.11 or newer. Extract the
   [portable invoice review demo ZIP](https://github.com/zrack/agent_delegation_control_plane/releases/download/v0.1.0-alpha.6/adcp-portable-invoice-review-demo-v0.1.0-alpha.6.zip) separately.
2. Open the printed loopback address in a fresh browser profile. In **Regression
   inbox**, choose **Import review package or case** and select
   `invoice-b-resolved.json`.
3. In **Review decision and follow-up**, check **Evidence needed** and
   **Resolved**. Under **Inspect follow-up evidence**, check **Totals verified**
   and expand **File checks against manifest** to see six matches. Reload at
   the same address and confirm that the decision, follow-up, and **Resolved**
   status return.
4. Import `invoice-c-resolved.json` in the same inbox. Repeat the checks and
   reload. The saved decision should be **Fix required**.
5. Use a second fresh profile or start the dashboard on another loopback port
   with `python3 scripts/serve.py --port 48732`. Import each **Open** variant
   through **Import review package or case**. For each file, check the import
   warning, confirm **Close as resolved** is disabled, and reload to verify
   that the verdict stays **Open**. Separate storage lets you test the variants
   independently of the existing local decisions and follow-ups.

| Case file | Expected status after reload | What to verify |
| --- | --- | --- |
| `invoice-b-resolved.json` | **Resolved** | Missing validation receipt in the original case. Corrected follow-up verifies 1,231 cents. |
| `invoice-c-resolved.json` | **Resolved** | Altered output in the original case. Corrected follow-up verifies 2,441 cents. |
| `invoice-b-altered-receipt.json` | **Open** | Follow-up output changed after export. Closure verification fails. |
| `invoice-c-different-baseline.json` | **Open** | The packaged baseline differs from the original. Closure verification fails. |

All four cases contain fictional evidence. Import rechecks the included
baseline and receipt snapshots and leaves workflow pins unchanged.

From the current source checkout, reopen an **Open** case after reload and
check its **Closure checklist**. The altered-receipt case identifies
`results.json` in the follow-up and points to the corrected folder.
The different-baseline case shows the expected and supplied run IDs and
fingerprints. Reimport the case with its original baseline. If a local
workflow pin conflicts, the checklist shows the current pin and keeps it in
place.

## Restore matching evidence

From the current source checkout, import one of the open invoice demo variants
in a fresh inbox. Open **Restore matching evidence** on the saved case and choose
the corresponding resolved JSON file. Preview the baseline or follow-up that
will be restored, then select **Apply evidence repair**. The case keeps its
decision and notes. The restored follow-up must pass the baseline comparison
and the invoice receipt checks.

To close the repaired case, pin the original baseline under the case's workflow
and select **Close as resolved**. A conflicting pin stays in place and blocks
closure. Reload to verify the saved result.

## Compare and save an invoice candidate

Keep using the alpha.6 dashboard and extract the [invoice folder demo ZIP from alpha.5](https://github.com/zrack/agent_delegation_control_plane/releases/download/v0.1.0-alpha.5/adcp-invoice-follow-up-demo-v0.1.0-alpha.5.zip) for the next two exercises.

1. Use **Import a completed run** to open `invoice-a-baseline/investigation.json`
   from the demo ZIP. Under **Compare runs**, select the imported invoice A as
   **Baseline run**.
2. Open **Save or replace a workflow baseline**, enter **Demo invoices** as the
   workflow name, and select **Save baseline**. Keep this pin for both cases.
3. In **Regression inbox**, expand **Import invoice-run folder**. Choose
   `invoice-b-missing-receipt`, select **Demo invoices** under **Compare against
   pinned baseline**, and choose **Compare and save to inbox**. Repeat for
   `invoice-c-altered-output`.
4. Open each saved entry. Both should show **No regression found**, **Within
   scope**, and **Execution recorded complete**. The **Output** panel and
   **File checks against manifest** show the individual receipt problems.

| Candidate folder | Expected output | Affected file |
| --- | --- | --- |
| `invoice-b-missing-receipt` | **Unverifiable** | `validation.json` shows **File missing** |
| `invoice-c-altered-output` | **Hash mismatch** | `results.json` shows **Hash mismatch** |

## Review and close an invoice receipt case

1. Open the saved invoice B case. In **Review decision and follow-up**, choose
   **Evidence needed**, explain that the validation receipt is missing, and
   select **Save decision**. For invoice C, choose **Fix required** and record
   that the output bytes differ from the manifest.
2. Use **Attach follow-up invoice folder** to select `invoice-b-corrected` for
   invoice B or `invoice-c-corrected` for invoice C. The corrected folders
   retain the original candidate investigations and run IDs.
3. Open **Inspect follow-up evidence**. Confirm the follow-up shows
   **No regression found**, **Within scope**, **Totals verified**, and
   **Execution recorded complete**. All six files should match the manifest.
   The verified totals are 1,231 cents for B and 2,441 cents for C.
4. Select **Close as resolved**, then reload at the same address. Confirm the
   saved decision and **Resolved** status return for each case.

Before attaching a correction, try the original failing folder as the follow-up.
The case stays **Open**, and **Close as resolved** stays disabled. A replacement
baseline also blocks attachment and closure until the original pin is restored.

Receipt snapshots count toward the inbox's 2 MiB limit.

## Share an invoice review case

In the alpha.6 dashboard, open a resolved invoice case and expand
**Export review package or case**.

1. Select **Include invoice receipts in case download**, then **Download review
   case**. The file includes the baseline, original receipts, review decision,
   corrected follow-up, and verified closure. Execution receipts may contain logs.
   The note has its own checkbox.
2. In a fresh browser profile, use **Import review package or case** to open the
   downloaded file. The viewer checks the baseline and receipt snapshots before
   showing **Resolved**. Reload and check that the decision and closure return.
   The import does not create a workflow pin.
3. Import a fictional copy with a changed receipt or substituted baseline.
   Check the import warning and confirm the case stays **Open**. If the receiving
   browser already pins a different baseline for the same workflow, it keeps
   that pin and leaves the imported case open.

The receipt checkbox starts unchecked. Ordinary invoice case downloads include
the original delegation evidence and decision. [Privacy and sharing guidance](PRIVACY.md)

## Import a resolved case

Use the alpha.6 dashboard started above for this exercise. The
[complete review case demo ZIP from alpha.3](https://github.com/zrack/agent_delegation_control_plane/releases/download/v0.1.0-alpha.3/adcp-review-case-demo-v0.1.0-alpha.3.zip)
contains the saved case and follow-up files for this exercise and the next one.

1. In **Regression inbox**, select **Import review package or case** and open
   `resolved-case.json` from the review case demo ZIP.
2. Check the **Fix required** decision and its reason, “Export exceeds the parent
   grant.” The original run should show **Rechecked · Regression detected** and
   the follow-up **Rechecked · No regression found**. Open **Inspect follow-up
   evidence** to see the recheck against the original baseline.
3. Reload at the same address and confirm the decision, reason, and **Resolved**
   status persist.

## Review and export the case yourself

1. Open the dashboard in another fresh browser profile. In **Regression inbox**,
   select **Import review package or case** and open `case-02.json` from the review case demo ZIP.
2. Open the evidence behind the unexpected export. Record who acted for whom,
   which action and resource were involved, and which grant explains the finding.
3. Choose a **Decision**, enter your reason, and select **Save decision**.
   Use **Attach follow-up package** to open `follow-up-02.json` from the same folder.
   Check the baseline and evidence, then decide whether to **Close as resolved**.
4. Open **Export review package or case** and select **Download review case**.
   Import the downloaded `review-case.json` in a fresh profile to repeat the
   reload check with your own decision.

## Run the full rehearsal

With Node 22 or newer, run `node scripts/alpha-rehearsal.mjs` from the source
directory. The kit writes six importable packages and a task sheet to
`output/private-alpha-rehearsal/reviewer/`. To generate another copy, run the
command with `--output NEW_DIRECTORY`. For a facilitated review, give reviewers
the `reviewer` folder and keep the answer key in the separate `facilitator`
folder until they finish.

Record how long setup took, where you needed help, and what evidence drove your
decision. Use the [reviewer task sheet](alpha-rehearsal/TASK_SHEET.md) for the
full rehearsal. The [facilitator answer key](alpha-rehearsal/ANSWER_KEY.md) is
available after you finish.

Share worksheet results with your facilitator. For reproducible setup or review
friction, [open a GitHub issue](https://github.com/zrack/agent_delegation_control_plane/issues/new/choose)
with the release, environment, and steps using fictional inputs. Keep personal
details and operational evidence out of issues. Report vulnerabilities through
the private route in the [security policy](../SECURITY.md).

## Standalone investigation smoke test

1. Record the checked-out revision, operating system, Python and Node versions.
   Follow [Run locally](../README.md#run-locally), then open the loopback dashboard.
2. Explain CH-001, CH-002 and CH-003 without reading an answer key: who acted for
   whom, the recorded action/resource, the supporting grant and the reason for the
   result. Expand raw/compared evidence and identify anything unclear.
3. Select a permissioned fictional `investigation.json`. Confirm the source-claim
   label, both agent hops and their raw evidence. Reload while a hop is selected;
   the run and selected hop should return if saving succeeded. Keep the original
   export as a backup.
4. Reimport the same ID and confirm it appears once. Try an invalid JSON file;
   existing examples and saved records should remain usable. Use **Clear imported
   runs** only on these disposable fictional test imports, then reload to confirm
   their removal. The original files should remain unchanged.
5. Run `python3 scripts/check.py`. With the separately installed, hash-pinned SDK
   dependencies and Docker image, run the full offline command in the
   [pilot guide](../experiments/sandbox-agent/README.md). These checks make no
   provider calls. Record failures and any assistance needed.

## Review notes

| Item | Record |
| --- | --- |
| Reviewer and revision | Reviewer role, revision and environment; keep personal details out of shared notes |
| Setup | Elapsed time, unclear instructions, failed steps and assistance |
| Evidence understanding | Explanation for each chain, evidence consulted, mistakes or uncertainty |
| Import/reload | Whether the selected run/hop and raw evidence returned; saving messages observed |
| Recovery | Invalid-file and clear/reimport results |
| Usefulness | Would this help an actual investigation? What was unchanged or worse? |

Do not score an explanation from the status badge alone. A successful run does not
authenticate the supplied identity or demonstrate action prevention. The
[validation report](SANDBOX_VALIDATION.md) separates observed sandbox execution,
independent output grading, derived negative cases and dashboard evidence review.
