#!/usr/bin/env python3
"""Check selected source only; never inspect ignored configuration or Git history."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, timeout=30)


def reviewed_fixture_findings(snapshot, output):
    """Recognize only the individually reviewed findings on byte-identical fictional data."""
    try:
        registry = (snapshot / "scripts/security/reviewed-fixtures.txt").read_text().splitlines()
        reviewed = {}
        for line in registry:
            if not line or line.startswith("#"):
                continue
            name, file_digest, findings_digest = line.split()
            reviewed[name] = (file_digest, findings_digest)
        results = json.loads(output)["results"]
        if not results:
            return False
        for name, findings in results.items():
            if (PurePosixPath(name).parent.as_posix() not in {"docs/codex-handoff/fixtures", "docs/producer/examples"}
                    or name not in reviewed or not findings):
                return False
            if any(f["type"] not in {"Hex High Entropy String", "Base64 High Entropy String"} for f in findings):
                return False
            signatures = sorted((f["line_number"], f["type"], f["hashed_secret"]) for f in findings)
            encoded = json.dumps(signatures, separators=(",", ":")).encode()
            current = (hashlib.sha256((snapshot / name).read_bytes()).hexdigest(), hashlib.sha256(encoded).hexdigest())
            if current != reviewed[name]:
                return False
        return True
    except (AttributeError, KeyError, OSError, TypeError, ValueError):
        return False


def run(label, args, cwd, *, quiet=False):
    print("Security check: " + label, flush=True)
    try:
        result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=180, check=False)
    except (OSError, subprocess.TimeoutExpired):
        print(label + " could not complete; check tool installation/access.", file=sys.stderr)
        return False
    if not quiet:
        print(result.stdout, end="")
        print(result.stderr, end="", file=sys.stderr)
    elif result.returncode == 1 and not result.stderr and reviewed_fixture_findings(cwd, result.stdout):
        print("Only previously reviewed public fixture digests and receipt encodings matched.")
        return True
    elif result.returncode:
        # Secret scanners may include source text. Never copy their output to CI logs.
        print("Secret scan failed. Inspect locally with detect-secrets-hook --no-verify; no candidate values were logged.", file=sys.stderr)
    return result.returncode == 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staged", action="store_true", help="Inspect exact staged bytes, for the pre-commit hook")
    parser.add_argument("--advisories", action="store_true", help="Query PyPI advisories for pinned package names/versions")
    args = parser.parse_args()
    selection = [] if args.staged else ["--cached", "--others", "--exclude-standard"]
    files = git("ls-files", "-z", *selection).decode().split("\0")
    files = sorted(set(name for name in files if name))
    with tempfile.TemporaryDirectory(prefix="adcp-security-") as directory:
        snapshot = Path(directory)
        selected = []
        for name in files:
            relative = PurePosixPath(name)
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError("Unsafe repository path")
            source = ROOT / name
            if not args.staged and not source.exists():
                continue  # A worktree deletion is not part of the candidate.
            if not args.staged and source.is_symlink():
                raise ValueError("Source symlinks are not scanned")
            data = git("show", ":" + name) if args.staged else source.read_bytes()
            destination = snapshot / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            selected.append(name)
        if not selected:
            raise ValueError("No source selected")
        # Execute modules from the caller's hash-verified environment, not the snapshot.
        passed = run("secret patterns (offline, current source)",
                     [sys.executable, "-m", "detect_secrets.pre_commit_hook", "--no-verify", "--json", "-c", "2", *selected], snapshot, quiet=True)
        python_files = [name for name in selected if name.endswith(".py")]
        if python_files:
            passed = run("Python static security (medium/high)",
                         [sys.executable, "-m", "bandit", "-q", "-ll", *python_files], snapshot) and passed
        if args.advisories:
            for path in ["integrations/openai-agents/requirements.txt", "scripts/security/requirements.txt"]:
                passed = run("dependency advisories: " + path,
                             [sys.executable, "-m", "pip_audit", "--strict", "--disable-pip", "--require-hashes",
                              "--progress-spinner", "off", "--timeout", "20", "-r", path], snapshot) and passed
        return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
