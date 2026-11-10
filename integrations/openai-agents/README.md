# Optional actual model-agent workflow

Three OpenAI Agents SDK agents perform a generated fictional account review: Coordinator reads, Researcher reads after a handoff, and Reporter saves a model-written summary after the second handoff. Local application-issued grants are captured; they are not external IAM or cryptographic identity.

Requires Python 3.12+, Node 22+ and separate provider access. The viewer needs no key or packages. From the package root:

```sh
python3.12 -m venv integrations/openai-agents/.venv
integrations/openai-agents/.venv/bin/python -m pip install --require-hashes --only-binary=:all: -r integrations/openai-agents/requirements.txt
integrations/openai-agents/.venv/bin/python scripts/check.py --with-sdk
```

The last command is offline. Configure your own project-root `.env.local` from `.env.example`, using a private file with restrictive permissions (for example `chmod 600 .env.local` on Unix). Never put a key in source, command arguments, screenshots or investigation exports. No credential is included in this candidate.

A deliberate live execution may consume provider credits:

```sh
integrations/openai-agents/.venv/bin/python integrations/openai-agents/run.py --smoke --output /path/to/new-smoke-directory
integrations/openai-agents/.venv/bin/python integrations/openai-agents/run.py --output /path/to/new-workflow-directory
```

Choose a new directory under an existing parent each time; existing directories are refused. The explicit model is `gpt-6-astra`. Limits are ten turns/requests, 1200 output tokens per request, 35-second provider timeout and 150 seconds overall. Provider retries and trace export are disabled; responses request `store=False`. These bounds are not a fixed monetary price. Only generated fictional task content and tool results are sent to OpenAI. No general shell, arbitrary-path filesystem or external messaging tools are offered.

Success saves `account.json`, raw `capture.jsonl`, `investigation.json`, `mapping.json`, model-written `summary.txt`, `result.json` and a hash manifest with usage, versions and source fingerprints. Real SDK callbacks bind response/tool-call IDs, grants, role, parent action and artifact hashes. Hashes do not authenticate identities or prove complete capture. Failed calls save safe metadata in `failure.json`; preserve partial evidence and use a new directory to retry. There is no scripted substitute for a failed live run.

Start the viewer from the root README, choose **Import a completed run**, and select `investigation.json`. The normalized run and evidence are saved in this browser across reloads (20 runs / 2 MiB total), without upload. Use **Clear imported runs** to remove dashboard copies; keep original exports as backups. A visible saving failure means the new import lasts only until reload. Imported provenance remains an unverified source claim. Quota/authentication failures require checking your own provider access before retrying; viewing saved records needs no new model request.

The two SDK tests use a deterministic replay model and establish wiring, not live provider execution or operator value. Read the [architecture](../../ARCHITECTURE.md) and [privacy guidance](../../docs/PRIVACY.md) before sharing any generated artifacts. No saved provider run, account identifier or API key is distributed.
