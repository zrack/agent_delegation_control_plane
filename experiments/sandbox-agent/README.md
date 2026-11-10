# Sandboxed agent validation pilot

An optional, caller-owned Agents SDK workflow: **Coder → Verifier**. Coder writes
Python and calls a fixed invoice-calculation tool. The application executes that
code in Docker; Verifier calls a deterministic checker against withheld expected
integers and the actual output bytes. Neither agent decides whether its work passed.

**Observed:** three live runs passed exact output checks. Their saved programs
also passed the final hardened executor without further model calls. Read the
[validation report](../../docs/SANDBOX_VALIDATION.md) for case results, tested
controls, evidence inventory and the distinction between live runs and rechecks.

## Design basis

The existing viewer is retrospective, with completed-action version 1 imports.
The existing SDK environment and model are retained. This pilot adds a narrow
execution gateway and independent grader; it does not turn imported records into
trusted credentials or a general authorization service. An ordinary SDK domain
tool fits this one-shot, fixed-input/output operation; a general shell, persistent
SDK sandbox workspace and arbitrary filesystem tools are not exposed to the model.

The gateway binds the actual SDK role and call ID to an application-issued grant.
It checks exact action/resource, actor, validity and one action per role before
side effects. Handoff issues a narrower verifier grant. Denials are recorded in
attempt receipts, never fabricated as completed events. Completed runs produce
an `investigation.json` accepted by the existing dashboard.

## Run the controls

Requires Docker running, Python 3.12+, Node 22+ and the existing optional SDK
dependencies. From the repository root:

```sh
docker build --network=none -t adcp-invoice-sandbox:v1 experiments/sandbox-agent
ADCP_SANDBOX_IMAGE=adcp-invoice-sandbox:v1 python -m unittest discover -s experiments/sandbox-agent -p 'test_*.py' -v
python scripts/check.py --with-sdk --with-sandbox
```

Use the Python interpreter from your SDK environment. These commands make **no
model calls**. The full application checker runs 80 tests, including 17 sandbox
checks. Without the explicit image environment variable, direct unittest discovery
skips the ten real-container checks. CI builds the image and enables those checks.

The tests cover actual physical output, SDK replay and handoff, wrong-role and
expired/out-of-scope denial before execution, wrong/changed results, missing or
reordered receipts, exact authority pairs, unsafe archive links/paths, no outbound
socket, writes outside the workspace, timeout, output flood, memory exhaustion,
workspace exhaustion, input changes and resource cleanup. They also confirm the
dashboard classifies derived over-grant and missing-grant evidence correctly.
Those derived records are test mutations, not claims of actual unauthorized execution.

## Run a bounded live pilot

Only use fictional inputs and a separately approved ignored project key. The runner
requires an owner-only project-root `.env.local`; it refuses symlinks and unsafe
permissions. It never copies that key, the repository or host files into Docker.
Live calls may consume provider credits; the default model remains `gpt-6-astra`.

```sh
mkdir -p output
python experiments/sandbox-agent/pilot.py --live --runs 3 --output output/new-sandbox-pilot
```

The output directory must be new and under ignored `output/`. The runner first executes the complete offline
control suite, then makes up to three independent live runs, with six requests and
1800 output tokens per request maximum, no provider retries, a 35-second request
timeout and 150 seconds per case. A failed run is recorded and exits nonzero;
there is no scripted replacement for missing model output. Omit `--live` for
offline controls only. Never commit generated run records.

## Check a completed invoice run offline

Keep a complete, within-scope invoice export in a private baseline directory. From
the repository root, replace `output/previous-pilot/invoice-a` below with the path
to your chosen completed case:

```sh
mkdir -m 700 output/invoice-regression-baseline
install -m 600 output/previous-pilot/invoice-a/investigation.json output/invoice-regression-baseline/investigation.json
node scripts/regression.mjs pin --baseline-dir output/invoice-regression-baseline
```

Pinning writes `pin.json` with the run ID and a fingerprint of the normalized
investigation. To replace a baseline, use a new directory and pass `--baseline-dir`
to the pilot. The default is `output/invoice-regression-baseline`. After every
completed case the pilot saves `regression.json`, writes `review-package.json`
with the matching exports, and prints the regression status and whether the package
was saved. The pilot exit status still reports execution and invoice validation.
Inspect the separate regression verdict to decide whether to proceed with a candidate.

To check a previously completed run, use Node 22+:

```sh
node scripts/regression.mjs check --baseline-dir output/invoice-regression-baseline \
  --candidate output/previous-pilot/invoice-b/investigation.json \
  --package output/invoice-b-review-package.json
```

The command prints a JSON report. Exit codes are `0` for **No regression found**,
`1` for **Regression detected**, `2` for **Needs review**, and `3` for command
errors. `--package` is optional and requires a new path. If writing the package
fails, the command prints the regression report and exits `3`. A missing or changed
baseline requires review, and the package includes only matching evidence. To
inspect evidence and save review notes, open **Regression inbox** in the local
dashboard and select the package under **Import review package**. The check needs
no model, API key or Docker.

## Isolation and evidence

The Dockerfile pins the official Python base by digest. Runtime freezes the built
image's immutable local ID. Each execution uses a new container, non-root job UID
65534, no network/ports/host mounts/socket/credentials, a read-only root filesystem,
all capabilities dropped, no-new-privileges, 128 MiB memory with no additional swap,
half a CPU, 32 processes, a 2-second per-process CPU limit, a 5-second execution
deadline, 16 KiB combined output, 64 KiB per-file limit and a 4 MiB tmpfs workspace.
The controller checks the effective Docker configuration before starting the job.

A fixed non-root collector with a different UID reads only `results.json` and
`invoices.csv` into a bounded tar stream. Job processes cannot replace its stdout
through same-UID process file descriptors. Files must be regular, readable by the
collector and at most 32 KiB; links, extra paths and extraction onto the host are
rejected. The artifact is checked independently and the input must be unchanged.
The container is frozen after collection and forcibly removed on success/failure.
No named volumes survive execution. Collection is not a general atomic filesystem
snapshot; background mutation can cause collection/validation to fail.

Private outputs include generated code, exact input/expected/results, execution
controls and status, actual SDK response/call references and usage, receipt chain,
attempts, validation, importable investigation and file hashes. The top-level run
also saves offline test output and isolation evidence. Hashes detect changes against
a saved baseline; a producer that replaces the baseline is not authenticated.

This is a named fictional workload, not a sandbox escape audit, multi-tenant
service, general live delegation enforcement, complete-capture proof or statistical
production reliability result. Docker's engine remains trusted; keep Docker and the
digest-pinned base updated. Starting Docker is operator-managed; test containers
are cleaned, while the local image and Docker application remain available.
