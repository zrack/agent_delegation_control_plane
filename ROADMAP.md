# Roadmap

Alpha.14 lets a reviewer repair an altered original Codex receipt in the saved
case. A matching export restores the file while preserving the workflow pin,
decision, note, and attached follow-up. [Alpha.14 release](https://github.com/zrack/agent_delegation_control_plane/releases/tag/v0.1.0-alpha.14)

## Coding-agent review

Start with a fictional quickstart edit. Pin `pins/complete-capture` as
`Follow-up review`, import `cases/altered-original-receipt.json`, and reload.
The checklist identifies `after.md` as the file that failed verification.
[Alpha.14 receipt repair demo ZIP](https://github.com/zrack/agent_delegation_control_plane/releases/download/v0.1.0-alpha.14/adcp-codex-receipt-repair-demo-v0.1.0-alpha.14.zip) · [First exercise](docs/ALPHA_REVIEW.md#repair-an-original-codex-receipt)

1. Try `donors/mismatched-workflow.json`. The dashboard rejects the export.
   Reload to confirm the original receipt still fails.
2. Choose `donors/matching-case.json`. The preview lists only `after.md`.
   Select **Apply receipt repair** and reload. The case is **Open** and the
   checklist says **Ready to close**.
3. Review the passing follow-up, select **Close as resolved**, and reload
   again. The case now shows **Resolved**.

The earlier checklist tests also cover missing and conflicting pins, altered
follow-up evidence, and a passing follow-up left open. [Checklist validation](docs/CODEX_CLOSURE_CHECKLIST_VALIDATION.md)

The [sandbox validation report](docs/SANDBOX_VALIDATION.md) covers the invoice pilot.

## Next evidence gates

1. **Observe first use.** Record where reviewers need help identifying the
   failed receipt, explaining why the wrong export was rejected, or deciding
   whether the follow-up justifies closure.
2. **Pilot the released repair flow.** Use one permissioned record set to
   compare in-place repair with verifying a clean copy in a separate profile.
   Measure time to a correct decision for each method and count incorrect
   closures. After reload, ask reviewers to explain what failed, what they
   repaired, and why they closed the case or left it open.
3. **Choose the next improvement from the results.** Fix recurring review friction
   first. If reviewers can explain the findings and need the same new record
   source, build one offline import adapter for that source. Check that the source
   records the completed action and the grant that covered it, including issuer,
   validity and parent authority. Keep missing authority visible as unverifiable.

The alpha is for local, retrospective review. Production deployment, live
ingestion, authenticated identities, revocation, and action enforcement require
separate design and validation.
