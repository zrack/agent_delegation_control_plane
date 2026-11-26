# Validate a completed capture offline

Start with one action. A fictional review agent read a guide using a single time-limited grant. The fixture includes a capture header, the grant as issued, a completed tool record and the bytes the tool observed. [Fictional source records](examples/source-records.json) · [Importable investigation](examples/investigation.json)

From the source checkout with Node 22+, run the following before importing a new capture into the dashboard. The command reads local files and prints its result. It leaves the input and browser state unchanged.

```sh
node scripts/validate-capture.mjs --investigation docs/producer/examples/investigation.json
```

Expect `within-scope` with `receipts not-supplied`. The viewer can evaluate the supplied grant against the recorded action. An investigation file holds evidence references. Verifying actual receipt bytes requires the supported Codex capture folder.

## Map the source to the investigation

| Producer record | Version 1 investigation field | Check |
| --- | --- | --- |
| Run header | `chain.id`, `principal.id`, `rootGrantId` | Keep the stable run, principal and root grant identifiers. |
| Issued grant | `grants[0].id`, `parentGrantId`, `issuer`, `subject`, `principal` and `canDelegate` | Preserve who issued it, to whom, and whether it permits delegation. A root grant has a null parent. |
| Grant scope and validity | `grants[0].capabilities`, `validFrom` and `expiresAt` | Use the exact granted action/resource pair and the recorded UTC validity window. |
| Completed tool action | `events[0].id`, `parentEventId`, `actor`, `authorityId`, and `action` | Retain the action’s reference to its grant, exact resource, recorded action time and completed outcome. Put rejected or attempted actions in the producer’s separate attempt records. |
| Tool receipt | `events[0].evidence.callId`, `tool`, `artifactSha256` | Join the tool call by its ID. The example digest is the SHA-256 of the UTF-8 bytes in `observedArtifactUtf8`, including the final newline. |

The general investigation format accepts multiple events and grants. The Codex folder importer accepts the documented single-file quickstart workflow and its seven files. [Format and limits](../../ARCHITECTURE.md#offline-codex-run-folder)

## Three negative exercises

1. **Locate a malformed field.** Run `node scripts/validate-capture.mjs --investigation docs/producer/examples/malformed.json`. The output identifies `chain.events[0].action.resource` and exits 2. In a scratch copy restore the exact resource from `toolCompletion.resource` in the source records, then rerun. The result becomes `within-scope`.
2. **Investigate a missing grant.** Run the same command with `docs/producer/examples/missing-grant.json`. It exits 1 with `unverifiable` and identifies grant `guide-read` referenced by action `inspect-guide`. Resolve it only if you can retrieve the actual issued grant. Preserve the missing reference when the record is unavailable.
3. **Diagnose an altered Codex receipt.** Build the [fictional handoff kit](../codex-handoff/START_HERE.md), copy its `pins/matching` directory to scratch space and run `node scripts/validate-capture.mjs --codex-folder PATH_TO_COPY`. All seven files verify. Append a line to `after.md` in the copy and rerun. The command identifies `after.md` and reports a receipt mismatch. Restore the original recorded bytes from the matching folder to recover.

Add `--json` for versioned machine-readable output. Exit 0 means the supplied capture evaluates within scope. Exit 1 means the evaluator identified a violation or evidence gap, or a Codex receipt failed its integrity check. Exit 2 indicates malformed, oversized, unavailable or unsupported input. Check `status`, `authority`, `receipts` and the diagnostic codes to distinguish these conditions. Positions are zero-based. The command returns up to 25 authority findings and the total number. It omits receipt contents, action descriptions and local absolute paths.
