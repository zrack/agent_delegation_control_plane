# Observe a reviewer

Use the matching source checkout with Node 22+ and Python 3.11+. Keep observations in a private working directory. The participant receives only their assigned reviewer folder. Keep this facilitator folder, the original labelled kit and the scorer's output separate until they finish.

1. Assign schedule A to the first reviewer and schedule B to the second. Allocate schedules before seeing results. Each person sees the seven scenarios once. Each scenario occupies the same position under opposite methods for the two schedules. These are variants of one coding task, so familiarity can carry across rounds.
2. Keep an unedited copy of each blank `sheet-A.json` or `sheet-B.json`. Give each observer their own copy of the assigned sheet. The `source` starts as `unassigned`. Choose `independent-human` only for a witnessed independent human session, `maintainer-rehearsal` for maintainer practice, or `automated-rehearsal` for a scripted walkthrough. The sheet records the observer's declaration. Preserve anonymous private field notes with the actual evidence cited and requests for help.
3. Time each round separately. Setup covers opening the assigned tools and configuring the receiver. Start the decision timer when the reviewer first examines the case. For `answered`, stop when the reviewer submits the disposition and finishes their explanation. For `abandoned`, stop when they give up or the session ends. A stopwatch that ends before evidence is cited cannot establish time to a supported decision. Leave untouched rounds as `unrun`. Record elapsed times in whole seconds.
4. Use `assignments.json` to map each task number to its handoff ID and `handoffKeyRow`. That row in `HANDOFF_KEY.md` gives the field-level evidence. The key and task sheet use different row orders. Score each citation from the reviewer's explanation. Withhold the key and feedback until the session ends.

| Observation field | What to record |
| --- | --- |
| `disposition`, `reason` | Map the answer to `resolved`, `open-blocked`, `open-ready` or `unsure`. Use the reason code from the assignments that matches what the reviewer said. Use `other` when no listed reason describes it. Abandoned trials leave the answer fields null. |
| `citations.action` | Did the participant identify the original editor and its write to the fictional quickstart? |
| `citations.grant` | Did they identify the original missing edit grant and its corrected follow-up reference for that action and resource? |
| `citations.receipt` | Did they cite the relevant file, stage and digest comparison, and connect them to the case-specific blocker or verified result? For a pin or closure-record question, this includes checking that record independently. |
| `citations.history` | Did they correctly attribute the supplied history to the sender, or identify that it was omitted, and explain the empty local receiver history? |
| `assisted`, `friction` | Record whether they needed help. Use zero or more of `setup`, `locate-action`, `trace-grant`, `check-pin`, `verify-receipt`, `attribute-history`, `interpret-closure`, `other`. Keep the participant's own explanation privately. |
| `incorrectClosures` | Count observed incorrect closure actions. A spoken claim that an open case is resolved is counted separately by the scorer. Record the actions even if the reviewer later corrects the explanation or abandons the task. |

For answered trials, mark every citation `true` or `false`. Empty sessions report no observed closure count. A supported decision needs the expected disposition, expected reason and all four cited evidence checks. Keep assistance visible alongside the individual time. An unsupported answer or abandoned task retains its elapsed time and contributes no time to a correct decision. The scorer never pools human observations with rehearsals.

Use the original observation template for the assigned schedule. Its digest binds the case bytes, receiver records, task order, method assignments and scoring guidance. Editing the schedule or using a different protocol requires a fresh template. This consistency check cannot authenticate an observer or participant.

From the source checkout, run `python3 scripts/reviewer_pilot.py score PATH_TO_OBSERVATION_SHEET.json`. Redirect the JSON output to a new private file if needed. Report results per person, scenario and method, including every unrun, unsupported and abandoned trial. A single schedule cannot distinguish a method effect from differences among cases. Two schedules allow comparison of like scenarios across reviewers, with setup, assistance and order visible. Repeat use or demand for a new source needs separate observation on a permissioned workflow.
