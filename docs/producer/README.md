# Validate a completed capture offline

Start with one action. A fictional review agent read a guide using a single time-limited grant. The fixture includes a capture header, the grant as issued, a completed tool record and the bytes the tool observed. [Fictional source records](examples/source-records.json) · [Importable investigation](examples/investigation.json)

From the source checkout with Node 22+, run the following before importing a new capture into the dashboard. The command reads local files and prints its result. It leaves the input and browser state unchanged.

```sh
node scripts/validate-capture.mjs --investigation docs/producer/examples/investigation.json
```

Expect `within-scope` with `receipts not-supplied`. The viewer can evaluate the supplied grant against the recorded action. An investigation file holds evidence references. To verify receipt bytes, supply a supported Codex folder or the completed SDK account-review folder described below.

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

Add `--json` for versioned machine-readable output. Exit 0 means the supplied capture evaluates within scope. Exit 1 means the evaluator identified a violation or evidence gap, or a supplied folder receipt failed an integrity check. Exit 2 indicates malformed, oversized, unavailable or unsupported input. Check `status`, `authority`, `receipts` and the diagnostic codes to distinguish these conditions. Positions are zero-based. The command returns up to 25 authority findings and the total number. It omits receipt contents, action descriptions and local absolute paths.

## Check the SDK account-review folder

The repository’s [OpenAI Agents SDK example](../../integrations/openai-agents/README.md) records a coordinator reading a fictional Northstar account, a researcher repeating the read after a handoff, and a reporter writing a local summary. To inspect a completed export from that workflow, use Node 22+ and the directory containing `manifest.json`. The verifier reads local files and needs no SDK installation or provider key.

```sh
node scripts/validate-capture.mjs --sdk-folder PATH_TO_COMPLETED_FOLDER --json
```

| Local evidence | What the verifier checks |
| --- | --- |
| `manifest.json` | SHA-256 of all six named files. The existing producer emits an unversioned manifest and a version 1 investigation. The verifier accepts the same manifest layout with an explicit version of 1 and rejects other versions. |
| `capture.jsonl` and `mapping.json` | Model requests and responses, tool-call IDs, both ordered handoffs, completed actions, and the source lines for grants and actions. A mapped record must agree with the normalized investigation. |
| `account.json` and `summary.txt` | Both read receipts match the account, and the recorded write input, action digest and write result agree with the saved summary. |
| `result.json` and `investigation.json` | The run and model agree with the manifest. The recorded reporter response agrees with the final result. The evaluator assesses the supplied grant chain for each completed action. |

A complete, in-scope replay returns `within-scope` and `verifiedFileCount: 6`. If the reporter’s grant is absent from both the ledger and the investigation, the receipts can still verify while authority is `unverifiable`. The diagnostic points to the one-based source line and zero-based record index. A changed summary fails even if someone refreshes its manifest hash while leaving the original action receipt in place. A contradictory mapping or unsupported format yields `invalid-input` with authority `unassessed`.

The default test suite generates fictional compatibility cases locally. With the example's SDK dependencies installed, run `python scripts/check.py --with-sdk` to verify a newly written folder through the production export code using a deterministic replay model. The command also runs the missing-grant, altered-output, ledger, mapping and unsupported-version cases. No key or network connection is needed for these tests. [Compatibility cases](../../tests/evaluator/test_sdk_folder.py) · [SDK replay](../../integrations/openai-agents/test_workflow.py)

This check covers the repository's account-review producer. A self-consistent folder establishes agreement among supplied records. Producer identity, completeness of capture and performance on a recurring external workflow require separate evidence. Keep raw folders local when they contain prompts, tool results or model text.
