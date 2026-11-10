"""Offline policy/oracle checks and opt-in real container/SDK-replay controls."""
import asyncio
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

from agents import RunConfig, Usage, set_tracing_disabled
from agents.items import ModelResponse
from agents.models.interface import Model
from openai.types.responses import ResponseFunctionToolCall, ResponseOutputMessage, ResponseOutputText

from cases import CASES, CONTROL_PROGRAM
from contract import ROOT, Authority, Trial, check_artifact, check_receipts, evaluate
from pilot import make_workflow, run_case
from sandbox import DockerSandbox, MAX_OUTPUT, SandboxLimit, command, regular_artifact


class PolicyContract(unittest.TestCase):
    def test_identity_exact_capability_pairs_and_exclusive_expiry(self):
        now = datetime.now(timezone.utc)
        grant = Authority("Coder", (("code:execute", "sandbox:a"), ("artifact:verify", "artifact:b")), now, now + timedelta(seconds=1))
        self.assertTrue(grant.permits("Coder", "code:execute", "sandbox:a", now))
        for actor, action, resource, at in [("Other", "code:execute", "sandbox:a", now),
                ("Coder", "code:execute", "artifact:b", now), ("Coder", "code:execute", "sandbox:ab", now),
                ("Coder", "code:execute", "sandbox:a", grant.expiry)]:
            self.assertFalse(grant.permits(actor, action, resource, at))

    def test_denials_happen_before_code_or_sandbox_side_effects(self):
        class NeverExecute:
            def execute(self, *args, **kwargs):
                raise AssertionError("Denied operation reached execution")
        with tempfile.TemporaryDirectory() as temporary:
            trial = Trial(Path(temporary), CASES[0], NeverExecute())
            with self.assertRaises(PermissionError): trial.execute("Verifier", "wrong-actor", CONTROL_PROGRAM)
            trial.authority = replace(trial.authority, expiry=datetime.now(timezone.utc) - timedelta(seconds=1))
            with self.assertRaises(PermissionError): trial.execute("Coder", "expired", CONTROL_PROGRAM)
            self.assertFalse((Path(temporary) / "program.py").exists())
            self.assertEqual(trial.events, [])
            self.assertTrue(all(attempt["outcome"] == "denied" for attempt in trial.attempts))
            with self.assertRaises(ValueError): trial.export("offline-control")
            bounded = Path(temporary) / "bounded"
            bounded.mkdir()
            fresh = Trial(bounded, CASES[0], NeverExecute())
            with self.assertRaises(ValueError): fresh.execute("Coder", "oversized", "x" * 12001)
            self.assertFalse((bounded / "program.py").exists())

    def test_forbidden_resource_is_denied(self):
        with tempfile.TemporaryDirectory() as temporary:
            trial = Trial(Path(temporary), CASES[0], None)
            with self.assertRaises(PermissionError):
                trial.authorize("Coder", "code:execute", "host-filesystem:any", "out-of-scope")
            self.assertEqual(trial.events, [])
            trial.authorize("Coder", "code:execute", trial.resource, "first-allowed")
            with self.assertRaises(PermissionError):
                trial.authorize("Coder", "code:execute", trial.resource, "second-in-flight")

    def test_oracle_rejects_wrong_numbers_types_and_changed_artifact(self):
        expected = CASES[0]["expected"]
        actual = json.dumps(expected).encode()
        digest = sha256(actual).hexdigest()
        self.assertTrue(check_artifact(actual, expected, digest)["passed"])
        self.assertFalse(check_artifact(actual + b" ", expected, digest)["passed"])
        duplicate = actual[:-1] + b',"invoice_count":4}'
        self.assertFalse(check_artifact(duplicate, expected, sha256(duplicate).hexdigest())["passed"])
        for values in [{**expected, "total_cents": 0}, {**expected, "invoice_count": True},
                       {**expected, "tax_cents": float(expected["tax_cents"])}, {**expected, "extra": 1}]:
            data = json.dumps(values).encode()
            self.assertFalse(check_artifact(data, expected, sha256(data).hexdigest())["passed"])

    def test_missing_changed_or_reordered_receipts_fail_the_frozen_baseline(self):
        with tempfile.TemporaryDirectory() as temporary:
            trial = Trial(Path(temporary), CASES[0], None)
            trial.note("example", value=1)
            root = trial.records[-1]["digest"]
            self.assertTrue(check_receipts(trial.records, root))
            self.assertFalse(check_receipts(trial.records[:-1], root))
            self.assertFalse(check_receipts(list(reversed(trial.records)), root))
            changed = json.loads(json.dumps(trial.records))
            changed[-1]["value"] = 2
            self.assertFalse(check_receipts(changed, root))

    def test_untrusted_artifact_links_and_paths_are_never_extracted(self):
        for name, kind in [("results.json", tarfile.SYMTYPE), ("results.json", tarfile.LNKTYPE),
                           ("../results.json", tarfile.REGTYPE), ("/results.json", tarfile.REGTYPE)]:
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode="w") as archive:
                item = tarfile.TarInfo(name); item.type = kind; item.linkname = "/host-canary"
                archive.addfile(item)
            with self.assertRaises(ValueError): regular_artifact(stream.getvalue(), "results.json")

    def test_process_output_and_wait_are_bounded_before_collection(self):
        with self.assertRaises(SandboxLimit):
            command([sys.executable, "-c", "print('x' * 20000)"], limit=MAX_OUTPUT)
        with self.assertRaises(SandboxLimit):
            command([sys.executable, "-c", "import time; time.sleep(2)"], timeout=0.05)
        with self.assertRaises(SandboxLimit):
            command([sys.executable, "-c", "import time; time.sleep(2)"], payload=b"x" * 128000, timeout=0.05)


class ReplayModel(Model):
    def __init__(self):
        self.index = 0

    async def get_response(self, *args, **kwargs):
        sequence = [("calculate_invoices", {"program": CONTROL_PROGRAM}), ("delegate_to_verifier", {}), ("validate_results", {})]
        index = self.index; self.index += 1
        if index < len(sequence):
            name, arguments = sequence[index]
            output = [ResponseFunctionToolCall(type="function_call", name=name, call_id=f"offline-pilot-call-{index}", arguments=json.dumps(arguments))]
        else:
            output = [ResponseOutputMessage(id="offline-pilot-message", type="message", role="assistant", status="completed",
                      content=[ResponseOutputText(type="output_text", text="Checked.", annotations=[])])]
        return ModelResponse(output=output, usage=Usage(requests=1), response_id=f"offline-pilot-response-{index}")

    async def stream_response(self, *args, **kwargs):
        raise NotImplementedError("Offline replay is non-streaming")
        yield


@unittest.skipUnless(os.environ.get("ADCP_SANDBOX_IMAGE"), "Set ADCP_SANDBOX_IMAGE to run real Docker isolation tests")
class IsolationContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sandbox = DockerSandbox(os.environ["ADCP_SANDBOX_IMAGE"])

    def run_code(self, program, **kwargs):
        result = self.sandbox.execute(program, CASES[0]["csv"], **kwargs)
        if os.environ.get("ADCP_SANDBOX_EVIDENCE"):
            record = {key: value for key, value in vars(result).items() if key != "artifact"}
            record["programSha256"] = sha256(program.encode()).hexdigest()
            record["artifactSha256"] = sha256(result.artifact).hexdigest() if result.artifact is not None else None
            path = Path(os.environ["ADCP_SANDBOX_EVIDENCE"]) / (self._testMethodName + ".json")
            path.write_text(json.dumps(record, indent=2) + "\n")
        self.assertTrue(result.cleaned)
        return result

    def test_actual_physical_output_is_correct_in_restricted_container(self):
        result = self.run_code(CONTROL_PROGRAM)
        self.assertEqual(result.status, "completed")
        self.assertTrue(result.input_unchanged)
        self.assertTrue(check_artifact(result.artifact, CASES[0]["expected"], sha256(result.artifact).hexdigest())["passed"])

    def test_write_outside_workspace_fails(self):
        result = self.run_code('open("/forbidden-target", "w").write("fictional")')
        self.assertEqual(result.status, "execution_failed")
        self.assertNotEqual(result.exit_code, 0)

    def test_actual_outbound_socket_is_unreachable(self):
        result = self.run_code('import socket\nsocket.create_connection(("192.0.2.1", 9), timeout=0.5)')
        self.assertEqual(result.status, "execution_failed")
        self.assertIn("Network is unreachable", result.stderr)

    def test_infinite_code_is_stopped_and_cleaned(self):
        result = self.run_code('while True: pass', timeout=0.5)
        self.assertEqual(result.status, "timeout")
        self.assertIsNone(result.artifact)

    def test_excessive_output_is_stopped_and_cleaned(self):
        result = self.run_code('while True: print("x" * 4096, flush=True)')
        self.assertEqual(result.status, "output_limit")

    def test_memory_exhaustion_does_not_complete(self):
        result = self.run_code('value = bytearray(256 * 1024 * 1024)')
        self.assertEqual(result.status, "execution_failed")
        self.assertNotEqual(result.exit_code, 0)

    def test_total_workspace_storage_is_bounded(self):
        result = self.run_code('for i in range(200):\n    open(f"file-{i}", "wb").write(b"x" * 60000)')
        self.assertEqual(result.status, "execution_failed")
        self.assertIn("No space left on device", result.stderr)

    def test_symlink_artifact_is_rejected_without_host_dereference(self):
        result = self.run_code('import os\nos.symlink("/etc/passwd", "results.json")')
        self.assertEqual(result.status, "artifact_invalid")
        self.assertIsNone(result.artifact)

    def test_changed_input_is_detected_independently(self):
        result = self.run_code(CONTROL_PROGRAM + '\nopen("invoices.csv", "w").write("changed")')
        self.assertEqual(result.status, "completed")
        self.assertFalse(result.input_unchanged)

    def test_sdk_replay_handoff_actual_execution_and_three_dashboard_outcomes(self):
        set_tracing_disabled(True)
        with tempfile.TemporaryDirectory() as temporary:
            baseline, candidate = (Path(temporary) / name for name in ("baseline", "candidate"))
            baseline.mkdir()
            candidate.mkdir()
            config = RunConfig(tracing_disabled=True)
            trial = Trial(baseline, CASES[0], self.sandbox)
            receipt = asyncio.run(run_case(trial, make_workflow(ReplayModel()), config, "offline-sdk-replay", baseline))
            self.assertEqual(trial.active, "Verifier")
            self.assertEqual(trial.requests, 4)
            self.assertEqual(receipt["regression"], "review")
            self.assertEqual(json.loads((baseline / "regression.json").read_text())["status"], "review")
            self.assertTrue(receipt["reviewPackageSaved"])
            partial = json.loads((baseline / "review-package.json").read_text())
            self.assertNotIn("baseline", partial)
            self.assertEqual(partial["candidate"]["chain"]["id"], trial.id)
            subprocess.run(["node", "scripts/regression.mjs", "pin", "--baseline-dir", str(baseline)],
                           cwd=ROOT, capture_output=True, timeout=10, check=True)
            next_trial = Trial(candidate, CASES[1], self.sandbox)
            receipt = asyncio.run(run_case(next_trial, make_workflow(ReplayModel()), config, "offline-sdk-replay", baseline))
            self.assertEqual(receipt["regression"], "pass")
            report = json.loads((candidate / "regression.json").read_text())
            self.assertEqual((report["status"], report["baselineId"], report["candidateId"]), ("pass", trial.id, next_trial.id))
            self.assertTrue(receipt["reviewPackageSaved"])
            package = json.loads((candidate / "review-package.json").read_text())
            self.assertEqual(package["report"]["status"], "pass")
            self.assertEqual(package["baseline"]["chain"]["id"], trial.id)
            self.assertEqual(package["candidate"]["chain"]["id"], next_trial.id)
            self.assertNotIn("note", package)
            self.assertTrue(receipt["artifactValidation"]["passed"])
            envelope = json.loads((baseline / "investigation.json").read_text())
            self.assertEqual(evaluate(envelope)["status"], "valid")
            expanded = json.loads(json.dumps(envelope))
            expanded["chain"]["grants"][1]["capabilities"].append({"action": "artifact:publish", "resource": trial.artifact_resource})
            self.assertEqual(evaluate(expanded)["status"], "violation")
            missing = json.loads(json.dumps(envelope)); missing["chain"]["grants"].pop()
            self.assertEqual(evaluate(missing)["status"], "unknown")
            with self.assertRaises(PermissionError): trial.verify("Verifier", "duplicate-verification")


if __name__ == "__main__":
    unittest.main()
