# Privacy and sharing records

Built-in examples and generated account tasks are fictional. Their displayed names and identifiers are not customer records. The current tree contains no saved provider runs, private owner records, credentials or personal contact details. Retained source history is filtered to reviewed code/test/diagram paths and public-safe commit identities. Copyright attribution is retained in NOTICE.

The browser reads an explicitly selected local file, evaluates it locally, and makes no outbound connection. Normalized runs and evidence are saved in browser localStorage across reloads, with a 20-run / 2 MiB total limit. This is unencrypted application storage accessible to the same browser profile/origin and local privileged software; use fictional or minimized records, especially on shared computers. **Clear imported runs** removes saved dashboard copies and the current tab's imports, leaving original export files unchanged. Other open tabs may still hold loaded copies. Browser site-data controls also remove saved copies. Private browsing, storage eviction or changing browser profile/host/port can make runs unavailable; keep the original exports as your backup. Source labels and hashes do not authenticate identity or complete capture. Imported text can still contain sensitive content; inspect and minimize it before selecting or sharing a file. The local development server is not a multi-user or internet-facing service.

The optional SDK runner alone reads the ignored `.env.local` key and sends generated fictional task content and tool results to OpenAI. SDK trace export is disabled and response storage requested off. New executions may consume provider credits. Do not replace fictional input with personal or customer data without an appropriate separate review.

The regression inbox keeps its own copies of matching exports, report reasons, decisions, follow-up evidence and review notes in the same browser profile and origin. **Remove from inbox** deletes the selected report and its local evidence, follow-up, decision and notes. **Clear imported runs** applies only to the separate investigation list. Browser site-data controls clear both collections. Use fictional or minimized evidence and notes.

The Codex folder picker reads and checks the seven manifest-listed pilot files
locally. The saved investigation retains normalized action and grant records,
tool names, call IDs, and artifact hashes. Selecting **Compare and save to
inbox** additionally stores exact bytes of
`actions.jsonl`, `grants.jsonl`, `attempts.jsonl`, `before.md` and `after.md` in
the local inbox. These can contain source text and tool metadata. The diff
and raw Codex event stream stay in the original folder. The inbox keeps their
import-time hashes. Attaching a corrected folder saves the same five files
from that folder alongside the original evidence. Both snapshots count toward
the inbox's 2 MiB limit. By default a Codex case download contains the original
normalized evidence and saved decision. **Include Codex receipts in case
download** adds the five saved files and seven digests for the original and any
verified follow-up, plus any currently verified closure. Inspect both sets of
ledgers and Markdown files before sharing. The diff and raw event stream are
represented by digests only. **Include saved review note** is independent of
receipt export. Both options start unchecked and reset after download.
Importing a receipt case stores the included evidence in the recipient’s inbox.
Selecting **Pin included baseline** also saves the baseline in that browser’s
investigation list and creates the missing workflow pin.

To share how you repaired a Codex case, select **Include Codex receipts in case
download**, then **Include sender repair history**. This additional checkbox
starts unchecked. It shares up to the 100 most recent eligible events from this
profile. Repairs include times, receipt names, and before and after digests.
Explicit closures identify the baseline and must refer to the attached follow-up.
The previous receipt contents and reviewer identity are omitted.

In the receiving profile, **Sender-reported history** describes the sender’s
actions. The receiver can compare the restored digest with the included
receipt. The earlier digest is the sender’s observation. Importing the case
creates no local repair or closure event, and a later export can share only
actions recorded in the exporting profile. The receiver’s closure check still
requires matching receipts, a passing follow-up, a verified closure record,
and a matching local pin. **Remove from inbox** deletes the case, both histories,
and its receipt snapshots from that profile.

The invoice-folder preview reads the manifest and up to six named files. **Compare and save to inbox** stores the baseline and candidate, the relevant manifest digests, and exact bytes of the selected allowlisted files within the existing 20-report / 2 MiB inbox limit. These files can include execution logs inside the execution receipt. The browser rechecks saved bytes against the supplied manifest, which provides no independent source authentication. An invoice follow-up adds a second receipt snapshot within the same limit. **Remove from inbox** clears both saved receipt snapshots and the local closure record. Ordinary invoice case downloads carry the original delegation evidence and case decision. Selecting **Include invoice receipts in case download** also includes the receipt bytes, matching follow-up, and verified closure. Review the contents before sharing, especially the execution receipt, which can contain logs. The receipt and note options are independent and reset after download.

A downloaded review package is a separate local file containing the report and matching normalized investigation evidence. A review case download can also include the decision and its reason, the matching follow-up report and evidence, and the verified closure. The saved review note is included only when selected. Inspect the contents before handing either file to a reviewer. Downloads and other copies remain on disk when the inbox entry is removed.

Local run directories may contain provider/request/tool identifiers, generated text, source mappings and usage metadata. Keep them outside source control, inspect them before sharing and define retention/deletion for any future real-data workflow. Do not upload `.env.local`, virtual environments, screenshots, raw captures or failure payloads to an issue. A sanitized source package does not sanitize future user-supplied records.

This repository distributes the public technical alpha and fictional examples. The original repository and its historical records are private. For new public releases, review the exact source revision, assets, commit metadata and new GitHub-hosted records. Keep raw runs, backups and private evidence outside the public repository. See the [release checklist](RELEASE_READINESS.md#checklist-for-future-public-prereleases).

Local privacy checks and tests cover the cases they exercise. Their scope is limited to the reviewed source and artifacts.

Inbox filters remember the selected workflow name, decision category and
closure filter in this tab’s session storage. Case evidence, notes and decisions
continue to use the existing bounded inbox store. Clearing the filters removes
the workflow name from the tab’s preferences.
