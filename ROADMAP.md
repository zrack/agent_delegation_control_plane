# Roadmap

The [public technical alpha](https://github.com/zrack/agent_delegation_control_plane/releases/tag/v0.1.0-alpha.8)
includes a local investigation dashboard, baseline comparisons, and a regression
review inbox. The [sandbox validation report](docs/SANDBOX_VALIDATION.md) records
what the invoice pilot demonstrated.

## Coding-agent review

Start with the [four-case coding-agent demo ZIP](https://github.com/zrack/agent_delegation_control_plane/releases/download/v0.1.0-alpha.8/adcp-coding-agent-review-demo-v0.1.0-alpha.8.zip) and
[walkthrough](docs/ALPHA_REVIEW.md#try-the-coding-agent-review-demo). Review a
fictional documentation edit with a clean baseline, a write outside scope, and
a missing grant. Verify the corrected follow-up against the original baseline
and close both cases.

## Next evidence gates

1. **Observe first use.** Ask a small group of engineers to start with the
   alpha.8 coding-agent demo. Record setup time, where they need help, and
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
