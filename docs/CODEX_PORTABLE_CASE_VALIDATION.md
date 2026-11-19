# Portable Codex review case validation

The development dashboard was tested in Chromium 158 with one authoring profile and seven fresh recipient profiles. Every recipient imported a case through **Regression inbox → Import review package or case**, then reloaded the same dashboard address. All runs used the fictional folders from the [alpha.11 demo ZIP](https://github.com/zrack/agent_delegation_control_plane/releases/download/v0.1.0-alpha.11/adcp-codex-followup-demo-v0.1.0-alpha.11.zip).

## Prepare the downloads

1. Pin `complete-capture` under a workflow name. Compare `missing-grant` against that pin and save it in the inbox. Record an **Evidence needed** decision with a reason and save a separate review note.
2. Attach `clean-candidate` to the case. While it is still **Open**, expand **Export review package or case**, select **Include Codex receipts in case download**, and choose **Download review case**. Keep this file for the passing-but-open test.
3. Select **Close as resolved** and reload. Download the resolved case with both the receipts and the saved note selected. Keep a second copy downloaded with the default options.

Each receipt-bearing download included the actions, grants and attempts ledgers for both captures, along with `before.md` and `after.md`. Each file matched its source folder byte for byte. The diff and raw event stream were represented by their digests. The default download contained the normalized runs, report and decision. The note-only export added just the note. The receipts-only export added both receipt snapshots and kept the note out. Both options reset after every download.

## Observed results after import and reload

| Recipient profile and imported file | Case after reload | What the recipient could verify |
| --- | --- | --- |
| Original baseline pinned under the same name, resolved file | **Resolved** | The decision, reason and note survived. Opening both grant ledgers reproduced the original file with the grant missing and the corrected file with the editor grant present. |
| No workflow pin, resolved file | **Open** | Inspecting the included baseline ID and fingerprint left the workflow unpinned. Selecting **Pin included baseline** restored **Resolved** and it survived another reload. **Compare runs** listed the adopted baseline immediately in the same tab. |
| `clean-candidate` pinned under the same name, resolved file | **Open** | Closure was disabled. Import and reload preserved the conflicting pin and the review decision. |
| Matching pin, original receipt altered | **Open** | Changing the original `after.md` bytes in a copy of the download triggered a hash mismatch for that file. Closure was disabled and the saved decision and reason were visible. |
| Matching pin, follow-up receipt altered | **Open** | Changing only the corrected `after.md` bytes triggered its own hash mismatch. Closure was disabled and the review reason survived. |
| Matching pin, passing follow-up exported before closure | **Open** | Both grant ledgers verified. **Close as resolved** was enabled for an explicit decision by the recipient. |
| No pin, default download of the resolved case | **Open** | The original decision and reason were present. The exported file omitted the saved note, receipt snapshots, follow-up and closure. |

For either altered-receipt check, change the base64 value for `after.md` in the selected snapshot while keeping the supplied manifest and closure intact. Start each import in a separate profile. For any row that requires the original pin, pin `complete-capture` under the same workflow name before importing.
