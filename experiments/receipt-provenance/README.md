# Evidence receipt signature experiment

A release reviewer receives a portable case and needs to know whether the producer they trust signed these particular bytes for this workflow and run. The existing manifest can be rewritten alongside the case. The experiment verifies a detached producer statement against a key independently selected by the recipient. It runs offline with Node 22+.

```sh
node experiments/receipt-provenance/prototype.mjs docs/codex-handoff/fixtures/alpha15-case.json
node --test experiments/receipt-provenance/prototype.test.mjs
```

The example creates a temporary Ed25519 key pair in memory, enrolls its public key in a fictional receiver trust list, signs the case, and verifies it. It prints the result and discards both keys on exit. This exercises the mechanism. An independent producer enrollment and a deployment key store are still needed for an operational system.

## Statement and trust decision

The signed statement has one in-toto v1 subject named `review-case.json`, the SHA-256 of the exact file bytes, and a project-specific predicate with an issuer, workflow and run ID. A DSSE envelope signs the payload type and exact statement bytes using pre-authentication encoding. There is one Ed25519 signature. The SHA-256 fingerprint of the public key’s SPKI encoding is a lookup hint. The verifier uses the public key from its own trust list and requires the expected issuer, workflow and run context supplied by the recipient. [DSSE v1 protocol](https://github.com/dsse-lf/dsse/blob/master/protocol.md) · [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md) · [Node cryptography](https://nodejs.org/api/crypto.html)

| Threat or operating event | Receiver behavior |
| --- | --- |
| Case bytes changed in transit | The signed subject digest must match the bytes received, including whitespace. |
| Sender supplies a public key with their package | Only an independently enrolled key for the expected producer and workflow can verify. |
| Signed file presented as another run or statement type | Check the signed context, predicate type, subject name and envelope media type. |
| Key revoked or rotated | Reject keys currently marked revoked, including for previously signed receipts. Enroll the replacement separately. A claimed signing time cannot override revocation. |
| Envelope re-used for the same case | The same receipt may verify again. It creates no new approval, history entry, authority grant or closure. |
| Trusted producer signs inaccurate records | The statement can establish that the enrolled key signed the bytes. Reviewers still evaluate authority, receipt consistency and closure independently. |

A future pilot needs an owner who can approve issuer-to-workflow bindings through an authenticated channel, rotate signing keys, and deliver an authenticated, fresh revocation list to offline reviewers. Key compromise, freshness, completeness of capture, historical timestamping and independent identity enrollment remain open. The local dashboard does not use these signatures when deciding case closure.
