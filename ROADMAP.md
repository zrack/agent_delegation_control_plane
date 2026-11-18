# Roadmap

The [public technical alpha](https://github.com/zrack/agent_delegation_control_plane/releases/tag/v0.1.0-alpha.9)
includes a local investigation dashboard, baseline comparisons, and a regression
review inbox. The [sandbox validation report](docs/SANDBOX_VALIDATION.md) records
what the invoice pilot demonstrated.

## Coding-agent review

Start with the [three-case Codex run-folder demo ZIP](https://github.com/zrack/agent_delegation_control_plane/releases/download/v0.1.0-alpha.9/adcp-codex-run-folder-demo-v0.1.0-alpha.9.zip) and
[walkthrough](docs/ALPHA_REVIEW.md#try-the-codex-run-folder-demo). The complete capture shows
**Within scope**. The missing grant shows **Unverifiable** on both editor hops.
The altered receipt stops import with an `after.md` hash mismatch.

## Next evidence gates

1. **Observe first use.** Ask a small group of engineers to start with the
   alpha.9 Codex run-folder demo. Record setup time, where they need help, and
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
