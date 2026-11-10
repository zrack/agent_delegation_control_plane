# Security policy

## Reporting a vulnerability

The repository is currently private during release preparation. Public vulnerability
intake is not enabled. Maintainers should use a private draft repository security
advisory for internal investigation rather than an ordinary issue.

At public launch, enable GitHub private vulnerability reporting and verify that
**Report a vulnerability** appears on the repository's
[Security Advisories page](https://github.com/zrack/agent_delegation_control_plane/security/advisories).
That private form is the intended public reporting route. Do not announce the alpha
until the route works. If the button is missing after launch, open an issue asking
for a private reporting route without describing the vulnerability.

Include the affected revision, reproduction steps using fictional input, expected
and observed behavior, and impact. Do not include API keys, personal/customer data,
raw provider payloads or private investigation records. Put vulnerability details
only in the private report, never in a public issue. Do not test against other
people's systems or data.

## Scope and limits

Treat imported files, model output and external content as untrusted. Keep credentials in ignored local configuration and grant tools only their required authority. The viewer is retrospective and cannot block actions or authenticate source identities. Loopback does not provide user authentication.

See the [threat model](docs/architecture/THREAT_MODEL.md), [architecture](ARCHITECTURE.md) and [privacy guidance](docs/PRIVACY.md). Current checks do not represent a comprehensive vulnerability audit or production certification.
