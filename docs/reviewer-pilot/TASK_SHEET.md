# Review the handoffs

Work through the numbered folders in the order below. Each folder contains a completed fictional coding-agent case. Your task is to decide whether the recorded closure holds for this receiver. Leave the original files, case state and pin as you found them.

For each decision, identify the original editor action, the relevant grant or missing reference, and the receipt and stage that support your conclusion. Explain whose repair or closure history you can see and what the receiver did locally. If you cannot establish the result, say where you stopped. Tell the observer when you have an answer or need help.

**Ordinary review.** Inspect `case.json` with your usual local record-review tools. The sender's report and saved closure are claims to check. If present, `receiver-records/` contains the separately supplied receiver investigation and pin. An absent directory means this receiver has no pin. You can decode retained receipts, hash their bytes and compare the records with the pin using local tools. Leave ADCP's dashboard, verifier and answer key closed during this round.

**Dashboard review.** Start the checkout with `python3 scripts/serve.py`. Use a fresh browser profile for every round. When the task includes `receiver-capture/`, import it under **Investigate a run → Import a Codex run folder**, select the imported baseline in **Compare runs**, and save it under `Follow-up review`. Otherwise begin with an empty profile. Import `case.json` into **Regression inbox**, reload, and inspect its evidence before stating your decision.

| Task | Review method |
| --- | --- |
