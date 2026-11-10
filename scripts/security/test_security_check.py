"""Exercise real security tools against temporary, fictional candidate repositories."""
import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("security_check", Path(__file__).resolve().parents[1] / "security_check.py")
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)


class SecurityCheckContract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="adcp-security-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        # A recognizable marker, deliberately no key material. Assemble it so the
        # regression fixture itself does not look like a committed credential.
        self.marker = "-----BEGIN " + "RSA PRIVATE KEY-----"

    def git(self, *args):
        subprocess.run(["git", *args], cwd=self.root, capture_output=True, check=True, timeout=30)

    def check(self, *args):
        output = io.StringIO()
        with patch.object(CHECK, "ROOT", self.root), patch.object(sys, "argv", ["security_check", *args]), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            status = CHECK.main()
        self.assertNotIn(self.marker, output.getvalue(), "candidate secret values must never enter logs")
        return status

    def test_harmless_source_passes_and_ignored_local_configuration_is_not_read(self):
        (self.root / ".gitignore").write_text(".env.local\n")
        (self.root / ".env.local").write_text(self.marker)
        (self.root / "safe.py").write_text("value = 1\n")
        self.git("add", ".gitignore", "safe.py")
        self.assertEqual(self.check(), 0)
        self.assertEqual(self.check("--staged"), 0)

    def test_secret_marker_in_new_candidate_source_fails(self):
        (self.root / "candidate.txt").write_text(self.marker)
        self.assertEqual(self.check(), 1)

    def test_staged_secret_is_rejected_even_when_worktree_is_clean(self):
        candidate = self.root / "candidate.txt"
        candidate.write_text(self.marker)
        self.git("add", "candidate.txt")
        candidate.write_text("harmless working copy\n")
        self.assertEqual(self.check(), 0)
        self.assertEqual(self.check("--staged"), 1)

    def test_python_unsafe_deserialization_is_rejected(self):
        (self.root / "candidate.py").write_text("import pickle\npickle.loads(b'example')\n")
        self.assertEqual(self.check(), 1)


if __name__ == "__main__":
    unittest.main()
