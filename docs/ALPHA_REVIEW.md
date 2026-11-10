# First-use alpha review

Use fictional records only. The viewer needs no API key or account. A reviewer
does not need to run a live model to inspect examples or a saved completed export.

## Generate the private rehearsal kit

From a fresh checkout with Node 22+ and Python 3.11+:

```sh
node scripts/alpha-rehearsal.mjs
```

The command creates `output/private-alpha-rehearsal/`. Use `--output NEW_DIRECTORY`
to generate a second copy. Send only the `reviewer` folder to reviewers with private
access to the checkout. It contains six ready-to-import packages and the task sheet.
Keep the answer key in the separate `facilitator` folder. The kit uses fixed
fictional records and the offline checker, so it can be regenerated without prior
runs, credentials, Docker or provider calls.

- [Reviewer task sheet](alpha-rehearsal/TASK_SHEET.md)
- [Facilitator answer key](alpha-rehearsal/ANSWER_KEY.md)

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
