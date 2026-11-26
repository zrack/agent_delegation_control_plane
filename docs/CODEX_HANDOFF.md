# Review a fictional Codex handoff

Download the [alpha.16 handoff ZIP](https://github.com/zrack/agent_delegation_control_plane/releases/download/v0.1.0-alpha.16/adcp-codex-handoff-demo-v0.1.0-alpha.16.zip) and **Source code (zip)** from the [alpha.16 release](https://github.com/zrack/agent_delegation_control_plane/releases/tag/v0.1.0-alpha.16). The [alpha guide](ALPHA_REVIEW.md#review-a-codex-handoff) walks through the first import.

To rebuild the same fictional kit from the tagged source, use Node 22+ and Python 3.11+.

```sh
python3 scripts/build_codex_handoff.py --output output/handoff
```

Open **`adcp-codex-handoff-demo/reviewer/TASK_SHEET.md` first** inside the output folder or extracted ZIP. It names the case to import and the receiver baseline to pin. Give each reviewer their own fresh browser profile at the same local dashboard address. The facilitator uses `facilitator/ANSWER_KEY.md` and `facilitator/outcomes.json` to score the exercise after the reviewer records a decision.

In the inbox, read **Sender-reported history** and **Local repair history** separately. When the sender panel has no events, the available history leaves the sender’s repair unknown. A receiver can still verify a recorded closure from the receipts, follow-up and matching pin.

In the tagged alpha.16 dashboard, choose **Inspect original output receipt · after.md** or **Inspect follow-up output receipt · after.md**. Focus moves to the selected run’s saved file and its SHA-256. Reload reopens that receipt after the evidence passes its checks again.

### Inspect an altered receipt

Run the dashboard from current `main` and use the alpha.16 handoff ZIP. In a fresh profile, pin `pins/matching` for `Follow-up review`, import one of the cases below, then reload. Read the original and follow-up evidence in the inbox. **Sender-reported action and grant** identifies the editor, write target and referenced grant in the supplied investigation. **Receiver checks** shows which file failed, the manifest’s expected SHA-256 and the SHA-256 computed from the saved bytes.

Choose **Go to original receipt for after.md** or **Go to follow-up receipt for after.md** on the run whose output verified. The button opens the saved text and its SHA-256 in the case. Reload to return to that same receipt. The other run’s failed check still blocks closure.

| Case | What to look for | Why the case stays open |
| --- | --- | --- |
| `cases/altered-original.json` | The editor reported writing `docs/quickstart.md`. The original investigation references the edit grant but omits its record. The original `after.md` digest differs from the manifest. | The receiver cannot reproduce the original finding from intact receipts, even though the follow-up passes. |
| `cases/altered-follow-up.json` | The follow-up supplies the previously missing coordinator-to-editor grant for the quickstart edit. Its `after.md` fails the digest check. | The receiver can see what the sender says was corrected. Verifying that correction for closure requires a passing follow-up with intact receipts. |

In the altered-follow-up case, expand the original run’s **Missing grant** finding. The editor’s read and write both reference the same missing grant. Each action has its own link to the baseline and candidate evidence.

Use another fresh profile for the second case. The two files share a case ID. The sender’s history can explain an earlier repair or close action. The receiver checks the evidence again after reload.

## Verify the case offline

Point the command to the case received from the sender. Supply the independently selected receiver baseline and the workflow it belongs to. The commands below use the source-build location. For a downloaded kit, set `kit` to the extracted `adcp-codex-handoff-demo` directory.

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

The same command handles [portable invoice cases](INVOICE_VERIFICATION.md), including their three independent receipt checks and their own rules for verifying an existing closure without a receiver pin.

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

## Compare ordinary review with the dashboard

Prepare two reviewer folders with neutral task names and a separate facilitator key. The two schedules cover all seven frozen handoffs once per reviewer and reverse which method handles each task. The observer records setup and decision time, evidence cited, help, incorrect closures and abandoned rounds. A blank sheet reports all seven tasks as unrun. Preparing these files leaves human outcomes unmeasured. [Facilitator guide](reviewer-pilot/FACILITATOR.md)

```sh
python3 scripts/reviewer_pilot.py prepare --output output/reviewer-pilot
python3 scripts/reviewer_pilot.py score output/reviewer-pilot/facilitator/sheet-A.json
```
