"""Offline contract verification; deterministic SDK replay is not a live model result."""
import asyncio
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from agents import RunConfig, Runner, Usage, set_tracing_disabled
from agents.items import ModelResponse
from agents.models.interface import Model
from openai.types.responses import ResponseFunctionToolCall, ResponseOutputMessage, ResponseOutputText
from capture import Capture
import run
from run import Hooks, make_workflow

ROOT = Path(__file__).resolve().parents[2]


class ReplayModel(Model):
    def __init__(self):
        self.index = 0

    async def get_response(self, *args, **kwargs):
        sequence = [("read_account", {}), ("delegate_to_researcher", {}), ("read_account", {}),
                    ("delegate_to_reporter", {}), ("save_summary", {"summary": "Northstar is fictional. Confirm the owner and prepare the review."})]
        index = self.index
        self.index += 1
        available_tools = kwargs.get("tools", args[3] if len(args) > 3 else [])
        available_handoffs = kwargs.get("handoffs", args[5] if len(args) > 5 else [])
        expected_tools = ["read_account"] if index in (0, 2) else ["save_summary"] if index == 4 else []
        expected_handoffs = ["delegate_to_researcher"] if index == 1 else ["delegate_to_reporter"] if index == 3 else []
        assert [tool.name for tool in available_tools] == expected_tools
        assert [item.tool_name for item in available_handoffs] == expected_handoffs
        # Bind the offline verifier's accepted arguments to the schemas exposed
        # by the installed SDK for the tools available on this model turn.
        schemas = [tool.params_json_schema for tool in available_tools] + [item.input_json_schema for item in available_handoffs]
        for schema in schemas:
            fields = ["summary"] if expected_tools == ["save_summary"] else []
            assert schema["type"] == "object" and schema["additionalProperties"] is False
            assert sorted(schema["properties"]) == sorted(schema["required"]) == fields
            if fields:
                assert schema["properties"]["summary"]["type"] == "string"
        if index < len(sequence):
            name, arguments = sequence[index]
            output = [ResponseFunctionToolCall(type="function_call", name=name, call_id=f"offline-call-{index}", arguments=json.dumps(arguments))]
        else:
            output = [ResponseOutputMessage(id="offline-message", type="message", role="assistant", status="completed",
                      content=[ResponseOutputText(type="output_text", text="Saved.", annotations=[])])]
        return ModelResponse(output=output, usage=Usage(requests=1), response_id=f"offline-response-{index}")

    async def stream_response(self, *args, **kwargs):
        raise NotImplementedError("Offline replay uses non-streaming execution")
        yield


class WorkflowContract(unittest.TestCase):
    def test_sdk_handoffs_call_bindings_source_mapping_and_physical_summary(self):
        set_tracing_disabled(True)
        with tempfile.TemporaryDirectory() as temporary:
            capture = Capture(Path(temporary))
            result = asyncio.run(Runner.run(make_workflow(ReplayModel()), "Offline replay only", context=capture,
                                           hooks=Hooks(), run_config=RunConfig(tracing_disabled=True), max_turns=10))
            self.assertEqual(result.last_agent.name, "Reporter")
            envelope = capture.envelope("offline-test-replay")
            self.assertEqual([event["actor"] for event in capture.events], Capture.roles)
            self.assertEqual(capture.requests, 6)
            self.assertIn("Northstar", (Path(temporary) / "summary.txt").read_text())
            self.assertEqual(len(capture.mapping()), 6)
            for event in capture.events:
                self.assertTrue(event["evidence"]["callId"].startswith("offline-call-"))
            program = "import {evaluateChain} from './src/evaluator.mjs'; let s=''; for await(const c of process.stdin)s+=c; console.log(JSON.stringify(evaluateChain(JSON.parse(s).chain)));"
            evaluated = subprocess.run(["node", "--input-type=module", "-e", program], input=json.dumps(envelope), text=True,
                                       cwd=ROOT, capture_output=True, check=True)
            self.assertEqual(json.loads(evaluated.stdout)["status"], "valid")

    def test_production_export_replayed_offline_passes_sdk_folder_validation(self):
        # Only the model and external dependencies are replaced. Use the production
        # runner, hooks, file writers and manifest so format drift fails this check.
        workflow = make_workflow(ReplayModel())
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "completed"
            with (
                patch("sys.argv", ["run.py", "--output", str(directory)]),
                patch.object(run, "make_workflow", return_value=workflow),
                patch.object(run, "MODEL", "offline-test-replay"),
                patch.object(run, "key_value"),
                patch.object(run, "AsyncOpenAI"),
                patch("socket.socket.connect", side_effect=AssertionError("Offline replay attempted a connection")),
                redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(asyncio.run(run.main()), 0)
            checked = subprocess.run(["node", "scripts/validate-capture.mjs", "--sdk-folder", str(directory), "--json"],
                                     cwd=ROOT, text=True, capture_output=True, timeout=10, check=True)
            report = json.loads(checked.stdout)
            self.assertEqual((report["status"], report["receipts"], report["verifiedFileCount"]),
                             ("within-scope", "verified", 6))
            self.assertEqual(report["diagnostics"], [])

    def test_out_of_order_handoff_duplicate_action_and_wrong_role_cannot_create_summary(self):
        with tempfile.TemporaryDirectory() as temporary:
            capture = Capture(Path(temporary))
            with self.assertRaises(ValueError): capture.handoff("Coordinator", "Researcher")
            with self.assertRaises(ValueError): capture.perform("Reporter", "call-id", "save_summary", "Unexpected")
            capture.perform("Coordinator", "call-1", "read_account")
            with self.assertRaises(ValueError): capture.perform("Coordinator", "call-2", "read_account")
            self.assertFalse((Path(temporary) / "summary.txt").exists())
            with self.assertRaises(ValueError): capture.envelope("offline-test-replay")


if __name__ == "__main__":
    unittest.main()
