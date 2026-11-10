# First-use alpha review

Use fictional records only. The viewer and rehearsal kit run locally without an
API key, account, Docker, or model calls.

## Start from the public release

Download **Source code (zip)** from the
[v0.1.0-alpha.1 release](https://github.com/zrack/agent_delegation_control_plane/releases/tag/v0.1.0-alpha.1)
and extract it. From the extracted directory, with Python 3.11+ and Node 22+,
generate the fictional packages and start the dashboard:

```sh
node scripts/alpha-rehearsal.mjs
python3 scripts/serve.py
```

Open the loopback address printed by the server. The kit writes six importable
packages and a task sheet to `output/private-alpha-rehearsal/reviewer/`. To generate
another copy, run the kit command with `--output NEW_DIRECTORY`. For a facilitated
review, give reviewers the `reviewer` folder and keep the answer key in the
separate `facilitator` folder until they finish.

## Try one review

1. In **Regression inbox**, choose **Import review package** and open
   `reviewer/case-02.json` from the generated kit.
2. Open the evidence behind the unexpected export. Record who acted for whom,
   which action and resource were involved, and which grant explains the finding.
3. Choose a **Decision**, enter your reason, and select **Save decision**.
   Use **Attach follow-up package** to open `reviewer/follow-up-02.json`.
   Check the baseline and evidence, then decide whether to **Close as resolved**.

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
