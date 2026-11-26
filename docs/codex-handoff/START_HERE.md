# Fictional Codex reviewer handoff

Open **reviewer/TASK_SHEET.md** first. It shows how to start the local dashboard, review a portable case, and reproduce the handoff after reload. Use a checkout that includes opt-in sender history. The cases describe a fictional single-file quickstart edit.

The kit contains two raw Codex capture folders for pinning in the dashboard. The matching and conflicting baseline records under `receiver-baselines/` are for offline tools. A recipient chooses their baseline independently of the case. The `donors/` files are for repair previews. Keep the `facilitator/` directory with the person scoring the exercise.

The release candidate and the original public alpha.15 fixture are distinct. The matching donor and matching pin files are copies from the [published alpha.15 demo](https://github.com/zrack/agent_delegation_control_plane/releases/download/v0.1.0-alpha.15/adcp-codex-repair-history-demo-v0.1.0-alpha.15.zip). The receiver variants use the same fictional records, with the review actions and changes described in the facilitator key.

## Rebuild offline

In the source checkout, run the following with Python 3.11+ and Node 22+. Choose a new output directory for each build.

```sh
python3 scripts/build_codex_handoff.py --output output/handoff-first
python3 scripts/build_codex_handoff.py --output output/handoff-second
```

The ZIP and its adjacent checksum are at the top of each output directory. Compare the SHA-256 values. Inside the ZIP, `SHA256SUMS` covers every other kit file, including the answers and both receiver baselines. From the extracted kit directory, run `shasum -a 256 -c SHA256SUMS` on macOS or `sha256sum -c SHA256SUMS` on Linux. A passing digest check establishes agreement with the supplied manifest. The reviewer still needs a trusted way to obtain the receiver pin.
