# Roadmap

The [public technical alpha](https://github.com/zrack/agent_delegation_control_plane/releases/tag/v0.1.0-alpha.1)
includes a local investigation dashboard, baseline comparisons, and a regression
review inbox. The [sandbox validation report](docs/SANDBOX_VALIDATION.md) records
what the invoice pilot demonstrated.

## Next evidence gates

1. **Observe first use.** Ask a small group of engineers to start from the public
   release and try the [first-use review](docs/ALPHA_REVIEW.md). Record setup time,
   where they need help, and whether the evidence supports their decision.
2. **Compare one permissioned workflow.** Freeze a completed record set and
   compare the dashboard with the investigator's existing method. Record accuracy,
   elapsed time, missed issues, and results that stayed the same or got worse.
3. **Choose the next improvement from the results.** Fix recurring review friction
   first. If reviewers can explain the findings and need the same new record
   source, build one offline import adapter for that source.

The alpha is for local, retrospective review. Production deployment, live
ingestion, authenticated identities, revocation, and action enforcement require
separate design and validation.
