# Contributing

Use fictional examples and preserve the evaluator's explicit uncertainty, deterministic action-time checks and exact action/resource semantics. Review architecture and source before changing a boundary. Keep source, documentation and editable/rendered diagrams consistent.

Run `python3 scripts/check.py`. If integration code changes, install the pinned optional dependencies and run the same checker with `--with-sdk` from that environment. These tests are offline; running a live model is a separate deliberate action requiring provider access and possible spending. Include the relevant test result and any unresolved limitation in a contribution.

For sandbox changes, build the digest-pinned image as described in the [pilot guide](experiments/sandbox-agent/README.md), then run `python scripts/check.py --with-sdk --with-sandbox`. This includes real Docker isolation tests and no model calls. Preserve the fixed Docker argument boundary and keep expected values independent of generated code.

Never commit local keys, real investigation exports, generated run directories or screenshots. Choose a public-safe author identity/email for commits. Repository publication, service deployment, license changes and private-data use require maintainer decisions.

## Security checks

Use a separate environment so security tooling does not change the SDK environment:

```sh
python3 -m venv .venv/security
.venv/security/bin/python -m pip install --require-hashes --only-binary=:all: -r scripts/security/requirements.txt
.venv/security/bin/python scripts/security_check.py
.venv/security/bin/python -m unittest discover -s scripts/security -p 'test_*.py' -v
.venv/security/bin/python scripts/security_check.py --advisories
```

The first check runs offline secret-pattern detection with verification disabled and Python static security checks for medium/high findings. It scans tracked and nonignored candidate source in a temporary snapshot, not ignored local configuration or history. Candidate secret values are suppressed from output. Advisory checks query PyPI with dependency names/versions and fail when collection or network checks cannot complete; they never run a model. These checks do not replace review, JavaScript security analysis, credential rotation or a historical secret audit.

To check exact staged bytes before committing, opt in to the repository hook:

```sh
git config core.hooksPath scripts/hooks
export ADCP_SECURITY_PYTHON="$PWD/.venv/security/bin/python"
```

Keep that environment available when committing. Alternatively run the security checker with `--staged` explicitly. The hook checks the index, so cleaning only an unstaged working copy cannot hide a secret already staged. Hooks can be bypassed locally; required CI checks provide the shared gate. Never suppress a real credential as a false positive.

Both requirements files pin package versions and SHA-256 distribution hashes. Review dependency changes before merging; hashes establish correspondence, not package trust. Regenerate the security-tool lock after changing `scripts/security/requirements.in`, for example with `uv pip compile --python-version 3.12 --generate-hashes --no-header --no-annotate scripts/security/requirements.in -o scripts/security/requirements.txt`. For SDK updates, keep every resolved dependency pinned and hashed, test a fresh binary-only installation and run offline replay. Dependabot covers both Python directories and Actions; there is no automatic merge policy.

## Main branch

Use a pull request and require both `project-integrity` and `security` checks, with the branch current against main. Protect against force pushes/deletion and require resolved review conversations. This is the selected policy for a sole maintainer; add an independent approving-review requirement when another reviewer joins. Workflow files document checks but do not themselves enable GitHub branch protection. Confirm hosted settings separately; keep the repository private until publication is explicitly approved.
