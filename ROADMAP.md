# Roadmap

Alpha.13 adds a closure checklist to open Codex review cases. It identifies which evidence failed, whether the recipient’s workflow pin matches, and what the reviewer can do next. [Alpha.13 release](https://github.com/zrack/agent_delegation_control_plane/releases/tag/v0.1.0-alpha.13)

## Coding-agent review

Start with the altered original receipt in the [alpha.13 demo ZIP](https://github.com/zrack/agent_delegation_control_plane/releases/download/v0.1.0-alpha.13/adcp-codex-closure-checklist-demo-v0.1.0-alpha.13.zip). In a fresh profile, pin `pins/complete-capture` as `Follow-up review`, import `cases/altered-original-receipt.json`, and reload. Even with the matching pin, the case stays **Open** because the original `after.md` fails its digest check. The checklist points the reviewer to a clean export, which they can verify in a separate profile. [First exercise](docs/ALPHA_REVIEW.md#inspect-the-altered-original-receipt)

The six tested scenarios also cover matching, missing, and conflicting pins, an altered follow-up receipt, and a passing follow-up left open. A reviewer can replace a bad follow-up receipt with a verified corrected folder and decide whether to close the case. [Checklist validation](docs/CODEX_CLOSURE_CHECKLIST_VALIDATION.md)

The [sandbox validation report](docs/SANDBOX_VALIDATION.md) covers the invoice pilot.

## Next evidence gates

1. **Observe first use.** Start with the altered original receipt. Record whether reviewers can identify the failed file, explain why the matching pin is insufficient, and verify the clean copy while keeping the failed case available.
2. **Pilot in-place repair of original Codex evidence.** The proposed next feature would let a reviewer preview matching receipts from a clean export and apply them to the saved case. Verify that the repair preserves the pin, decision, and notes across reload, rejects mismatched evidence, and leaves closure to the reviewer. Compare it with the separate-profile workflow on one permissioned record set. Measure time to a correct decision and record any incorrect closures.
3. **Choose the next improvement from the results.** Fix recurring review friction
   first. If reviewers can explain the findings and need the same new record
   source, build one offline import adapter for that source. Check that the source
   records the completed action and the grant that covered it, including issuer,
   validity and parent authority. Keep missing authority visible as unverifiable.

The alpha is for local, retrospective review. Production deployment, live
ingestion, authenticated identities, revocation, and action enforcement require
separate design and validation.
