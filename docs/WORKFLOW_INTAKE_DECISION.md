# Second workflow and import recovery

The proposed second workflow has two people or agents to review. One edits a file under a delegated grant. Another independently runs a check under its own grant and reports an outcome. The reviewer needs to establish which grant covered each completed action at its recorded time. A successful test by itself describes an outcome.

| Required evidence | What the existing public fixture supplies | Still needed from a second source |
| --- | --- | --- |
| Completed action, actor, resource and time | The quickstart action ledger identifies the coordinator read and editor’s completed read/write. | A separately recorded verification action, its actor, target and completion time. |
| Authority for each actor | The grants ledger records issuer, subject, scope, validity and parent authority. The missing-grant variant preserves the unresolved reference. | A verifier grant with stable linkage to its action and upstream authority. |
| Attempt and result | Attempt records reference tool calls. Before/after receipts and an unsigned manifest bind supplied file bytes. | An independent result receipt for the verifier, with a link to the completed check. A requested or rejected check must remain distinguishable. |
| Repeat review need | The fictional fixture and reviewer worksheet exercise one bounded coding workflow. | A permissioned representative export and an observed recurring decision using the reviewer’s usual process. |

**First implementation.** The quickstart supported the local import recovery exercise below. A later permissioned pilot captured an edit in a disposable repository and a separately granted verifier running a precommitted test suite against the edited revision. That capture supplies the input format for the bounded offline importer. Its applicability to an independently operated, recurring workflow remains open.

## Inspect an edit-and-test capture

1. Extract the capture ZIP locally. In **Investigate a run**, expand **Inspect an edit-and-test folder** and choose the inner directory containing `setup.json` and `SHA256SUMS`.
2. Read the editor and verifier grants separately. Compare the issuer, subject, parent, exact action and resource, and validity with each recorded action.
3. Inspect the test receipt. Check the tested revision, recorded exit code and the expected and computed hashes of the receipt and its output. A passed process can still have missing authority or damaged evidence.

From the source checkout, run the same inspection with Node 22 or later. Replace the example path with the extracted capture directory.

```sh
node scripts/validate-capture.mjs --edit-test-folder ./capture --json
```

| Capture | Expected finding |
| --- | --- |
| Both grants, completed test and intact evidence | The edit and test verify against the supplied records. |
| Missing verifier grant | The verifier’s authority is unverifiable even when the receipt checks out. |
| Altered test receipt | Its bytes differ from the digest saved on the completed test action. |
| Altered output | The computed output digest differs from the digest recorded in the receipt. |
| Test attempt without a completion | The attempt supplies no completed verification, even when an old receipt is present. |

The command exits with 0 for a verified run, 1 for a run with outstanding findings, and 2 for invalid input. The capture is unsigned. The importer compares recorded Git identifiers and file digests, reads the selected local evidence, and leaves the original files untouched. Inspecting the original Git objects and rerunning the suite are separate steps.

## Try recovery

1. In **Regression inbox**, open **Preview a Codex case before importing**. Choose a receipt-inclusive fictional case from the [handoff kit](CODEX_HANDOFF.md). Inspect the workflow, required baseline fingerprint, current receiver pin, retained filenames, sender event count and resulting case state.
2. **Cancel preview** leaves the inbox untouched. **Import this case** rechecks the previewed bytes, pin and available space before saving. A conflicting pin keeps the case open. The preview also reports altered evidence, so a reviewer can choose whether to retain a flagged case.
3. Preview the same file again to identify the existing case. For a malformed or oversized file, choose a supported export. If the inbox is full, back up a case you want to keep before choosing whether to remove one. Existing pins, notes, decisions and case contents are preserved on failure.
