"""Compatibility corpus generated locally from the fictional SDK producer's Capture."""
from hashlib import sha256
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "integrations" / "openai-agents"))
from capture import Capture, dump

MODEL = "offline-contract-replay"
MARKER = "fictional-private-content-must-stay-in-input"


def write_fixture(folder):
    """Exercise the application's actual grant, action, and handoff recording methods."""
    capture = Capture(folder)
    calls = [("Coordinator", "read_account", {}), ("Coordinator", "delegate_to_researcher", {}),
             ("Researcher", "read_account", {}), ("Researcher", "delegate_to_reporter", {}),
             ("Reporter", "save_summary", {"summary": MARKER})]
    for index, (role, tool, args) in enumerate(calls):
        call = {"type": "function_call", "name": tool, "arguments": json.dumps(args), "call_id": "fixture-" + str(index)}
        capture.note("model_request_started", agent=role)
        capture.note("model_response", agent=role, output=[call])
        if tool.startswith("delegate_to_"):
            capture.pending_handoff = call
            capture.handoff(role, "Researcher" if role == "Coordinator" else "Reporter")
        else:
            capture.perform(role, call["call_id"], tool, args.get("summary"))
    capture.note("model_request_started", agent="Reporter")
    capture.note("model_response", agent="Reporter", output=[{"type": "message", "role": "assistant",
                 "content": [{"type": "output_text", "text": MARKER}]}])
    usage = {"requests": 6, "input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
    dump(folder / "mapping.json", capture.mapping())
    dump(folder / "investigation.json", capture.envelope(MODEL))
    dump(folder / "result.json", {"status": "completed", "model": MODEL, "finalAgent": "Reporter",
                                 "finalOutput": MARKER, "usage": usage})
    files = {p.name: sha256(p.read_bytes()).hexdigest() for p in folder.iterdir()}
    dump(folder / "manifest.json", {"model": MODEL, "status": "completed", "chainId": capture.id, "files": files,
         "agents": capture.roles, "completedTools": len(capture.events), "handoffs": 2, "requests": 6, "usage": usage})


class SdkSourceContract(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.folder = Path(temp.name)
        write_fixture(self.folder)

    def read(self, name):
        return json.loads((self.folder / name).read_bytes())

    def refresh(self):
        manifest = self.read("manifest.json")
        manifest["files"] = {name: sha256((self.folder / name).read_bytes()).hexdigest() for name in manifest["files"]}
        dump(self.folder / "manifest.json", manifest)

    def ledger(self):
        return [json.loads(line) for line in (self.folder / "capture.jsonl").read_text().splitlines()]

    def save_ledger(self, rows):
        (self.folder / "capture.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))
        self.refresh()

    def check(self, exit_code, status):
        result = subprocess.run(["node", "scripts/validate-capture.mjs", "--sdk-folder", str(self.folder), "--json"],
                                cwd=ROOT, capture_output=True, text=True, timeout=10)
        self.assertNotIn(MARKER, result.stdout + result.stderr)
        self.assertNotIn(str(self.folder), result.stdout + result.stderr)
        self.assertEqual(result.stderr, "")
        report = json.loads(result.stdout)
        self.assertEqual(result.returncode, exit_code, report)
        self.assertEqual(report["status"], status)
        self.assertEqual(report["inputKind"], "sdk-folder")
        return report

    def test_existing_unversioned_and_explicit_version_one_folder(self):
        self.assertEqual(self.check(0, "within-scope")["verifiedFileCount"], 6)
        dump(self.folder / "manifest.json", {**self.read("manifest.json"), "schemaVersion": 1})
        self.assertEqual(self.check(0, "within-scope")["receipts"], "verified")

    def test_missing_authority_returns_the_source_line_and_preserves_receipt_result(self):
        rows = self.ledger()
        grant = next(row for row in rows if row["kind"] == "grant_issued" and row["grant"]["subject"] == "Reporter")
        rows.remove(grant)
        self.save_ledger(rows)
        envelope = self.read("investigation.json")
        envelope["chain"]["grants"].remove(grant["grant"])
        dump(self.folder / "investigation.json", envelope)
        normalized = [row for row in self.read("mapping.json") if row["recordId"] != grant["recordId"]]
        lines = {row["recordId"]: index for index, row in enumerate(rows, 1)}
        dump(self.folder / "mapping.json", [{**row, "line": lines[row["recordId"]]} for row in normalized])
        self.refresh()
        report = self.check(1, "unverifiable")
        self.assertEqual(report["receipts"], "verified")
        finding = next(issue for issue in report["diagnostics"] if issue["code"] == "GRANT_MISSING")
        self.assertEqual(finding["file"], "capture.jsonl")
        self.assertEqual(rows[finding["line"] - 1]["event"]["authorityId"], grant["grant"]["id"])
        self.assertTrue(finding["field"].endswith(".event.authorityId"))

    def test_altered_summary_fails_against_manifest_and_against_original_action(self):
        (self.folder / "summary.txt").write_text("different output")
        report = self.check(1, "receipt-mismatch")
        self.assertEqual(report["diagnostics"][0]["code"], "RECEIPT_HASH_MISMATCH")
        self.refresh()
        report = self.check(1, "receipt-mismatch")
        self.assertEqual(report["diagnostics"][0]["code"], "ACTION_RECEIPT_MISMATCH")
        self.assertEqual(report["authority"], "unassessed")

    def test_rehashed_ledger_requires_consistent_read_result_model_input_and_write_result(self):
        for kind in ("read result", "write result", "write input"):
            with self.subTest(kind=kind):
                original = (self.folder / "capture.jsonl").read_bytes()
                rows = self.ledger()
                if kind == "write input":
                    call = next(row["output"][0] for row in rows if row["kind"] == "model_response"
                                and row["output"][0].get("name") == "save_summary")
                    call["arguments"] = json.dumps({"summary": "different input"})
                else:
                    actor = "Reporter" if kind == "write result" else "Coordinator"
                    event = next(row for row in rows if row["kind"] == "tool_completed" and row["event"]["actor"] == actor)
                    event["result"] = {"fictional": MARKER}
                self.save_ledger(rows)
                self.assertEqual(self.check(1, "receipt-mismatch")["diagnostics"][0]["code"], "ACTION_RECEIPT_MISMATCH")
                (self.folder / "capture.jsonl").write_bytes(original)

    def test_ledger_requires_observed_calls_and_ordered_handoffs(self):
        rows = self.ledger()
        handoff = next(row for row in rows if row["kind"] == "sdk_handoff")
        handoff["callId"] = MARKER
        self.save_ledger(rows)
        self.assertEqual(self.check(2, "invalid-input")["diagnostics"][0]["file"], "capture.jsonl")

    def test_unhandled_actions_and_unconsumed_calls_cannot_hide_in_the_response(self):
        rows = self.ledger()
        response = next(row for row in rows if row["kind"] == "model_response")
        response["output"].append({"type": "other_tool_result", "value": MARKER})
        self.save_ledger(rows)
        self.assertEqual(self.check(2, "invalid-input")["diagnostics"][0]["code"], "UNSUPPORTED_SDK_FORMAT")
        response["output"].pop()
        rows[-1]["output"].append({"type": "function_call", "name": "save_summary", "call_id": "extra", "arguments": "{}"})
        self.save_ledger(rows)
        self.assertEqual(self.check(2, "invalid-input")["diagnostics"][0]["file"], "capture.jsonl")

    def test_rehashed_mapping_normalized_events_and_final_response_require_source_agreement(self):
        for file in ("mapping.json", "investigation.json", "result.json"):
            with self.subTest(file=file):
                original = self.read(file)
                changed = self.read(file)
                if file == "mapping.json":
                    changed[0]["line"] += 1
                elif file == "investigation.json":
                    changed["chain"]["events"][0]["authorityId"] = MARKER
                else:
                    changed["finalOutput"] += "extra"
                dump(self.folder / file, changed)
                self.refresh()
                self.assertEqual(self.check(2, "invalid-input")["diagnostics"][0]["file"], file)
                dump(self.folder / file, original)

    def test_unsupported_version_and_failed_run_are_rejected(self):
        manifest = self.read("manifest.json")
        dump(self.folder / "manifest.json", {**manifest, "schemaVersion": 2})
        self.assertEqual(self.check(2, "invalid-input")["diagnostics"][0]["code"], "UNSUPPORTED_SDK_FORMAT")
        dump(self.folder / "manifest.json", {**manifest, "status": "failed"})
        self.assertEqual(self.check(2, "invalid-input")["receipts"], "unverified")

    def test_symlinked_source_and_oversize_inputs_are_rejected(self):
        path = self.folder / "summary.txt"
        path.unlink()
        path.symlink_to("account.json")
        self.assertEqual(self.check(2, "invalid-input")["diagnostics"][0]["code"], "UNREADABLE_INPUT")
        path.unlink()
        path.write_bytes(b"x" * (16 * 1024 + 1))
        self.assertEqual(self.check(2, "invalid-input")["diagnostics"][0]["code"], "UNREADABLE_INPUT")
