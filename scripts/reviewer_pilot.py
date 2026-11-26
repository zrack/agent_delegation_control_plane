#!/usr/bin/env python3
"""Prepare neutral handoff tasks and score one locally observed reviewer session."""
import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
ORDER = ("history-off", "altered-original", "open-follow-up", "missing-pin",
         "history-on", "altered-follow-up", "conflicting-pin")
EVIDENCE = ("action", "grant", "receipt", "history")
FRICTION = ("setup", "locate-action", "trace-grant", "check-pin", "verify-receipt",
            "attribute-history", "interpret-closure", "other")
SOURCES = ("independent-human", "maintainer-rehearsal", "automated-rehearsal")


def build_fixtures(directory):
    directory.mkdir()
    subprocess.run(["node", str(ROOT / "scripts/codex-handoff-fixtures.mjs"), str(directory)], check=True)
    matrix = json.loads((DOCS / "codex-handoff/facilitator/outcomes.json").read_bytes())
    by_id = {row["id"]: row for row in matrix["scenarios"]}
    if set(ORDER) != set(by_id) or len(ORDER) != len(matrix["scenarios"]):
        raise ValueError("The handoff matrix changed. Update the two assignments before use.")
    # Bind observations to the ordered outcomes and actual case and receiver records.
    rows = [by_id[case_id] for case_id in ORDER]
    files = {}
    for folder in ("cases", "pins", "receiver-baselines"):
        for path in sorted((directory / folder).rglob("*")):
            if path.is_file():
                files[path.relative_to(directory).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    identity = json.dumps([rows, files], sort_keys=True).encode()
    return rows, hashlib.sha256(identity).hexdigest()


def method(schedule, position):
    dashboard_first = schedule == "A"
    return "dashboard" if (position % 2 == 0) == dashboard_first else "ordinary"


def blank(task):
    return {"task": task, "end": "unrun", "setupSeconds": None, "elapsedSeconds": None,
            "disposition": None, "reason": None, "citations": dict.fromkeys(EVIDENCE),
            "assisted": None, "incorrectClosures": None, "friction": []}


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def prepare(output):
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() or output.is_symlink():
        raise ValueError("Choose an unused output directory.")
    with tempfile.TemporaryDirectory(dir=output.parent) as temp:
        fixtures = Path(temp) / "fixtures"
        rows, digest = build_fixtures(fixtures)
        packet = Path(temp) / "pilot"
        facilitator = packet / "facilitator"
        facilitator.mkdir(parents=True)
        shutil.copyfile(DOCS / "codex-handoff/facilitator/ANSWER_KEY.md", facilitator / "HANDOFF_KEY.md")
        shutil.copyfile(DOCS / "reviewer-pilot/FACILITATOR.md", facilitator / "START.md")
        task_ids = [f"{index:02}" for index in range(1, len(rows) + 1)]
        write_json(facilitator / "assignments.json",
                   [dict(task=task, handoff=row["id"], disposition=row["disposition"], reason=row["reason"],
                         senderHistory=row["senderHistory"], localHistory=row["localHistory"])
                    for task, row in zip(task_ids, rows)])
        for schedule in ("A", "B"):
            reviewer = packet / ("reviewer-" + schedule)
            reviewer.mkdir()
            sheet = (DOCS / "reviewer-pilot/TASK_SHEET.md").read_text(encoding="utf-8")
            for i, (task, row) in enumerate(zip(task_ids, rows)):
                dest = reviewer / ("task-" + task)
                dest.mkdir()
                shutil.copyfile(fixtures / row["caseFile"], dest / "case.json")
                if row["pin"] != "missing":
                    shutil.copytree(fixtures / "pins" / row["pin"], dest / "receiver-capture")
                    shutil.copytree(fixtures / "receiver-baselines" / row["pin"], dest / "receiver-records")
                sheet += f"| {task} | {method(schedule, i)} |\n"
            (reviewer / "START.md").write_text(sheet, encoding="utf-8")
            write_json(facilitator / f"sheet-{schedule}.json",
                       {"version": 1, "kitDigest": digest, "schedule": schedule, "source": "unassigned",
                        "trials": [blank(task) for task in task_ids]})
        # mkdir claims the destination exclusively, even if two prepares race.
        output.mkdir()
        moved = []
        try:
            for child in packet.iterdir():
                target = output / child.name
                child.rename(target)
                moved.append(target)
        except OSError:
            for child in moved:
                shutil.rmtree(child)
            output.rmdir()
            raise


def score(sheet, rows, digest):
    def require(condition, message):
        if not condition:
            raise ValueError(message)

    require(isinstance(sheet, dict) and set(sheet) == {"version", "kitDigest", "schedule", "source", "trials"},
            "Expected one pilot observation sheet.")
    require(type(sheet["version"]) is int and sheet["version"] == 1 and sheet["kitDigest"] == digest,
            "The observation sheet and current handoff kit do not match.")
    schedule, source, trials = sheet["schedule"], sheet["source"], sheet["trials"]
    require(schedule in ("A", "B") and source in ("unassigned", *SOURCES), "Unknown schedule or observation source.")
    require(isinstance(trials, list) and len(trials) == len(rows), "Preserve all assigned rows, including unrun tasks.")
    report = []
    reasons = tuple(row["reason"] for row in rows) + ("other",)
    for i, (trial, expected) in enumerate(zip(trials, rows)):
        task = f"{i + 1:02}"
        empty = blank(task)
        require(isinstance(trial, dict) and set(trial) == set(empty) and trial["task"] == task,
                "Missing, reordered or unsupported fields in task " + task)
        result = {"task": task, "scenario": expected["id"], "method": method(schedule, i),
                  "result": "unrun", "timeToSupportedSeconds": None}
        report.append(result)
        if trial["end"] == "unrun":
            require(trial == empty, "An unrun task contains observations at task " + task)
            continue
        require(source in SOURCES, "Identify the observation source before scoring a trial.")
        require(trial["end"] in ("answered", "abandoned"), "Unknown endpoint at task " + task)
        for field in ("setupSeconds", "elapsedSeconds", "incorrectClosures"):
            require(type(trial[field]) is int and trial[field] >= 0, "Enter a nonnegative integer for " + field + " at task " + task)
        require(type(trial["assisted"]) is bool, "Record assistance at task " + task)
        friction = trial["friction"]
        require(isinstance(friction, list) and all(code in FRICTION for code in friction)
                and len(set(friction)) == len(friction), "Unknown or repeated friction code at task " + task)
        citations = trial["citations"]
        require(isinstance(citations, dict) and set(citations) == set(EVIDENCE)
                and all(mark is None or type(mark) is bool for mark in citations.values()),
                "Invalid facilitator citations at task " + task)
        result.update({k: trial[k] for k in ("setupSeconds", "elapsedSeconds", "assisted", "incorrectClosures", "friction")})
        if trial["end"] == "abandoned":
            require(trial["disposition"] is None and trial["reason"] is None,
                    "Record a submitted answer as answered at task " + task)
            result["result"] = "abandoned"
            continue
        require(trial["disposition"] in ("open-ready", "open-blocked", "resolved", "unsure")
                and trial["reason"] in reasons and None not in citations.values(),
                "Complete the decision, reason and citation checks at task " + task)
        result.update(disposition=trial["disposition"], reason=trial["reason"],
                      missingCitations=[name for name in EVIDENCE if not citations[name]])
        result["incorrectResolvedCall"] = trial["disposition"] == "resolved" and expected["disposition"] != "resolved"
        if trial["disposition"] != expected["disposition"]:
            result["result"] = "incorrect-disposition"
        elif trial["reason"] != expected["reason"] or result["missingCitations"]:
            result["result"] = "unsupported"
        else:
            result["result"] = "supported"
            result["timeToSupportedSeconds"] = trial["elapsedSeconds"]
    observed = [row for row in report if row["result"] != "unrun"]
    answered = [row for row in observed if row["result"] != "abandoned"]
    return {"version": 1, "kitDigest": digest, "schedule": schedule, "source": source,
            "counts": {status: sum(row["result"] == status for row in report) for status in
                       ("supported", "unsupported", "incorrect-disposition", "abandoned", "unrun")},
            "observedIncorrectClosures": sum(row["incorrectClosures"] for row in observed) if observed else None,
            "incorrectResolvedCalls": sum(row["incorrectResolvedCall"] for row in answered) if answered else None,
            "trials": report}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("prepare").add_argument("--output", required=True, type=Path)
    commands.add_parser("score").add_argument("sheet", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            prepare(args.output)
            print("Give each reviewer their assigned reviewer folder. Open facilitator/START.md separately.")
        else:
            if not args.sheet.is_file():
                raise ValueError("Select a regular observation file.")
            with args.sheet.open("rb") as handle:
                raw = handle.read(32769)
            if len(raw) > 32768:
                raise ValueError("The observation sheet exceeds 32 KiB.")
            with tempfile.TemporaryDirectory() as temp:
                rows, digest = build_fixtures(Path(temp) / "fixtures")
                print(json.dumps(score(json.loads(raw), rows, digest), indent=2))
    except (ValueError, OSError, subprocess.CalledProcessError, RecursionError) as error:
        parser.exit(2, f"Could not process the local pilot. {error}\n")


if __name__ == "__main__":
    main()
