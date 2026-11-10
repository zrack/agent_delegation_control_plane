"""Trusted pilot policy, capture and independent result checks; no model grading."""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from pathlib import Path
from uuid import uuid4

from sandbox import validate_inputs

ROOT = Path(__file__).resolve().parents[2]


def stamp(value=None):
    return (value or datetime.now(timezone.utc)).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def save(path, value):
    with path.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


@dataclass(frozen=True)
class Authority:
    subject: str
    capabilities: tuple[tuple[str, str], ...]
    start: datetime
    expiry: datetime

    def permits(self, actor, action, resource, now):
        return (actor == self.subject and self.start <= now < self.expiry
                and (action, resource) in self.capabilities)


def check_artifact(contents, expected, frozen_hash):
    if sha256(contents).hexdigest() != frozen_hash:
        return {"passed": False, "reason": "artifact_hash_mismatch"}
    try:
        def unique(pairs):
            if len(pairs) != len({key for key, _ in pairs}):
                raise ValueError("Duplicate result keys")
            return dict(pairs)
        actual = json.loads(contents, object_pairs_hook=unique)
    except (ValueError, UnicodeError, RecursionError):
        return {"passed": False, "reason": "invalid_json"}
    passed = (isinstance(actual, dict) and set(actual) == set(expected)
              and all(type(actual[key]) is int and actual[key] == value for key, value in expected.items()))
    return {"passed": passed, "reason": "exact_integer_results" if passed else "incorrect_results", "actual": actual}


def check_receipts(records, trusted_root):
    previous = "0" * 64
    for index, record in enumerate(records, 1):
        body = {key: value for key, value in record.items() if key != "digest"}
        if body.get("sequence") != index or body.get("previousDigest") != previous:
            return False
        digest = sha256(canonical(body)).hexdigest()
        if digest != record.get("digest"):
            return False
        previous = digest
    return bool(records) and previous == trusted_root


def evaluate(envelope):
    program = ("import {parseInvestigation} from './src/import.mjs';"
               "import {evaluateChain} from './src/evaluator.mjs';"
               "let s='';for await(const c of process.stdin)s+=c;"
               "console.log(JSON.stringify(evaluateChain(parseInvestigation(s))));")
    # cwd is explicitly selected; untrusted JSON goes through stdin, never source interpolation.
    import subprocess
    result = subprocess.run(["node", "--input-type=module", "-e", program], cwd=ROOT,
                            input=json.dumps(envelope), capture_output=True, text=True, timeout=10, check=True)
    return json.loads(result.stdout)


class Trial:
    def __init__(self, directory, case, sandbox):
        self.directory, self.case, self.sandbox = directory, case, sandbox
        self.id = "SANDBOX-" + uuid4().hex[:12]
        self.resource = "sandbox:" + self.id
        self.artifact_resource = self.resource + ":results.json"
        self.records, self.events, self.grants, self.attempts = [], [], [], []
        self.active = "Coder"
        self.execution = None
        self.pending_handoff = None
        self.grade = None
        self.requests = 0
        self.now = datetime.now(timezone.utc)
        self.expiry = self.now + timedelta(minutes=5)
        self.issue("Coder", None)
        save(directory / "input.json", {"fictional": True, "case": case["id"], "csv": case["csv"]})
        save(directory / "expected.json", case["expected"])

    def note(self, kind, **fields):
        body = {"sequence": len(self.records) + 1, "previousDigest": self.records[-1]["digest"] if self.records else "0" * 64,
                "at": stamp(), "kind": kind, **fields}
        record = {**body, "digest": sha256(canonical(body)).hexdigest()}
        self.records.append(record)
        with (self.directory / "capture.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record) + "\n")

    def issue(self, actor, parent):
        pairs = [("code:execute", self.resource), ("artifact:verify", self.artifact_resource)]
        if actor == "Verifier":
            pairs = pairs[1:]
        start, expiry = self.now - timedelta(seconds=1), self.expiry - timedelta(seconds=30 if parent else 0)
        self.authority = Authority(actor, tuple(pairs), start, expiry)
        grant = {"id": self.id + ("-g2" if parent else "-g1"), "parentGrantId": parent["id"] if parent else None,
                 "issuer": parent["subject"] if parent else "owner:sandbox-pilot", "subject": actor,
                 "principal": "owner:sandbox-pilot", "capabilities": [{"action": action, "resource": resource} for action, resource in pairs],
                 "validFrom": stamp(start), "expiresAt": stamp(expiry), "canDelegate": not bool(parent)}
        self.grants.append(grant)
        self.note("grant_issued", grant=grant)

    def authorize(self, actor, action, resource, call_id):
        allowed = (isinstance(call_id, str) and 1 <= len(call_id) <= 200 and actor == self.active
                   and not any(attempt["callId"] == call_id and attempt["outcome"] == "allowed" for attempt in self.attempts)
                   and not any(attempt["actor"] == actor and attempt["outcome"] == "allowed" for attempt in self.attempts)
                   and not any(event["actor"] == actor for event in self.events)
                   and self.authority.permits(actor, action, resource, datetime.now(timezone.utc)))
        self.attempts.append({"actor": actor, "action": action, "resource": resource, "callId": call_id,
                              "outcome": "allowed" if allowed else "denied"})
        self.note("authorization", **self.attempts[-1])
        if not allowed:
            raise PermissionError("Pilot authority denied the operation")

    def complete(self, actor, action, resource, call_id, artifact_hash):
        event = {"id": self.id + f"-e{len(self.events) + 1}", "parentEventId": self.events[-1]["id"] if self.events else None,
                 "actor": actor, "label": actor, "job": "Execute invoice Python" if actor == "Coder" else "Independently validate actual results",
                 "authorityId": self.grants[-1]["id"],
                 "action": {"action": action, "resource": resource, "at": stamp(), "outcome": "completed"},
                 "evidence": {"callId": call_id, "tool": action, "artifactSha256": artifact_hash}}
        self.events.append(event)
        self.note("tool_completed", event=event)

    def execute(self, actor, call_id, program):
        self.authorize(actor, "code:execute", self.resource, call_id)
        validate_inputs(program, self.case["csv"])
        with (self.directory / "program.py").open("x", encoding="utf-8") as handle:
            handle.write(program)
        self.execution = self.sandbox.execute(program, self.case["csv"])
        save(self.directory / "execution.json", {key: value for key, value in vars(self.execution).items() if key != "artifact"})
        if self.execution.status != "completed" or self.execution.artifact is None or not self.execution.input_unchanged:
            self.note("execution_failed", status=self.execution.status, inputUnchanged=self.execution.input_unchanged)
            raise ValueError("Sandbox execution or artifact collection failed")
        with (self.directory / "results.json").open("xb") as handle:
            handle.write(self.execution.artifact)
        self.artifact_hash = sha256(self.execution.artifact).hexdigest()
        self.complete(actor, "code:execute", self.resource, call_id, self.artifact_hash)
        return {"executed": True, "exitCode": self.execution.exit_code, "artifactSha256": self.artifact_hash}

    def handoff(self, source, destination):
        if (source != "Coder" or destination != "Verifier" or self.active != source or len(self.events) != 1
                or not self.pending_handoff or self.pending_handoff["actor"] != source):
            raise PermissionError("Unexpected pilot handoff")
        self.note("sdk_handoff", source=source, destination=destination, callId=self.pending_handoff["callId"])
        self.pending_handoff = None
        self.active = destination
        self.issue(destination, self.grants[0])

    def verify(self, actor, call_id):
        self.authorize(actor, "artifact:verify", self.artifact_resource, call_id)
        self.grade = check_artifact((self.directory / "results.json").read_bytes(), self.case["expected"], self.artifact_hash)
        save(self.directory / "validation.json", self.grade)
        self.note("independent_validation", passed=self.grade["passed"], reason=self.grade["reason"])
        if not self.grade["passed"]:
            raise ValueError("Independent result validation failed")
        self.complete(actor, "artifact:verify", self.artifact_resource, call_id, self.artifact_hash)
        return self.grade

    def export(self, mode):
        if [event["actor"] for event in self.events] != ["Coder", "Verifier"] or not self.grade or not self.grade["passed"]:
            raise ValueError("Cannot export an incomplete or failed pilot as completed")
        envelope = {"schemaVersion": 1, "provenance": {"kind": mode, "data": "Fictional invoices",
                    "identity": "Application-issued; not cryptographic identity"},
                    "chain": {"id": self.id, "title": "Sandboxed invoice calculation", "summary": "Actual Python execution followed by independent integer validation.",
                    "source": "Live model and isolated Docker" if mode == "live-agent-sandbox" else "Deterministic offline SDK replay and isolated Docker",
                    "principal": {"id": "owner:sandbox-pilot", "name": "Local pilot owner", "role": "Fictional-data test"},
                    "rootGrantId": self.grants[0]["id"], "intent": "Calculate fictional invoice totals and verify the physical output.",
                    "completedAt": self.events[-1]["action"]["at"], "grants": self.grants, "events": self.events}}
        assessment = evaluate(envelope)
        if assessment["status"] != "valid":
            raise ValueError("Completed pilot did not pass delegation assessment")
        save(self.directory / "investigation.json", envelope)
        save(self.directory / "assessment.json", assessment)
        save(self.directory / "attempts.json", self.attempts)
        root = self.records[-1]["digest"]
        if not check_receipts(self.records, root):
            raise ValueError("Capture integrity failed")
        save(self.directory / "manifest.json", {"mode": mode, "case": self.case["id"], "receiptRoot": root,
             "files": {path.name: sha256(path.read_bytes()).hexdigest() for path in sorted(self.directory.iterdir()) if path.is_file()},
             "limits": {"providerRequests": 6, "executionSeconds": 5, "memoryMiB": 128, "workspaceMiB": 4, "outputBytes": 16384},
             "warning": "Hashes detect changes relative to this baseline; they do not authenticate a producer."})
        return envelope
