# Technical alpha release checks

The source is prepared for a small public technical alpha, subject to the gates
below. **The repository remains private.** This checklist does not authorize a
visibility change, deployment, live model spending or release publication.

## Gates before changing visibility

| Gate | Evidence required | Current status |
| --- | --- | --- |
| Historical privacy | Verify all intended branches/tags, retained PR references, cached commits/diffs, comments, workflow logs, artifacts and attachments; resolve remaining unwanted personal/operational history with GitHub | Open: GitHub-controlled history cleanup and readback are still required; detailed evidence is private |
| Current source | Source/privacy checks pass; only intended files appear in the release archive; approved Apache-2.0 attribution retained | Automated checks and final archive review are required for the selected release commit |
| Reproducibility | Fresh checkout with no project key or saved runs passes offline checks; fictional examples and import/reload behavior are reviewable | Maintainer automation rehearsed runtime baseline `0a78c68`: fresh hash-verified SDK install, all 60 offline tests, three example outcomes, import/reload with identical raw evidence, same-ID replacement, invalid-file recovery and clearing passed; no independent human usability result is implied |
| Dependencies | Both pinned dependency sets pass advisory checks; compatibility exceptions have a rationale | websockets 17 is deferred because openai-agents 0.24.0 requires >=15,<17; revisit with an SDK upgrade |
| Maintainer decision | Explicit approval of the exact revision and visibility change | Not granted |

Keep private audit reports, Support correspondence, raw provider records and old
clones/backups outside the repository. Never merge or push old backup refs into
the cleaned history. A clean current branch alone does not clear the privacy gate.

## At an explicitly approved public launch

1. Verify privacy cleanup again, including the formerly accessible old references
   and cached views; do not rely only on a Support acknowledgment.
2. Change visibility only after the maintainer authorizes it. Recheck branch
   protection, required checks, secret scanning/push protection availability,
   dependency alerts and repository permissions.
3. Enable GitHub private vulnerability reporting and verify the **Report a
   vulnerability** route described in [SECURITY.md](../SECURITY.md). This is a
   public-repository feature; its activation remains pending while private.
4. After the reporting route works, create a reviewed `v0.1.0-alpha.1` tag/release
   from the approved commit and its reviewed source archive. Do not attach raw
   run directories, keys, private audit files or screenshots.
5. Announce the bounded alpha scope and known limits from the
   [sandbox validation report](SANDBOX_VALIDATION.md). Deployment and real-data
   operation remain separate decisions.

## Reviewer rehearsal

Use the [alpha review worksheet](ALPHA_REVIEW.md) with a fresh checkout. Record
setup friction, explanations, mistakes and help needed. An automated or maintainer
rehearsal is engineering evidence; independent operator value requires an actual
reviewer and remains a separate roadmap gate.

GitHub documents the limits of [history and cached-reference removal](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
and the availability of [private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).
