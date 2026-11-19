# Roadmap

The [v0.1.0-alpha.10 public prerelease](https://github.com/zrack/agent_delegation_control_plane/releases/tag/v0.1.0-alpha.10) adds Codex folder comparisons to the local regression inbox. Reviewers can save a candidate against a pinned workflow baseline and reopen the verdict, receipts, and decision. The [sandbox validation report](docs/SANDBOX_VALIDATION.md) records what the invoice pilot demonstrated.

## Coding-agent review

Start with the [four-folder Codex inbox demo ZIP](https://github.com/zrack/agent_delegation_control_plane/releases/download/v0.1.0-alpha.10/adcp-codex-inbox-demo-v0.1.0-alpha.10.zip) and [first-use walkthrough](docs/ALPHA_REVIEW.md#try-the-codex-run-folder-demo). Pin `complete-capture` in **Compare runs**. Use **Compare and save to inbox** for `clean-candidate` and `missing-grant` against that pin, then record an **Evidence needed** decision on the missing grant. Importing `altered-receipt` stops at the `after.md` mismatch.

After reload, the clean case should reproduce **No regression found** and the missing-grant case **Needs review**, with its saved decision and reason. The [Codex candidate validation](docs/CODEX_CANDIDATE_VALIDATION.md) records the automated results.

## Next evidence gates

1. **Observe first use.** Ask a small group of engineers to start with the
   alpha.10 four-folder Codex inbox demo. Record setup time, where they need help, and
   whether the evidence supports their decision.
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
