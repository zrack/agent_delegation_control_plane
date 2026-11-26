# Second workflow and import recovery

The proposed second workflow has two people or agents to review. One edits a file under a delegated grant. Another independently runs a check under its own grant and reports an outcome. The reviewer needs to establish which grant covered each completed action at its recorded time. A successful test by itself describes an outcome.

| Required evidence | What the existing public fixture supplies | Still needed from a second source |
| --- | --- | --- |
| Completed action, actor, resource and time | The quickstart action ledger identifies the coordinator read and editor’s completed read/write. | A separately recorded verification action, its actor, target and completion time. |
| Authority for each actor | The grants ledger records issuer, subject, scope, validity and parent authority. The missing-grant variant preserves the unresolved reference. | A verifier grant with stable linkage to its action and upstream authority. |
| Attempt and result | Attempt records reference tool calls. Before/after receipts and an unsigned manifest bind supplied file bytes. | An independent result receipt for the verifier, with a link to the completed check. A requested or rejected check must remain distinguishable. |
| Repeat review need | The fictional fixture and reviewer worksheet exercise one bounded coding workflow. | A permissioned representative export and an observed recurring decision using the reviewer’s usual process. |

**Decision for this development cycle.** Implement local import recovery. The available example and worksheet establish a reproducible review exercise. A second qualifying source and independent human comparison are still pending. A future adapter can use the field map above when a reviewer brings a recurring workflow and permission to inspect its records. Real records stay with their owner.

## Try recovery

1. In **Regression inbox**, open **Preview a Codex case before importing**. Choose a receipt-inclusive fictional case from the [handoff kit](CODEX_HANDOFF.md). Inspect the workflow, required baseline fingerprint, current receiver pin, retained filenames, sender event count and resulting case state.
2. **Cancel preview** leaves the inbox untouched. **Import this case** rechecks the file, pin and available space before saving. A conflicting pin keeps the case open. The preview also reports altered evidence, so a reviewer can choose whether to retain a flagged case.
3. Preview the same file again to identify the existing case. For a malformed or oversized file, choose a supported export. If the inbox is full, back up a case you want to keep before choosing whether to remove one. Existing pins, notes, decisions and case contents are preserved on failure.
