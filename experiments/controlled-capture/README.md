# Controlled local capture experiment

This separate engineering experiment executes local file operations through three scripted roles in one process. Data, identities and grants are fictional. It uses the existing evaluator without changing the fixed-fixture dashboard or adding ingestion.

With Node 22 or newer, run from the repository root:

```sh
node --test experiments/controlled-capture/capture.test.mjs
node experiments/controlled-capture/run.mjs --output /absolute/path/to/a/new-run-directory
```

The parent directory must exist; the run directory must not exist. An existing run is rejected. A failed run can leave partial output for diagnosis; select a new directory for retry. Only the generated fictional account is read/exported; no network, credentials or external packages are used.

Each branch preserves `account.json`, original `grants.jsonl` and `events.jsonl`, `normalized.json`, `mapping.json` and `evaluation.json`. The export-expansion branch also creates `account-export.json`. `REPORT.md` summarizes results, and `manifest.json` hashes all other output files and identifies the runner/evaluator bytes and Node version; the command prints the manifest hash separately. The manifest is an integrity inventory, not a signature or an authenticated chain of custody.

The missing-grant branch deliberately omits a preserved source grant from the normalized investigation. This measures disclosed incomplete capture, not unexpected production log loss. The export occurs locally despite its invalid fictional authority; the evaluator explains it afterward and never blocks it. All roles are scripted, not autonomous model agents or MCP/A2A participants.

The separate tests check source replay, physical export contents, missing-record propagation, manifest digests, unchanged reevaluation, input rejection and preservation of existing output. These engineering checks do not establish independent operator usefulness, live prevention or customer demand.

## Architecture boundary

This scripted runner is a separate producer in the [current architecture](../../ARCHITECTURE.md) and [C4 container view](../../docs/architecture/diagrams/c4-containers.svg). The actual model-agent workflow is documented [separately](../../integrations/openai-agents/README.md). Controlled runs emit bare `normalized.json` evaluator input, not the version 1 envelope required by the browser importer. Inspect/evaluate those files offline; a wrapper/adapter would be separate work. The SDK runner emits the importable `investigation.json`. Raw capture files and manifests stay local and are not served by the dashboard. Neither path establishes authenticated authority or production enforcement.
