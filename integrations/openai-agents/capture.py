"""Application-owned capture for one bounded model-agent handoff chain."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from pathlib import Path
from uuid import uuid4


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def dump(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


class Capture:
    roles = ["Coordinator", "Researcher", "Reporter"]

    def __init__(self, directory: Path):
        self.directory = directory
        self.id = "AGENT-" + uuid4().hex[:12]
        self.principal = "owner:local-pilot"
        self.active = "Coordinator"
        self.events: list[dict] = []
        self.grants: list[dict] = []
        self.records: list[dict] = []
        self.parent_event: str | None = None
        self.pending_handoff: dict | None = None
        self.requests = 0
        self.account_resource = "fictional-account:northstar"
        self.summary_resource = "local-summary:northstar"
        self.account = {"fictional": True, "account": "Northstar", "status": "Review requested",
                        "open_items": ["Confirm review owner", "Prepare a short account summary"]}
        dump(directory / "account.json", self.account)
        now = datetime.now(timezone.utc)
        self.valid_from = (now - timedelta(seconds=1)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        self.expiry = now + timedelta(minutes=5)
        self.issue("Coordinator", None)

    def note(self, kind: str, **fields) -> dict:
        record = {"recordId": f"{self.id}-r{len(self.records) + 1}", "at": timestamp(), "kind": kind, **fields}
        self.records.append(record)
        with (self.directory / "capture.jsonl").open("a") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        return record

    def issue(self, actor: str, parent: dict | None) -> None:
        permissions = [{"action": "account:read", "resource": self.account_resource},
                       {"action": "summary:write", "resource": self.summary_resource}]
        if actor == "Reporter":
            permissions = permissions[1:]
        expiry = self.expiry - timedelta(seconds=30 * self.roles.index(actor))
        grant = {"id": f"{self.id}-g{len(self.grants) + 1}", "parentGrantId": parent["id"] if parent else None,
                 "issuer": parent["subject"] if parent else self.principal, "subject": actor,
                 "principal": self.principal, "capabilities": permissions,
                 "validFrom": self.valid_from, "expiresAt": expiry.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                 "canDelegate": actor != "Reporter"}
        self.grants.append(grant)
        self.note("grant_issued", grant=grant, reason="Application policy for the owner-authorized fictional-data pilot")

    def handoff(self, source: str, destination: str) -> None:
        expected = {"Coordinator": "Researcher", "Researcher": "Reporter"}
        if self.active != source or expected.get(source) != destination:
            raise ValueError("Unexpected handoff path")
        parent_events = [event for event in self.events if event["actor"] == source]
        if len(parent_events) != 1 or not self.pending_handoff:
            raise ValueError("Handoff requires one completed parent action and an observed model handoff call")
        expected_tool = "delegate_to_" + destination.lower()
        if self.pending_handoff["name"] != expected_tool:
            raise ValueError("Handoff callback does not match captured model call")
        self.note("sdk_handoff", fromAgent=source, toAgent=destination,
                  callId=self.pending_handoff["call_id"], parentEventId=parent_events[0]["id"])
        self.pending_handoff = None
        self.parent_event = parent_events[0]["id"]
        self.active = destination
        self.issue(destination, self.grants[-1])

    def perform(self, actor: str, call_id: str, tool: str, summary: str | None = None) -> dict:
        if actor != self.active or not call_id or any(event["actor"] == actor for event in self.events):
            raise ValueError("Actor/call binding invalid or role already completed its action")
        if tool == "read_account" and actor in ("Coordinator", "Researcher"):
            contents = (self.directory / "account.json").read_bytes()
            action, resource, result = "account:read", self.account_resource, json.loads(contents)
        elif tool == "save_summary" and actor == "Reporter":
            if not isinstance(summary, str) or not 1 <= len(summary) <= 2000:
                raise ValueError("Summary must contain 1–2000 characters")
            contents = summary.encode()
            with (self.directory / "summary.txt").open("xb") as handle:
                handle.write(contents)
            action, resource = "summary:write", self.summary_resource
            result = {"saved": True, "sha256": sha256(contents).hexdigest()}
        else:
            raise ValueError("Tool is not available to this role")
        event = {"id": f"{self.id}-e{len(self.events) + 1}", "parentEventId": self.parent_event,
                 "actor": actor, "label": actor, "job": "Read the fictional account" if tool == "read_account" else "Save the model-written summary",
                 "authorityId": self.grants[-1]["id"],
                 "action": {"action": action, "resource": resource, "at": timestamp(), "outcome": "completed"},
                 "evidence": {"callId": call_id, "tool": tool, "artifactSha256": sha256(contents).hexdigest()}}
        self.events.append(event)
        self.note("tool_completed", event=event, result=result)
        return result

    def envelope(self, model: str) -> dict:
        if [event["actor"] for event in self.events] != self.roles:
            raise ValueError("Required role actions are incomplete")
        if len([record for record in self.records if record["kind"] == "sdk_handoff"]) != 2:
            raise ValueError("Required SDK handoffs were not observed")
        return {"schemaVersion": 1, "provenance": {"kind": "model-agent-run", "model": model,
                "framework": "OpenAI Agents SDK", "identity": "Application-assigned; not cryptographically authenticated",
                "data": "Fictional account; actual model calls and local tool execution"},
                "chain": {"id": self.id, "title": "Model-agent account review", "summary": "Coordinator → researcher → reporter; captured SDK handoffs and local tools.",
                "principal": {"id": self.principal, "name": "Local workflow owner", "role": "Owner-authorized pilot · fictional account"},
                "rootGrantId": self.grants[0]["id"], "intent": "Read the fictional Northstar account and save a local summary.",
                "source": "Model-agent run · OpenAI Agents SDK · " + model,
                "completedAt": self.events[-1]["action"]["at"], "grants": self.grants, "events": self.events}}

    def mapping(self) -> list[dict]:
        return [{"file": "capture.jsonl", "line": index + 1, "recordId": record["recordId"],
                 "normalizedId": record.get("event", record.get("grant", {})).get("id")}
                for index, record in enumerate(self.records) if record["kind"] in ("grant_issued", "tool_completed")]
