# Roadmap

**Next 160 development hours · November 25, 2026**

Build toward one practical outcome. When a reviewer receives a portable Codex case, they can find the grant behind an action, explain what the sender repaired, and independently decide whether closure holds. A teammate or a CI job with the same evidence and baseline should be able to reproduce that decision offline.

| Development hours | What becomes possible | Work |
| --- | --- | --- |
| 1–20 | Someone with a clean checkout can rehearse both sides of a case handoff from one tested ZIP. | [A · Handoff kit](#a-handoff-kit) |
| 21–44 | Every proposed change can run the two-reviewer exercise in real, isolated browsers. | [B · Browser acceptance tests](#b-browser-acceptance-tests) |
| 45–70 | A reviewer can go from a flagged action to its supporting grant and parent chain without opening raw JSON. | [C · Grant lookup](#c-grant-lookup) |
| 71–100 | A reviewer or CI job can independently verify a portable case from the command line. | [D · Offline case verification](#d-offline-case-verification) |
| 101–130 | A producer can diagnose a bad record, and a reviewer can find which saved cases need attention. | [E · Producer diagnostics and inbox triage](#e-producer-diagnostics-and-inbox-triage) |
| 131–160 | One additional permissioned workflow has an offline intake path, or the current workflow has a tested recovery path if the source does not qualify. | [F · Second workflow or recovery](#f-second-workflow-or-recovery) |

These are estimates for one developer, including implementation, tests, integration and documentation. The ranges indicate proposed build order. The **Needs** column identifies work that can start earlier. Time waiting for a release decision or a reviewer is outside the 160 hours. Each checkpoint produces something usable on its own.

## Delivery status in this checkout

| Block | Implementation and verification |
| --- | --- |
| A1–A4 | The [handoff kit](docs/CODEX_HANDOFF.md) builds a local alpha.16 candidate ZIP. It contains [seven expected outcomes](docs/codex-handoff/facilitator/outcomes.json), independent receiver pins, a [reviewer task sheet](docs/codex-handoff/reviewer/TASK_SHEET.md) and a [separate key](docs/codex-handoff/facilitator/ANSWER_KEY.md). Published download pointers still lead to alpha.15. |
| B1–B4 | The [Chromium suite](tests/browser/README.md) builds and extracts the ZIP, exercises isolated sender and receiver profiles and checks the outcome after reload. The same suite is configured to run on pull requests. |
| C1–C4 | [Grant lookup exercises](docs/alpha-rehearsal/GRANT_TASKS.md) cover same-ID grants from different runs, missing references and parent authority. The original reviewer worksheet can be completed inside the dashboard. |
| D1–D5 | The [offline verifier](docs/CODEX_HANDOFF.md#verify-the-case-offline) uses the case assessment and a separately supplied receiver pin. Its output distinguishes a verified resolution, a ready case, a blocked case and an invalid input. |
| E1–E5 | A [producer walkthrough](docs/producer/README.md) exercises structural, authority and receipt checks. The inbox filters by workflow, decision and verified closure. The mixed-inbox exercise checks changes to the pin while preserving saved decisions and notes. |
| F1–F5 | The [source assessment and recovery exercise](docs/WORKFLOW_INTAKE_DECISION.md) records why this cycle implements preview and recovery. A permissioned second source, independent human timings and repeat-use evidence are still open. |

## Coding-agent review

**First exercise in the published alpha.** Download the alpha.15 fictional demo ZIP. Pin `pins/complete-capture` as `Follow-up review`, then import `cases/altered-original-receipt.json`. The case opens with a failed `after.md` receipt and empty local history. [Demo ZIP](https://github.com/zrack/agent_delegation_control_plane/releases/download/v0.1.0-alpha.15/adcp-codex-repair-history-demo-v0.1.0-alpha.15.zip) · [Walkthrough](docs/ALPHA_REVIEW.md#repair-an-original-codex-receipt)

1. Apply the repair from `donors/matching-case.json` and reload. The case is **Open** and **Ready to close**. Its **Original receipts repaired** entry records the change below.
2. Inspect the corrected editor grant, select **Close as resolved**, then reload. The case is **Resolved**. The **Case explicitly closed** entry identifies the pinned baseline and passing follow-up.
3. Select **Include Codex receipts in case download** and download the review case. In a fresh profile, pin the same baseline and import the download. The receiver can verify **Resolved** with empty local history. [Alpha.15 release](https://github.com/zrack/agent_delegation_control_plane/releases/tag/v0.1.0-alpha.15) · [Closure checklist validation](docs/CODEX_CLOSURE_CHECKLIST_VALIDATION.md)

| Fictional `after.md` receipt | SHA-256 |
| --- | --- |
| Before repair | `0bec606c5209cbec36ec263c8f4bc261c440ef822af50e09db4a1351efae2f4f` |
| After repair | `700c9aed0a7eecf416c7d2034a93efa959a0a87da4eb1197501127bb048684fa` |

**Where development starts.** Public main adds opt-in sender repair history to receipt-inclusive portable Codex cases. This change is merged and awaits a release. A recipient can read the sender’s account of a repair and still has to verify closure against their own pin and the supplied receipts. The existing offline command pins and compares normalized runs. The proposed command in D checks a *saved case*, including the original, follow-up and closure record. The invoice workflow already has a folder importer and receipt follow-ups. [Sender-history change](https://github.com/zrack/agent_delegation_control_plane/pull/50) · [Offline regression command](scripts/regression.mjs) · [Architecture](ARCHITECTURE.md) · [Invoice validation](docs/SANDBOX_VALIDATION.md)

## Development backlog

### A. Handoff kit

**20 hours. Start with A1 and A2 in the first eight.** Use the same fictional cases as examples for people, inputs for the browser tests and fixtures for the offline verifier. That gives each later change a common definition of a correct outcome.

| ID | Hours | Needs | Deliverable and acceptance |
| --- | ---: | --- | --- |
| A1 | 4 | — | Write the expected outcome for history on/off, matching/missing/conflicting pin, altered original/follow-up receipts, and passing follow-up left open. For each, specify the reason, disposition, sender history and receiver-local history. |
| A2 | 4 | A1 | Assemble the fictional case pair, separate receiver pins, damaged variants and corrected donor. Give the reviewer a task sheet and keep the expected answers in a separate key. Someone can identify exactly which file to open first. |
| A3 | 7 | A2 | Generate a versioned ZIP and file-digest manifest from a clean checkout. Two builds of the same revision produce identical bytes. Extract it outside the checkout and complete one sender-to-receiver round trip. |
| A4 | 5 | A3 | Prepare a release candidate for the merged change. Reconcile the README, alpha guide, changelog and release-readiness pointers. Verify that the candidate asset, walkthrough and source revision agree. Update published download links when the release exists. |

### B. Browser acceptance tests

**24 hours.** The current checks cover evaluation, storage, command-line regression and the local server. A real browser test can also catch a broken download, an import into the wrong profile, or a button that closes a case early. [Current project checks](scripts/check.py) · [CI workflow](.github/workflows/project-integrity.yml)

| ID | Hours | Needs | Deliverable and acceptance |
| --- | ---: | --- | --- |
| B1 | 4 | A2 | Start the dashboard on loopback in a test harness. Create isolated sender and receiver profiles. A marker saved by one is absent in the other, and the exercise works without external requests. |
| B2 | 7 | A3, B1 | Drive repair, explicit close, download and reimport through the visible controls. Run with sharing on and off. After reload, a matched receiver sees the expected disposition, correctly attributed sender history when shared, and empty local history. |
| B3 | 7 | B2 | Run the remaining A1 cases. Also cancel a preview, reject a mismatched donor and re-export an imported case. Verify that these operations preserve the pin and decision and never produce a new local repair or forward imported events as the receiver’s own. |
| B4 | 6 | B3 | Run the browser suite on pull requests alongside the existing checks. A failure identifies the scenario, expected result and observed result. Exercise this with a known failing fixture. Retain only diagnostics generated from fictional inputs. |

### C. Grant lookup

**26 hours.** The current worksheet asks a reviewer to search package JSON when an action’s grant is absent from the differences. Address that specific obstacle before expanding intake. The reviewer’s question is “Which grant covered this action at the time, and who could delegate it?” [Reviewer task sheet](docs/alpha-rehearsal/TASK_SHEET.md) · [Evaluator](src/evaluator.mjs) · [Inbox view](src/review-view.mjs)

| ID | Hours | Needs | Deliverable and acceptance |
| --- | ---: | --- | --- |
| C1 | 5 | — | Freeze three fictional examples and an answer key for an unchanged supporting grant, a missing grant, and a delegated grant with a parent. Include identical grant IDs in baseline and candidate so a wrong-run lookup is detectable. |
| C2 | 8 | C1 | Link a finding or action to the exact grant in the selected run. Show issuer, subject, covered action/resource and validity alongside the observed action time. Baseline and candidate links open the intended record even when IDs match. |
| C3 | 7 | C2 | Let the reviewer follow parent grants to the root and return to the same action. Show the unresolved ID or evaluator finding for missing, ambiguous or cyclic ancestry. Cover keyboard navigation and reload into the selected case. |
| C4 | 6 | B1, C3 | Run the worksheet entirely in the dashboard, including the missing-grant case. Add the path to browser tests and update the worksheet. Prepare equivalent cases for a blind comparison with ordinary review. Record any steps still requiring raw JSON. |

### D. Offline case verification

**30 hours. Hour 100 is the first major delivery target.** A teammate should be able to check a portable Codex case with one read-only command and an independently supplied receiver baseline. A passing follow-up can leave a case ready for a person to close. Missing authority can also keep a case open. A script consuming the result needs to tell those situations apart. [Current case verification](src/review.mjs) · [Portable case validation](docs/CODEX_PORTABLE_CASE_VALIDATION.md)

| ID | Hours | Needs | Deliverable and acceptance |
| --- | ---: | --- | --- |
| D1 | 6 | A1 | Specify a proposed `verify-case` command and versioned output. Separate input validity, original/follow-up checks, verified case disposition and reason codes. Cover resolved, open and ready to close, open with blockers, and unreadable or invalid input. |
| D2 | 6 | D1 | Reuse the browser’s case assessment in the command. Accept an explicit receiver baseline with its fingerprint, cover absence and mismatch, and keep inputs read-only. A pin included by the sender cannot satisfy the receiver-pin check. |
| D3 | 6 | D2 | Add human-readable and JSON output with documented exit behavior. Identify the failing check and relevant receipt or grant reference. Keep raw receipt contents and review notes out of default output. A scripted caller can distinguish an open case from a command error. |
| D4 | 7 | B3, D3 | Run the A1 matrix through both interfaces and compare dispositions and reasons. A valid alpha.15 package still imports, and an unsupported format yields an input error. A sender-history claim alone, a closure record inconsistent with its follow-up, or receipt bytes that differ from the recorded digest cannot establish closure. |
| D5 | 5 | D4 | Document one local invocation and one CI example using only fictional files. Run both from a clean checkout. The same package and receiver pin give the same JSON result on repeated runs and leave the case, pin and receiver history unchanged. |

### E. Producer diagnostics and inbox triage

**30 hours.** Reduce the time between “I have a record” and “I know what needs review.” Keep intake diagnostics usable by a workflow owner and case status usable by a reviewer returning to a full inbox. [Investigation import](src/import.mjs) · [Codex folder import](src/codex-import.mjs) · [Local storage](src/storage.mjs)

| ID | Hours | Needs | Deliverable and acceptance |
| --- | ---: | --- | --- |
| E1 | 5 | C1 | Provide the smallest useful producer example using the existing investigation format, plus a field map for actor, action, resource, time, grant and evidence. A producer can trace each example field to a recorded source. |
| E2 | 7 | E1 | Add offline validation for an investigation file and the supported Codex folder. Distinguish malformed input, a structurally valid run missing a referenced grant, and a receipt mismatch. Identify the file and field or expected receipt without printing its contents. |
| E3 | 6 | E2 | Add a producer walkthrough and negative fixtures. A first-time user can correct a malformed record, find the missing reference, and rerun the check. Absent grant evidence continues to produce an unverifiable authority result. |
| E4 | 6 | D2 | Filter the saved inbox by workflow, review decision and verified closure. Surface the first blocker or “ready to close” on each applicable card. Two cases with the same original verdict but different closure states appear in the correct filters. |
| E5 | 6 | B1, E4 | Exercise a mixed inbox at the supported case limit. Change a receiver pin, reopen a filtered case and reload. The affected card loses verified closure, the filter and selection remain usable, and notes and decisions survive. |

### F. Second workflow or recovery

**30 hours. Choose one implementation at F2.** The first candidate is a delegated code edit followed by an independent test or verification step. This tests whether the product can explain a second actor’s authority beyond the current fixed Codex quickstart. A recurring workflow proposed by a reviewer can take its place if better records are available. [Current Codex intake](src/codex-import.mjs) · [Integration example](integrations/openai-agents/README.md)

| ID | Hours | Needs | Deliverable and acceptance |
| --- | ---: | --- | --- |
| F1 | 4 | E1 | Make a source inventory and review-task description. For a permissioned sample, map completed action, actor, resource, time, outcome, grant issuer/scope/validity and parent linkage to actual records. Document missing fields. Save only a fictional counterpart for public tests. |
| F2 | 6 | C4, F1 | Compare the current review method and ADCP using the rubric below if a reviewer is available. Write the decision on adapter vs recovery, naming the recurring task, source coverage and open questions. If no reviewer or suitable record is available, choose recovery and record the missing evidence. |
| F3 | 8 | E2, F2 | **Adapter path:** translate one bounded source format into existing investigation and receipt structures. Preserve attempts and completed actions distinctly. **Recovery path:** add a pre-import inspection of a portable Codex case showing included receipts, optional sender history and the receiver pin it will need. |
| F4 | 7 | F3 | **Adapter:** replay a complete sample, a referenced but missing grant, and output whose bytes were changed after its digest was recorded. Expected results are a verifiable action, unverifiable authority and failed evidence respectively. **Recovery:** exercise malformed, duplicate and over-limit imports. Show a recovery step and preserve existing cases, notes, decisions and pins on failure. |
| F5 | 5 | D5, E5, F4 | Repeat the chosen path from a clean checkout. Recheck compatibility with the published fictional examples, document supported inputs and limits, and record whether another person could reproduce the result or that observation is still pending. |

## Next evidence gates

| When | Decision and evidence |
| --- | --- |
| Hour 20 | A maintainer can hand over the extracted fictional ZIP and its task sheet. The receiver can begin without access to the sender’s profile. Keep release-candidate results distinct from published assets. |
| Hour 44 | The browser reproduces the expected outcomes in isolated profiles. Any incorrectly verified closure blocks promotion of that candidate. |
| Hour 70 | Attempt the worksheet from a flagged action to the relevant grant entirely in the UI. Record wrong-run lookups, missing references and requests for help. Use reproducible failures to choose fixes. |
| Hour 100 | A second profile and the offline command agree across the case matrix, including cases still open after a passing follow-up. A receiver can point to the relevant grant or precisely identify the missing one. Treat automated agreement and observed human decisions as separate results. |
| Hours 130–160 | Choose one new source only when a reviewer has a recurring decision to make and representative, permissioned records can support it. Where the source omits authority, document the gap. Use the recovery path if the sample, need or permission is missing. |

**How to measure reviewer value.** Use equivalent frozen cases with known answers. Compare ordinary trace or pull-request review against ADCP, alternating the order across reviewers when available. Time setup separately. Stop the decision timer when the reviewer gives the correct disposition **and** cites the action, grant or missing reference, and relevant receipt. For a repaired case, also ask who made the repair and which evidence supports closure. Record incorrect closures, assistance, abandoned attempts and case counts alongside the times. Report individual results for small samples. A clean-profile rehearsal tests the workflow; human review time and repeat use require observed reviewers. [Existing timing method and limitations](docs/CODEX_CANDIDATE_VALIDATION.md)

**How to keep moving.** A release wait leaves B1 and C1 ready. A delay finding reviewers leaves the fictional browser suite, lookup, verifier, producer diagnostics and inbox work available. At each checkpoint, fix a reproducible incorrect closure before promoting the affected feature. If a work item overruns, move the lowest-priority unstarted item to the next block and record the revised estimate.

## Ranked backlog after hour 160

The first 160 hours describe the original delivery plan. The estimates below cover the follow-on work. The first four follow-on tools run in a source checkout. The fifth is an isolated research prototype.

| Priority | Result in this checkout | Original estimate | What to try or verify |
| --- | --- | ---: | --- |
| 1 | Offline verification for receipt-inclusive invoice cases | 12–18 h | Run the four released invoice examples. Two recorded closures verify with their packaged baseline. Altered output or a conflicting baseline keeps the case open. Inspect authority, output and execution separately. [Invoice exercise](docs/INVOICE_VERIFICATION.md) |
| 2 | Copyable pull-request summary | 8–12 h | Preview the disposition, grant reference, digests and next action. Change the receiver pin before copying and review the refreshed result. [Summary privacy](docs/PRIVACY.md#sharing-a-pr-summary) |
| 3 | Selective local backup and restore | 16–24 h | Choose cases and optional evidence, preview the effects of accepting a pin, and restore into a fresh profile. Conflicting pins and existing decisions are preserved. [Backup walkthrough](docs/INBOX_BACKUP.md) |
| 4 | Compatibility check for the repository’s account-review producer | 18–30 h | Validate the output of the Coordinator → Researcher → Reporter workflow against its manifest, tool records and investigation. Run the deterministic producer replay and rejection tests offline. An independently operated workflow still needs a permissioned sample. [Producer guide](docs/producer/README.md) · [Source selection criteria](docs/WORKFLOW_INTAKE_DECISION.md) |
| 5 | Offline evidence signature experiment | 16–24 h | Verify exact case bytes against an independently selected producer key. Try a revoked key and a signed case with an altered receipt. The receipt still blocks closure. [Experiment and trust assumptions](experiments/receipt-provenance/README.md) |

**Next evidence to collect.** Give a reviewer the separate task sheet and receiver pin. Record whether they reach the correct decision, what evidence they cite, how long it takes and where they need help. Use that comparison to choose the next workflow. A production signing pilot also needs a named key owner and a way for offline receivers to obtain fresh, authenticated key status. [Handoff kit](docs/CODEX_HANDOFF.md) · [Measurement method](#next-evidence-gates)

The product in this plan performs local, retrospective review. Shared accounts and hosted case storage need evidence of repeated collaboration friction and a design for who can read which records. Runtime authorization and revocation need a separate enforcement design and failure model. Those decisions belong to a later roadmap.
