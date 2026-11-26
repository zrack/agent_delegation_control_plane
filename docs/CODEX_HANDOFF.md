# Review a fictional Codex handoff

The handoff kit is built from this source checkout. Use Node 22+ and Python 3.11+. The published alpha.15 release remains available for the earlier repair-history exercise.

```sh
python3 scripts/build_codex_handoff.py --output output/handoff
```

Open **`adcp-codex-handoff-demo/reviewer/TASK_SHEET.md` first** inside the output folder or extracted ZIP. It names the case to import and the receiver baseline to pin. Give each reviewer their own fresh browser profile at the same local dashboard address. The facilitator uses `facilitator/ANSWER_KEY.md` and `facilitator/outcomes.json` to score the exercise after the reviewer records a decision.

## Verify the case offline

Point the command to the case received from the sender. Supply the independently selected receiver baseline and the workflow it belongs to. The files stay on disk unchanged.

```sh
kit=output/handoff/adcp-codex-handoff-demo
node scripts/verify-case.mjs --case "$kit/cases/history-on.json" \
  --workflow 'Follow-up review' --baseline-dir "$kit/receiver-baselines/matching"
```

Omit both receiver options to check what an unpinned reviewer sees. The `conflicting` baseline exercises the receiver who has a different pin under the same workflow name. A caller that supplies an invalid or tampered baseline gets an input error. The command never adopts a packaged pin.

| Exit | Disposition | Meaning |
| --- | --- | --- |
| 0 | `resolved` | The original, follow-up, recorded closure and receiver pin verify together. |
| 1 | `open-ready` or `open-blocked` | A valid case still needs an explicit closure or has an outstanding evidence or pin check. |
| 2 | No disposition | The files, format, arguments or receiver baseline could not be verified. |

### CI example

From a clean checkout with the kit built as above, run the following step in a shell. The resolved case exits successfully only when its closure verifies. Use the exit table above when deliberately checking an open scenario.

```sh
kit=output/handoff/adcp-codex-handoff-demo
node scripts/verify-case.mjs --json --case "$kit/cases/history-off.json" \
  --workflow 'Follow-up review' --baseline-dir "$kit/receiver-baselines/matching"
```

Version 1 JSON contains input validity, disposition, reason codes, the receiver pin status and independently recomputed original and follow-up comparisons. Relevant checks can name a receipt or grant. Receipt bodies, notes and sender history are excluded. A resolved case can still have a flagged original comparison. Resolution describes the verified follow-up and explicit closure. A SHA-256 match checks supplied bytes. It cannot identify the person who produced them.

## Independent receiver exercise

A separate agent reviewer used only the fictional reviewer packet and the dashboard in two fresh Chromium profiles. After reload, the matching receiver verified the recorded closure. The unpinned receiver identified the missing workflow pin and kept the case open. Both found the corrected editor grant, distinguished the sender’s repair from their empty local history, and checked the replacement digest against the saved output receipt. There were zero incorrect closures in two observations. The prior digest came from the sender. Human review time and repeat use remain unmeasured.
