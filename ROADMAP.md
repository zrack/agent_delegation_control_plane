# Roadmap

Alpha.12 lets a second reviewer verify a Codex case in their own browser. The sender can include the original and corrected receipts in one case file. The recipient checks those receipts, the recorded closure, and the local workflow pin. [v0.1.0-alpha.12 release](https://github.com/zrack/agent_delegation_control_plane/releases/tag/v0.1.0-alpha.12)

## Coding-agent review

Start with the [portable Codex demo ZIP](https://github.com/zrack/agent_delegation_control_plane/releases/download/v0.1.0-alpha.12/adcp-portable-codex-review-demo-v0.1.0-alpha.12.zip). In a fresh profile, import `cases/resolved.json` without a workflow pin and reload. The case stays **Open** until you inspect and pin the included baseline. Reload again to verify **Resolved**. [First-use walkthrough](docs/ALPHA_REVIEW.md#try-the-portable-codex-review-demo)

The same file restores **Resolved** with a matching **Follow-up review** pin. A conflicting pin keeps it **Open** and preserves the recipient’s pin. Altering either the original or corrected `after.md` keeps the case **Open** and disables closure. A passing follow-up the sender left open also stays **Open** after reload, with **Close as resolved** available to the recipient. [Portable case validation](docs/CODEX_PORTABLE_CASE_VALIDATION.md)

The [sandbox validation report](docs/SANDBOX_VALIDATION.md) covers the invoice pilot.

## Next evidence gates

1. **Observe first use.** Ask a small group of engineers to start with the
   alpha.12 portable Codex demo. Record where recipients need help inspecting or adopting
   the baseline, how long those steps take, and whether they can explain why each case stayed open or resolved.
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
