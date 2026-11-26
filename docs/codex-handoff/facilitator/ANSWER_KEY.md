# Facilitator answer key

Give the reviewer the task sheet. Score each initial decision after reload, before adopting a baseline, correcting evidence or closing anything. Each row assumes a fresh receiver profile. The human-readable answers below correspond to `outcomes.json`.

| Row | Expected after reload | Why | Sender-reported events | Local events |
| --- | --- | --- | --- | --- |
| 1 | **Resolved** | Original and corrected receipts verify. The saved closure binds the decision to this original and passing follow-up. The receiver has the exact matching pin. | Repair, closure | None |
| 2 | **Resolved** | The same independent checks pass with sender history omitted. The export does not document the earlier repair digest. | None | None |
| 3 | **Open** | The receiver has no pin for this workflow. Recorded sender closure and an included baseline do not create a receiver pin. | Repair, closure | None |
| 4 | **Open** | A different valid run is already pinned as `Follow-up review`. The conflicting local pin survives import and reload. | Repair, closure | None |
| 5 | **Open** | In original evidence, `after.md` bytes differ from the recorded digest. The sender’s prior closure does not verify here. | Repair, closure | None |
| 6 | **Open** | Original evidence checks out. In follow-up evidence, `after.md` bytes differ from the recorded digest, so the follow-up cannot verify. | Repair, closure | None |
| 7 | **Open**, **Ready to close** | The corrected run passes against the matching pin. The sender exported after repair and before explicit closure. | Repair only | None |

## Evidence to cite

The fictional owner delegated the permitted file read and write to the coordinator under `CODING-FICTIONAL-PREVIEW-01-root`. In the original capture, the editor used the referenced grant `CODING-FICTIONAL-PREVIEW-01-edit` but that grant record was missing. In the corrected follow-up, `grants.jsonl` shows the coordinator delegated those two operations to `fictional-codex-editor` for `repo://fictional-preview/docs/quickstart.md` from 00:00 through the period before 00:02 UTC on January 1, 2026. The receipts for five retained files can be checked again. `quickstart.diff` and `codex-events.jsonl` are represented only by digests in a portable case.

The repair record identifies original `after.md`. The old digest is `0bec606c5209cbec36ec263c8f4bc261c440ef822af50e09db4a1351efae2f4f` and the replacement digest is `700c9aed0a7eecf416c7d2034a93efa959a0a87da4eb1197501127bb048684fa`. Compare the replacement with the manifest. The old digest and event times are the sender’s claims. The dates in this kit’s prepared sender events are fixed fictional values.

The matching pin run begins `CODEX-3e20f2ce5add` and its fingerprint is `40d644c03e4e8db3f8756f104a5e839dbc0943e208ecba8a151a7c122e49296d`. The corrected run begins `CODEX-f559c2afd796`. The conflicting folder changes a fictional call-event identifier and has its own manifest, run ID and fingerprint. Opening a case leaves each configured pin intact.

## Sender and receiver exercise

Rejecting the other workflow’s donor and canceling a valid preview leave the case unchanged. Applying the matching donor repairs `after.md`, preserves the decision, note, pin and follow-up, and records one local repair. After reload the case is still open. Closing explicitly and reloading leaves two local events, repair and closure. Either receipt-inclusive export can verify resolution in a fresh profile with the matching pin. Only the history-on export explains the digests reported for the earlier repair. A receiver’s newly imported case has no local history. Exporting it again does not turn imported sender events into locally performed actions.

Record help and wrong closures separately from correct explanations. Keep each observer’s setup and decision times separate. A maintainer or automated replay can validate expected outcomes. Independent human usability remains an observation to collect.
