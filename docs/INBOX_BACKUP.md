# Back up and restore selected cases

In **Regression inbox → Back up or restore selected cases**, select the cases to download. Each portable case includes its recorded report, matching investigations, saved decision and reason, and verified follow-up evidence when available. Add a matching workflow pin only if you want to carry its reference. Unnamed report-only cases have no associated workflow pin.

**Include folder receipts** is required for a full Codex or invoice case. Receipts can contain source text, output and tool records. Saved notes and your own Codex repair history each have a separate opt-in. A full folder case must meet its existing receipt-export requirements, including a saved decision and a verifiable original. If its original receipts are damaged, repair them first or use the original source files. Export stops if a saved follow-up or closure cannot be verified for transfer. Check the workflow pin and relevant receipts before trying again. Local history you elect to share appears at the destination as sender-reported history. Previously imported sender events and local reviewed flags are omitted. The JSON download is unencrypted.

If an attached baseline or candidate failed its fingerprint check, the inbox retains that finding and drops the rejected file. Export stops and identifies the affected case and side. Attach matching evidence or leave that case out of the selection. A report with genuinely missing evidence can still transfer and will show the same missing evidence after restore.

1. Choose an inbox backup in the restore panel. Existing cases and matching pins are marked and preserved. A conflict displays the pin identities and prevents replacing the local pin.
2. Select new cases. Pins start unchecked. Independently compare the proposed fingerprint with the receiver’s trusted baseline before choosing to add it. A selected pin requires an associated selected or already saved case with a qualified matching baseline.
3. Choose **Preview selected restore**. Review the rechecked disposition and warnings for each case and the effect of accepted pins on cases already saved for that workflow. A recorded closure without the required supporting evidence stays open. Changing the selection requires another preview.
4. Choose **Confirm restore** or **Cancel restore**. A successful restore saves the selected set together. Existing cases, notes, and decisions remain intact. Reopen the dashboard to review them.

The backup supports 20 cases, 20 pins and a maximum 4 MiB file. The normal per-case and per-collection limits still apply. The receiver also needs temporary storage for a rollback record. A full profile can reject a restore that would fit without the rollback record. Try fewer cases or a fresh profile with enough space.

## Recovery and multiple tabs

Backup restore uses Web Locks on loopback. Current dashboard tabs also hold that lock when changing saved data. A saved change since preview requires a new preview. Close tabs using an older dashboard version before restoring because those versions do not participate in the lock.

A pending rollback record keeps prior data visible to current dashboard tabs while the selected collections are written. A failure restores the previous collections. Reopening after an interruption retries recovery before loading the dashboard. If another application or older tab edited the same browser storage unexpectedly, recovery preserves the prior snapshot and the unexpected values and blocks further writes. Preserve the profile and backup file before reconciling such a conflict. The dashboard never changes another application’s storage keys.
