# Verify a portable invoice case offline

Use Node 22+ in a source checkout. The command reads a version 1 receipt-inclusive invoice review case, recomputes the original and follow-up checks, and prints the current disposition. It never writes a pin, saves a decision, or closes a case.

Download and extract the [four fictional invoice cases from alpha.7](https://github.com/zrack/agent_delegation_control_plane/releases/download/v0.1.0-alpha.7/adcp-invoice-closure-checklist-demo-v0.1.0-alpha.7.zip). From the checkout, set `demo` to the extracted directory.

```sh
demo=adcp-portable-invoice-review-demo
node scripts/verify-case.mjs --case "$demo/invoice-b-resolved.json"
node scripts/verify-case.mjs --json --case "$demo/invoice-b-altered-receipt.json"
```

| Case in the release | Expected disposition with no receiver pin | Evidence |
| --- | --- | --- |
| `invoice-b-resolved.json` | `resolved` | The original validation receipt is missing. The corrected follow-up verifies its totals, authority and execution, and the recorded closure verifies. |
| `invoice-c-resolved.json` | `resolved` | The original results file has a hash mismatch. The corrected follow-up and closure verify. |
| `invoice-b-altered-receipt.json` | `open-blocked` | The follow-up results file differs from its recorded digest. Its saved snapshot cannot verify. |
| `invoice-c-different-baseline.json` | `open-blocked` | The packaged baseline disagrees with the original comparison fingerprint. |

## Supply a receiver pin

For an independent comparison, use an existing trusted directory containing `investigation.json` and its `pin.json`, created by the [offline regression command](../scripts/regression.mjs). Supply the name of the workflow that owns this receiver pin.

```sh
node scripts/verify-case.mjs --json --case "$demo/invoice-c-resolved.json" \
  --workflow 'Demo invoices' --baseline-dir path/to/your/invoice-baseline
```

A matching pin allows verification. A conflicting pin keeps the case open. An invalid pin or an explicitly supplied workflow name that differs from the invoice case produces an input error. The command leaves the receiver files unchanged.

When both receiver options are omitted, a portable invoice case can verify a **previously recorded closure** against its matching packaged baseline. An open case with a passing follow-up still needs a matching receiver pin before a reviewer can explicitly close it locally. A portable Codex case requires the receiver pin even for a previously recorded closure. [Codex handoff guide](CODEX_HANDOFF.md#verify-the-case-offline)

## Interpret the result

Exit `0` means verified resolved. Exit `1` means a valid case is open, either blocked or ready for explicit closure. Exit `2` means the command could not check its inputs.

In version 1 JSON, `checks.original` and `checks.followUp` are the delegation comparison results. The separate `invoice.original` and `invoice.followUp` sections show the saved snapshot status, authority, output, execution and individual receipt states. A verified original snapshot can faithfully preserve a missing or mismatched receipt. A passing delegation comparison can accompany a failed execution check. Inspect the disposition and its reasons for the closure outcome. Receipt contents and notes stay out of the output.
