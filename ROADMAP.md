# Roadmap

The public alpha now lets a reviewer close a flagged Codex run with a corrected folder. The inbox retains the original finding and decision alongside the follow-up grant ledger. [v0.1.0-alpha.11 release](https://github.com/zrack/agent_delegation_control_plane/releases/tag/v0.1.0-alpha.11)

## Coding-agent review

Start with the [alpha.11 four-folder follow-up demo ZIP](https://github.com/zrack/agent_delegation_control_plane/releases/download/v0.1.0-alpha.11/adcp-codex-followup-demo-v0.1.0-alpha.11.zip) and the [first-use walkthrough](docs/ALPHA_REVIEW.md#try-the-codex-run-folder-demo). Pin `complete-capture` and save the `missing-grant` case against it. The demo exercises three outcomes on that case.

| Evidence or pin change | Case after reload |
| --- | --- |
| Attach `altered-receipt`. Its `after.md` digest differs from the manifest. | **Open**. Attachment fails and the saved decision remains. |
| Attach `clean-candidate` and inspect the restored editor grant. | **Open** until the reviewer selects **Close as resolved**. After closure, **Resolved** with both ledgers available. |
| Replace the same workflow’s pin with the corrected run after closing the case. | **Open**. Closure is disabled and the replacement pin is preserved. |

The [Codex follow-up validation](docs/CODEX_FOLLOWUP_VALIDATION.md) records the browser checks. The [sandbox validation report](docs/SANDBOX_VALIDATION.md) covers the invoice pilot.

## Next evidence gates

1. **Observe first use.** Ask a small group of engineers to start with the
   alpha.11 corrected-folder demo. Record setup time, where they need help, and
   whether they can explain why a passing follow-up permits closure and a changed pin reopens the case.
2. **Compare one permissioned workflow.** Freeze a completed record set and
   compare the dashboard with the investigator's existing method. Record accuracy,
   time to prepare and review the records, missed issues, and results that stayed
   the same or got worse.
3. **Choose the next improvement from the results.** Fix recurring review friction
   first. If reviewers can explain the findings and need the same new record
   source, build one offline import adapter for that source. Check that the source
   records the completed action and the grant that covered it, including issuer,
   validity and parent authority. Keep missing authority visible as unverifiable.

The alpha is for local, retrospective review. Production deployment, live
ingestion, authenticated identities, revocation, and action enforcement require
separate design and validation.
