# Codex closure checklist validation

Six fresh Chromium 158 profiles imported the unmodified cases from the [alpha.12 portable Codex demo ZIP](https://github.com/zrack/agent_delegation_control_plane/releases/download/v0.1.0-alpha.12/adcp-portable-codex-review-demo-v0.1.0-alpha.12.zip) into the development dashboard. The ZIP’s SHA-256 was `35f195ce075c4df413f6c579145a7da3152e3b30ecfe6151a362da590f85e86c`. Each profile imported through **Regression inbox → Import review package or case**, then reloaded at the same address. Pins were created through **Compare runs** under the workflow name **Follow-up review**.

| Pin and case | Observed after reload | Next step checked |
| --- | --- | --- |
| `complete-capture` and `resolved.json` | **Resolved** with no open-case checklist. The original and corrected grant ledgers matched their respective receipts. | Both grant ledgers could still be inspected. |
| No pin and `resolved.json` | **Open**. The checklist identified the missing baseline. | **Inspect baseline details** opened the run ID and fingerprint without setting a pin. Selecting **Pin included baseline** restored **Resolved** after a second reload. |
| `clean-candidate` and `resolved.json` | **Open**. The checklist identified a conflict. | Inspection exposed both run IDs and fingerprints. The local pin was preserved and closure stayed disabled. |
| `complete-capture` and `altered-original-receipt.json` | **Open**. The checklist identified the original `after.md` digest mismatch. | The checklist directed the recipient to request a clean export with receipts and inspect it in a fresh profile. The saved decision remained visible and closure was disabled. |
| `complete-capture` and `altered-follow-up-receipt.json` | **Open**. The checklist identified the follow-up `after.md` mismatch. | Checklist navigation focused the corrected-folder picker. Attaching the demo’s verified `clean-candidate` folder made closure available. After reload the case was still **Open**. |
| `complete-capture` and `follow-up-open.json` | **Open**, with **Ready to close**. The receipts and follow-up verified. | Checklist navigation only focused **Close as resolved**. Selecting that button explicitly closed the case, and **Resolved** survived reload. |

## Review state

The saved inbox and workflow-pin records were compared byte for byte before and after reload and after checklist navigation. Viewing the checklist, inspecting a baseline, and focusing a control preserved those records. The recorded **Evidence needed** decision and its reason survived in every profile.

The release fixtures omit optional notes. A nonempty note was saved with **Save review** in each of the five scenarios with an editable note field. All five notes survived reload. The altered-original case correctly retained its empty note. A seventh fresh profile imported a copy of that same altered case with only the optional note field added, using a note exported through the dashboard. Its original receipt still failed, and the saved note and decision were both visible in the read-only view after reload.
