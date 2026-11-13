# First-use alpha review

Use fictional records only. The viewer and rehearsal kit run locally without an
API key, account, Docker, or model calls.

## Import a resolved case

1. Download **Source code (zip)** from the
   [v0.1.0-alpha.3 release](https://github.com/zrack/agent_delegation_control_plane/releases/tag/v0.1.0-alpha.3).
   Extract it and the [complete review case demo ZIP](https://github.com/zrack/agent_delegation_control_plane/releases/download/v0.1.0-alpha.3/adcp-review-case-demo-v0.1.0-alpha.3.zip)
   into separate directories.
2. From the extracted source directory, run `python3 scripts/serve.py` with
   Python 3.11 or newer. Open the printed loopback address in a fresh browser
   profile.
3. In **Regression inbox**, select **Import review package or case** and open
   `resolved-case.json` from the demo ZIP.
4. Check the **Fix required** decision and its reason, “Export exceeds the parent
   grant.” The original run should show **Rechecked · Regression detected** and
   the follow-up **Rechecked · No regression found**. Open **Inspect follow-up
   evidence** to see the recheck against the original baseline.
5. Reload at the same address and confirm the decision, reason, and **Resolved**
   status persist.

## Review and export the case yourself

1. Open the dashboard in another fresh browser profile. In **Regression inbox**,
   select **Import review package or case** and open `case-02.json` from the demo ZIP.
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
