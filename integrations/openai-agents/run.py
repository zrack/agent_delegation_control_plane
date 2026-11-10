"""Run one bounded real model-agent workflow and export a local investigation."""
from __future__ import annotations

import argparse
import asyncio
from hashlib import sha256
from importlib.metadata import version
import json
from pathlib import Path
import sys

from agents import Agent, ModelSettings, RunConfig, RunHooks, Runner, function_tool, handoff, set_tracing_disabled
from agents.models.openai_provider import OpenAIProvider
from agents.tool_context import ToolContext
from openai import AsyncOpenAI
from capture import Capture, dump, timestamp

ROOT = Path(__file__).resolve().parents[2]
MODEL = "gpt-6-astra"


def usage_summary(usage) -> dict:
    return {name: getattr(usage, name) for name in ("requests", "input_tokens", "output_tokens", "total_tokens")}


def key_value() -> str:
    # Read only the explicitly approved destination. Never emit its contents.
    for line in (ROOT / ".env.local").read_text().splitlines():
        name, separator, value = line.partition("=")
        if separator and name.strip() == "OPENAI_API_KEY" and value.strip():
            return value.strip().strip("\"'")
    raise ValueError("Approved API key destination has no key")


class Hooks(RunHooks[Capture]):
    async def on_llm_start(self, context, agent, system_prompt, input_items):
        context.context.requests += 1
        if context.context.requests > 10:
            raise ValueError("Model request budget exhausted")
        context.context.note("model_request_started", agent=agent.name)

    async def on_llm_end(self, context, agent, response):
        output = [item.model_dump(mode="json") for item in response.output]
        context.context.note("model_response", agent=agent.name, responseId=response.response_id,
                             requestId=response.request_id, usage=usage_summary(response.usage), output=output)
        for item in output:
            if item.get("type") == "function_call" and item.get("name", "").startswith("delegate_to_"):
                context.context.pending_handoff = item

    async def on_handoff(self, context, from_agent, to_agent):
        context.context.handoff(from_agent.name, to_agent.name)


@function_tool(failure_error_function=None, is_enabled=lambda context, agent: not any(event["actor"] == agent.name for event in context.context.events))
async def read_account(context: ToolContext[Capture]) -> dict:
    """Read the sole generated fictional Northstar account; takes no path or external identifier."""
    return context.context.perform(context.agent.name, context.tool_call_id, "read_account")


@function_tool(failure_error_function=None, is_enabled=lambda context, agent: not any(event["actor"] == agent.name for event in context.context.events))
async def save_summary(context: ToolContext[Capture], summary: str) -> dict:
    """Save a short summary to the sole local summary artifact, with no caller-chosen path.

    Args:
        summary: At most 2000 characters describing the fictional account and its review items.
    """
    return context.context.perform(context.agent.name, context.tool_call_id, "save_summary", summary)


def make_workflow(model=MODEL):
    settings = ModelSettings(max_tokens=1200, parallel_tool_calls=False, store=False)
    reporter = Agent[Capture](name="Reporter", model=model, model_settings=settings, tools=[save_summary],
        instructions="You own the final report. Use the fictional Northstar account data in the conversation. Call save_summary exactly once with two concise sentences mentioning Northstar, that the data is fictional, and its open items. After the tool succeeds, reply with a brief confirmation. Do not call any other tool or hand off.")
    researcher = Agent[Capture](name="Researcher", model=model, model_settings=settings, tools=[read_account],
        handoffs=[handoff(reporter, tool_name_override="delegate_to_reporter", is_enabled=lambda context, agent: any(event["actor"] == "Researcher" for event in context.context.events))],
        instructions="Inspect the fictional Northstar account. First call read_account exactly once. Then call delegate_to_reporter to transfer the task of saving a summary. Do not end with a text answer and do not repeat tools.")
    return Agent[Capture](name="Coordinator", model=model, model_settings=settings, tools=[read_account],
        handoffs=[handoff(researcher, tool_name_override="delegate_to_researcher", is_enabled=lambda context, agent: any(event["actor"] == "Coordinator" for event in context.context.events))],
        instructions="Route the fictional account review. First call read_account exactly once. Then call delegate_to_researcher. Do not answer the review yourself and do not repeat tools.")


async def execute(directory: Path, smoke: bool) -> dict:
    set_tracing_disabled(True)
    settings = ModelSettings(max_tokens=1200, parallel_tool_calls=False, store=False)
    async with AsyncOpenAI(api_key=key_value(), base_url="https://api.openai.com/v1", max_retries=0, timeout=35) as client:
        config = RunConfig(model_provider=OpenAIProvider(openai_client=client, use_responses=True),
                           tracing_disabled=True, trace_include_sensitive_data=False)
        if smoke:
            result = await Runner.run(Agent(name="Connection check", model=MODEL, model_settings=settings,
                                           instructions="Reply with READY only."), "Check the connection.", max_turns=1, run_config=config)
            receipt = {"status": "completed", "model": MODEL, "output": result.final_output,
                       "usage": usage_summary(result.context_wrapper.usage), "at": timestamp()}
            dump(directory / "smoke.json", receipt)
            return receipt

        capture = Capture(directory)
        coordinator = make_workflow()
        result = await Runner.run(coordinator, "Review the fictional Northstar account and have the reporter save its local summary.",
                                  context=capture, hooks=Hooks(), max_turns=10, run_config=config)
        envelope = capture.envelope(MODEL)
        dump(directory / "investigation.json", envelope)
        dump(directory / "mapping.json", capture.mapping())
        dump(directory / "result.json", {"status": "completed", "finalAgent": result.last_agent.name,
             "finalOutput": result.final_output, "usage": usage_summary(result.context_wrapper.usage), "model": MODEL})
        receipt = {"status": "completed", "model": MODEL, "chainId": capture.id, "agents": capture.roles,
                   "handoffs": 2, "completedTools": len(capture.events), "requests": capture.requests,
                   "usage": usage_summary(result.context_wrapper.usage)}
        return receipt


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="New run directory; parent must exist")
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args()
    directory = args.output.resolve()
    directory.mkdir()  # Refuse an existing directory; preserve previous runs.
    try:
        async with asyncio.timeout(150):
            receipt = await execute(directory, args.smoke)
    except Exception as error:
        # Provider messages may echo credential fragments. Save only safe diagnostic metadata.
        receipt = {"status": "failed", "errorType": type(error).__name__,
                   "httpStatus": getattr(error, "status_code", None),
                   "providerCode": getattr(error, "code", None),
                   "requestId": getattr(error, "request_id", None), "at": timestamp()}
        dump(directory / "failure.json", receipt)
        print(json.dumps(receipt))
        return 1
    receipt.update({"at": timestamp(), "sdkVersion": version("openai-agents"), "clientVersion": version("openai"),
                    "codeSha256": {name: sha256((Path(__file__).parent / name).read_bytes()).hexdigest() for name in ("run.py", "capture.py", "requirements.txt")},
                    "files": {path.name: sha256(path.read_bytes()).hexdigest() for path in sorted(directory.iterdir()) if path.is_file()}})
    dump(directory / "manifest.json", receipt)
    print(json.dumps({"status": receipt["status"], "output": str(directory), "model": MODEL,
                      "usage": receipt.get("usage"), "chainId": receipt.get("chainId")}, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
