# Browser acceptance tests

Run this suite on a development machine with Python 3.11+ and Node 22+. Install the pinned test dependency and its Chromium headless shell once.

```sh
npm ci --prefix tests/browser --ignore-scripts --no-audit --no-fund
node tests/browser/node_modules/playwright-core/cli.js install --only-shell chromium
python3 tests/browser/run.py
```

The runner builds the fictional handoff ZIP, extracts it in a temporary directory, starts the normal dashboard on an available loopback port, and drives imports, downloads, repair, explicit closure and reload in isolated browser profiles. To test an already extracted release candidate, pass its kit directory to `--kit`. All profiles and downloads are temporary. Browser requests to other origins fail the suite.

The receiver tests read every scenario in the kit's separate facilitator key. Failure output identifies the scenario and expected and observed disposition. One check deliberately expects a changed receipt to verify as resolved and confirms the same comparison rejects that expectation. The pull-request job runs against the extracted ZIP, with no live model or credentials.
