# Walkthrough for the unexpected export

Use this fictional case to review an agent's authority and check whether a
corrected run supports closing the case. The demo ZIP contains two ready-to-import
JSON files and this walkthrough.

## Start the dashboard

1. Download **Source code (zip)** from the
   [v0.1.0-alpha.1 release](https://github.com/zrack/agent_delegation_control_plane/releases/tag/v0.1.0-alpha.1)
   and extract it. Extract the demo ZIP separately.
2. With Python 3.11 or newer, run this command from the extracted source folder.

   ```sh
   python3 scripts/serve.py
   ```

3. Open the printed address in a fresh browser profile. If the default port is
   busy, add `--port 48732` to the command. Keep the same address and profile for
   the reload check. The prebuilt files let you complete the exercise with Python
   and a browser.

## Review the original case

1. Open **Regression inbox** and select **Import review package or case** on
   current `main` or **Import review package** in the alpha release. Choose
   `case-02.json` from the extracted demo ZIP. The inbox should show **Current
   evidence check · Regression detected**.
2. Under **Flagged findings**, expand **Export agent** with the message “The
   candidate recorded an authority violation.” Event `CH-002-e3` records
   `account:export` on `crm://accounts/northstar` on behalf of `user:avery`.
   The action uses `CH-002-g3`, whose parent `CH-002-g2` grants `account:read`
   on that resource. The export exceeds the parent grant.
3. Under **Review decision and follow-up**, choose **Fix required**. Enter a
   reason such as “The export exceeds the parent grant's read-only scope” and
   select **Save decision**. The case stays **Open**.

## Verify the follow-up and close

1. Use **Attach follow-up package** to choose `follow-up-02.json`.
2. Expand **Inspect follow-up evidence**, then **Follow-up actions and grants**.
   The follow-up uses the original baseline, and its final action and grant use
   `account:read`. The follow-up should show **Rechecked · No regression found**
   while the original run still shows **Rechecked · Regression detected**.
3. Select **Close as resolved** and confirm the **Resolved** badge appears.
4. Reload the page in the same browser profile. Confirm that **Fix required**,
   the saved reason, both evidence checks, and **Resolved** are still visible.

The dashboard keeps the decision and closure in the local browser profile.
