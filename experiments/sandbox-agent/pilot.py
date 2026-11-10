"""Bounded real-agent invoice pilot; offline controls never substitute for live results."""
import argparse
import asyncio
from hashlib import sha256
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

from agents import Agent, ModelSettings, RunConfig, RunHooks, Runner, function_tool, handoff, set_tracing_disabled
from agents.models.openai_provider import OpenAIProvider
from agents.tool_context import ToolContext
from openai import AsyncOpenAI

from cases import CASES
from contract import ROOT, Trial, save
from sandbox import DockerSandbox, IMAGE

MODEL = "gpt-6-astra"
DEFAULT_BASELINE_DIR = ROOT / "output" / "invoice-regression-baseline"


def key_value():
    descriptor = os.open(ROOT / ".env.local", os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor) as handle:
        metadata = os.fstat(handle.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
            raise PermissionError("Project key file must be owner-only and owned by the current user")
        for line in handle:
            name, separator, value = line.partition("=")
            if separator and name.strip() == "OPENAI_API_KEY" and value.strip().strip("\"'"):
                return value.strip().strip("\"'")
    raise ValueError("Configured project key unavailable")


class Hooks(RunHooks[Trial]):
    async def on_llm_start(self, context, agent, system_prompt, input_items):
        context.context.requests += 1
        if context.context.requests > 6:
            raise ValueError("Pilot request limit reached")
        context.context.note("model_request", actor=agent.name)

    async def on_llm_end(self, context, agent, response):
        calls = [{"callId": item.call_id, "name": item.name} for item in response.output if item.type == "function_call"]
        context.context.note("model_response", actor=agent.name, responseId=response.response_id,
                             calls=calls,
                             usage={key: getattr(response.usage, key) for key in ("requests", "input_tokens", "output_tokens", "total_tokens")})
        for call in calls:
            if call["name"] == "delegate_to_verifier":
                context.context.pending_handoff = {"actor": agent.name, "callId": call["callId"]}

    async def on_handoff(self, context, from_agent, to_agent):
        context.context.handoff(from_agent.name, to_agent.name)


@function_tool(failure_error_function=None, is_enabled=lambda context, agent: context.context.active == "Coder" and not context.context.events)
async def calculate_invoices(context: ToolContext[Trial], program: str) -> dict:
    """Run one Python invoice-calculation program in a disposable isolated container.

    Args:
        program: Python source (at most 12000 UTF-8 bytes). Read invoices.csv and write results.json.
    """
    return await asyncio.to_thread(context.context.execute, context.agent.name, context.tool_call_id, program)


@function_tool(failure_error_function=None, is_enabled=lambda context, agent: context.context.active == "Verifier" and len(context.context.events) == 1)
async def validate_results(context: ToolContext[Trial]) -> dict:
    """Independently check the actual result artifact against withheld expected integers and its frozen hash."""
    return context.context.verify(context.agent.name, context.tool_call_id)


def make_workflow(model=MODEL):
    settings = ModelSettings(max_tokens=1800, parallel_tool_calls=False, store=False)
    verifier = Agent[Trial](name="Verifier", model=model, model_settings=settings, tools=[validate_results],
        instructions="Call validate_results exactly once. That deterministic validator decides whether the physical output is correct. After it succeeds, briefly confirm completion. Do not calculate your own expected answer or call other tools.")
    return Agent[Trial](name="Coder", model=model, model_settings=settings, tools=[calculate_invoices],
        handoffs=[handoff(verifier, tool_name_override="delegate_to_verifier",
                         is_enabled=lambda context, agent: len(context.context.events) == 1)],
        instructions="Write and execute a Python standard-library program with calculate_invoices exactly once. The isolated working directory already contains invoices.csv, with columns invoice_id,quantity,unit_price_cents. Read it with csv, use integer cents, compute subtotal=sum(quantity*unit_price_cents), tax=subtotal*7//100, and total=subtotal+tax. Write results.json with exactly invoice_count (number of CSV data rows), subtotal_cents, tax_cents,total_cents, all JSON integers. Credits and zero quantities are intentional. Do not change invoices.csv. No network or packages, no arbitrary paths; write only results.json. After the tool succeeds, call delegate_to_verifier. Do not finish the task yourself.")


def record_regression(directory, baseline_dir):
    package_saved = False
    try:
        result = subprocess.run(["node", str(ROOT / "scripts/regression.mjs"), "check", "--baseline-dir",
                                 str(baseline_dir), "--candidate", str(directory / "investigation.json"),
                                 "--package", str(directory / "review-package.json")],
                                cwd=ROOT, capture_output=True, text=True, timeout=10, check=False)
        report = json.loads(result.stdout)
        statuses = {0: ("pass",), 1: ("regression",), 2: ("review",), 3: ("pass", "regression", "review")}
        if (not isinstance(report, dict) or report.get("schemaVersion") != 1
                or report.get("status") not in statuses.get(result.returncode, ())):
            raise ValueError("No usable regression report")
        package_saved = result.returncode != 3 and (directory / "review-package.json").is_file()
    except (OSError, subprocess.TimeoutExpired, ValueError):
        report = {"schemaVersion": 1, "status": "review", "label": "Needs review",
                  "reasons": [{"impact": "review", "message": "The offline regression check could not complete."}]}
    save(directory / "regression.json", report)
    return report["status"], package_saved


async def run_case(trial, workflow, run_config, mode, baseline_dir):
    directory = trial.directory
    try:
        async with asyncio.timeout(150):
            result = await Runner.run(workflow, "Calculate the supplied fictional invoices and transfer the physical results to the independent verifier.",
                                      context=trial, hooks=Hooks(), max_turns=6, run_config=run_config)
            envelope = trial.export(mode)
        regression, package_saved = await asyncio.to_thread(record_regression, directory, baseline_dir)
        usage = result.context_wrapper.usage
        receipt = {"status": "passed", "mode": mode, "case": trial.case["id"], "chainId": envelope["chain"]["id"],
                   "requests": trial.requests, "usage": {key: getattr(usage, key) for key in ("requests", "input_tokens", "output_tokens", "total_tokens")},
                   "delegation": "valid", "artifactValidation": trial.grade, "sandboxCleaned": trial.execution.cleaned,
                   "regression": regression, "reviewPackageSaved": package_saved}
        save(directory / "result.json", receipt)
        return receipt
    except Exception as error:
        # Never emit provider messages, keys, raw payloads or invented success.
        save(directory / "failure.json", {"status": "failed", "errorType": type(error).__name__,
             "httpStatus": getattr(error, "status_code", None), "requests": trial.requests})
        raise


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="New private run directory under an existing parent")
    parser.add_argument("--live", action="store_true", help="Explicitly authorize bounded provider calls after offline controls pass")
    parser.add_argument("--runs", type=int, choices=range(1, 4), default=3)
    parser.add_argument("--image", default=IMAGE, help="Prebuilt sandbox image; runtime freezes its immutable local ID")
    parser.add_argument("--baseline-dir", type=Path, default=DEFAULT_BASELINE_DIR,
                        help="Directory containing the pinned invoice export (default: output/invoice-regression-baseline)")
    args = parser.parse_args()
    os.umask(0o077)
    directory = args.output.resolve()
    if not directory.is_relative_to((ROOT / "output").resolve()):
        raise ValueError("Pilot records must stay under ignored output/")
    directory.mkdir(mode=0o700)
    snapshot = directory / "source"
    snapshot.mkdir(mode=0o700)
    for path in sorted(Path(__file__).parent.glob("*.py")) + [Path(__file__).parent / "Dockerfile"]:
        (snapshot / path.name).write_bytes(path.read_bytes())
    set_tracing_disabled(True)
    sandbox = DockerSandbox(args.image)
    evidence = directory / "offline-evidence"
    evidence.mkdir(mode=0o700)
    environment = {**os.environ, "ADCP_SANDBOX_IMAGE": sandbox.image_id,
                   "ADCP_SANDBOX_EVIDENCE": str(evidence), "PYTHONDONTWRITEBYTECODE": "1"}
    tests = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", str(Path(__file__).parent), "-p", "test_*.py", "-v"],
                           cwd=ROOT, env=environment, capture_output=True, text=True, timeout=180, check=False)
    (directory / "offline-tests.txt").write_text(tests.stdout + tests.stderr)
    if tests.returncode:
        save(directory / "result.json", {"status": "failed", "stage": "offline_controls", "liveCalls": 0})
        return 1
    results = []
    if args.live:
        try:
            async with AsyncOpenAI(api_key=key_value(), base_url="https://api.openai.com/v1", timeout=35, max_retries=0) as client:
                run_config = RunConfig(model_provider=OpenAIProvider(openai_client=client, use_responses=True),
                                       tracing_disabled=True, trace_include_sensitive_data=False)
                for case in CASES[:args.runs]:
                    run_directory = directory / case["id"]
                    run_directory.mkdir(mode=0o700)
                    trial = Trial(run_directory, case, sandbox)
                    result = await run_case(trial, make_workflow(), run_config, "live-agent-sandbox", args.baseline_dir)
                    results.append(result)
                    print(json.dumps({key: result[key] for key in ("case", "status", "chainId", "regression", "reviewPackageSaved")}), flush=True)
        except Exception as error:
            save(directory / "failure.json", {"status": "failed", "stage": "live", "errorType": type(error).__name__,
                 "httpStatus": getattr(error, "status_code", None), "completedCases": len(results)})
            print(json.dumps({"status": "failed", "errorType": type(error).__name__, "httpStatus": getattr(error, "status_code", None)}))
            return 1
    summary = {"status": "passed", "offlineControls": "passed", "liveRuns": results,
               "imageId": sandbox.image_id, "sourceSha256": {path.name: sha256(path.read_bytes()).hexdigest()
                   for path in sorted(snapshot.iterdir())},
               "limits": {"maxLiveCases": 3, "requestsPerCase": 6, "tokensPerRequest": 1800, "caseSeconds": 150},
               "scope": "Named fictional invoice task; not general agent authorization or production certification"}
    save(directory / "result.json", summary)
    print(json.dumps({"status": "passed", "offlineControls": "passed", "liveRuns": len(results)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
