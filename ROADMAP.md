# Roadmap

Alpha.15 adds **Local repair history** to saved Codex cases. A reviewer can
reopen a case and see which receipt changed, then see which pinned baseline
and passing follow-up supported the decision to close it. [Alpha.15 release](https://github.com/zrack/agent_delegation_control_plane/releases/tag/v0.1.0-alpha.15)

## Coding-agent review

For the first exercise, download the fictional demo ZIP. Pin
`pins/complete-capture` as `Follow-up review` and import
`cases/altered-original-receipt.json`. The case opens with a failed
`after.md` receipt and empty local history. [Alpha.15 repair history demo ZIP](https://github.com/zrack/agent_delegation_control_plane/releases/download/v0.1.0-alpha.15/adcp-codex-repair-history-demo-v0.1.0-alpha.15.zip) · [First exercise](docs/ALPHA_REVIEW.md#repair-an-original-codex-receipt)

1. Apply the repair from `donors/matching-case.json` and reload. The case is
   **Open** and **Ready to close**. The first history entry, **Original receipts
   repaired**, records both SHA-256 digests for `after.md`.

   | `after.md` | SHA-256 |
   | --- | --- |
   | Before repair | `0bec606c5209cbec36ec263c8f4bc261c440ef822af50e09db4a1351efae2f4f` |
   | After repair | `700c9aed0a7eecf416c7d2034a93efa959a0a87da4eb1197501127bb048684fa` |

2. Inspect the corrected editor grant, select **Close as resolved**, and reload
   again. The case is **Resolved**. A second entry, **Case explicitly closed**,
   identifies the pinned baseline and passing follow-up.

The release demo was verified in two fresh browser profiles. The second
profile rechecked the exported case against the same pin and showed
**Resolved** with empty local history. Each profile records its own actions.

The earlier checklist tests also cover missing and conflicting pins, altered
follow-up evidence, and a passing follow-up left open. [Checklist validation](docs/CODEX_CLOSURE_CHECKLIST_VALIDATION.md)

The [sandbox validation report](docs/SANDBOX_VALIDATION.md) covers the invoice pilot.

## Next evidence gates

1. **Observe first use of the history.** Ask reviewers to reopen the fictional
   case and identify the damaged receipt, the replacement, and the grant that
   justified closure. Record where they need help interpreting the two entries.
2. **Test a handoff.** With a permissioned case, have a second reviewer verify
   the exported closure in a fresh profile and explain why their history is
   empty. Measure time to a correct decision and count incorrect closures.
3. **Choose the next improvement from the results.** Fix recurring review friction
   first. If reviewers can explain the findings and need the same new record
   source, build one offline import adapter for that source. Check that the source
   records the completed action and the grant that covered it, including issuer,
   validity and parent authority. Keep missing authority visible as unverifiable.

The alpha is for local, retrospective review. Production deployment, live
ingestion, authenticated identities, revocation, and action enforcement require
separate design and validation.
