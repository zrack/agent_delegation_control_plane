# Technical alpha release checks

## Published alpha

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
