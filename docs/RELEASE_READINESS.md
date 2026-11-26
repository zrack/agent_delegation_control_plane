# Technical alpha release checks

## Published alpha

The [alpha.16 prerelease](https://github.com/zrack/agent_delegation_control_plane/releases/tag/v0.1.0-alpha.16) ships the fictional Codex handoff kit from [`b65ab0a`](https://github.com/zrack/agent_delegation_control_plane/commit/b65ab0aaa6e038596782d2906193d3582b451832). Start with the [receiver exercise](ALPHA_REVIEW.md#review-a-codex-handoff).

| Check | Release evidence |
| --- | --- |
| Source ZIP | All 156 files in GitHub’s public source download matched the tagged commit byte for byte. |
| Demo ZIP | Two builds produced the same ZIP. All 35 files listed in its manifest verified. The [published ZIP](https://github.com/zrack/agent_delegation_control_plane/releases/download/v0.1.0-alpha.16/adcp-codex-handoff-demo-v0.1.0-alpha.16.zip) has SHA-256 `d13bd9772d6333ef656b7452d5c4bdf23a787aea4f0d7398dc07a8f08ddcda6c`. |
| Receiver outcomes | The browser after reload and the [offline verifier](CODEX_HANDOFF.md#verify-the-case-offline) agreed on all seven scenarios. Two were resolved, four were blocked and one remained open pending explicit closure. |
| CI | [Project integrity, browser acceptance and security passed](https://github.com/zrack/agent_delegation_control_plane/actions/runs/45756246703) on the tagged revision. |

The [alpha.15 exercise](ALPHA_REVIEW.md#repair-an-original-codex-receipt) remains available for reviewers who want to perform the original receipt repair themselves.

## Original public alpha release

[v0.1.0-alpha.1](https://github.com/zrack/agent_delegation_control_plane/releases/tag/v0.1.0-alpha.1)
is a public prerelease for local, retrospective investigation with fictional
records. The public repository started from a reviewed source snapshot.
The original repository and its historical records remain private.

| Check | Release evidence |
| --- | --- |
| Source archive | The public source ZIP matched all 87 tracked files at the reviewed release commit `f7ef54d` byte for byte. |
| CI | [Project integrity and security passed](https://github.com/zrack/agent_delegation_control_plane/actions/runs/42745906353) at the release commit. |
| Reporting | GitHub private vulnerability reporting was enabled and the public Advisories page exposed **Report a vulnerability**. See the [security policy](../SECURITY.md). |
| Rights | The release includes the [Apache-2.0 license](../LICENSE), [copyright attribution](../NOTICE), and [third-party notices](../THIRD_PARTY_NOTICES.md). |

The [sandbox validation report](SANDBOX_VALIDATION.md) describes what the invoice
pilot demonstrated. Independent reviewer usefulness, production deployment, and
real-data operation remain separate decisions.

## Checklist for future public prereleases

1. Review the exact release revision and archive. Include only intended public
   files and retain the license and notices. Inspect any branches, tags, PR
   content, workflow logs, or artifacts introduced by the release for private
   material. Keep private history, backups, audit records, keys, and raw runs
   outside the public repository.
2. Confirm the required project-integrity and security jobs pass on the release
   revision. From a fresh copy, follow the [alpha guide](ALPHA_REVIEW.md) with
   fictional inputs and check that the review packages import and remain
   available after reload.
3. Verify the public repository's branch protection and private vulnerability
   reporting. Confirm **Report a vulnerability** is available on the
   [Advisories page](https://github.com/zrack/agent_delegation_control_plane/security/advisories).
4. Obtain maintainer approval for the exact release revision and public assets.
   After publishing, verify that the tag points to the approved commit and that
   the public source archive matches the reviewed tree. Include the alpha scope
   and known limits in the release notes.

## Reviewer evidence

Use the [first-use review](ALPHA_REVIEW.md) to collect setup time, mistakes,
assistance needed, and the evidence behind each decision. Track independent
reviewer results separately from automated and maintainer checks.
