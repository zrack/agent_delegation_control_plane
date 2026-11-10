#!/usr/bin/env python3
"""Offline checks for the standalone source package; never starts a live model."""
import argparse
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--with-sdk", action="store_true", help="Also run two offline SDK replay tests using this Python environment")
parser.add_argument("--with-sandbox", action="store_true", help="Also run real Docker isolation and sandbox SDK replay checks; requires --with-sdk and a prebuilt image")
args = parser.parse_args()
if args.with_sandbox and not args.with_sdk:
    parser.error("--with-sandbox requires --with-sdk")
checks = [("syntax " + path.name, ["node", "--check", str(path.relative_to(ROOT))])
          for path in sorted((ROOT / "src").iterdir()) if path.suffix in {".js", ".mjs"}]
checks += [
    ("domain", ["node", "--test", "tests/evaluator/evaluator.test.mjs", "tests/evaluator/comparison.test.mjs"]),
    ("browser-local persistence", ["node", "--test", "tests/evaluator/storage.test.mjs"]),
    ("offline regression command", ["node", "--test", "tests/evaluator/regression.test.mjs"]),
    ("regression review inbox", ["node", "--test", "tests/evaluator/review.test.mjs"]),
    ("private alpha rehearsal kit", ["node", "--test", "tests/evaluator/alpha-rehearsal.test.mjs"]),
    ("loopback HTTP", [sys.executable, "-m", "unittest", "discover", "-s", "tests/evaluator", "-p", "test_server.py", "-v"]),
    ("import and controlled capture", ["node", "--test", "integrations/openai-agents/import.test.mjs", "experiments/controlled-capture/capture.test.mjs"]),
]
if args.with_sdk:
    checks.append(("offline SDK replay", [sys.executable, "-m", "unittest", "discover", "-s", "integrations/openai-agents", "-p", "test_*.py", "-v"]))
if args.with_sandbox:
    os.environ.setdefault("ADCP_SANDBOX_IMAGE", "adcp-invoice-sandbox:v1")
    checks.append(("sandbox isolation and offline SDK replay", [sys.executable, "-m", "unittest", "discover", "-s", "experiments/sandbox-agent", "-p", "test_*.py", "-v"]))
failed = []
for name, argv in checks:
    print("Check: " + name, flush=True)
    try:
        result = subprocess.run(argv, cwd=ROOT, timeout=120, check=False)
        if result.returncode:
            failed.append(name)
    except (OSError, subprocess.TimeoutExpired):
        failed.append(name)
if failed:
    print("Failed check groups: " + ", ".join(failed), file=sys.stderr)
    raise SystemExit(1)
print("All selected offline check groups passed. No live model request was made.")
