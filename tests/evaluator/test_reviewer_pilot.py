import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import reviewer_pilot as pilot


class ReviewerPilot(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        cls.work = Path(cls.temp.name)
        cls.packet = cls.work / "pilot"
        pilot.prepare(cls.packet)
        cls.rows, cls.digest = pilot.build_fixtures(cls.work / "frozen")
        cls.template = json.loads((cls.packet / "facilitator/sheet-A.json").read_bytes())

    def test_both_schedules_cover_the_same_seven_real_fixtures_under_opposite_methods(self):
        key = json.loads((self.packet / "facilitator/assignments.json").read_bytes())
        self.assertEqual(len(key), 7)
        for position, (expected, task) in enumerate(zip(self.rows, key)):
            self.assertEqual(expected["id"], task["handoff"])
            task_name = "task-" + task["task"]
            for schedule in ("A", "B"):
                reviewer = self.packet / ("reviewer-" + schedule)
                self.assertEqual({p.name for p in reviewer.iterdir()}, {"START.md", *(f"task-{i:02}" for i in range(1, 8))})
                sheet = (reviewer / "START.md").read_text()
                self.assertIn(f'| {task["task"]} | {pilot.method(schedule, position)} |', sheet)
                case = reviewer / task_name / "case.json"
                self.assertEqual(case.read_bytes(), (self.work / "frozen" / expected["caseFile"]).read_bytes())
                self.assertNotIn(expected["id"], sheet)
                pin = case.parent / "receiver-records"
                self.assertEqual(pin.is_dir(), expected["pin"] != "missing")
                if pin.is_dir():
                    self.assertEqual((pin / "pin.json").read_bytes(),
                                     (self.work / "frozen/receiver-baselines" / expected["pin"] / "pin.json").read_bytes())
            self.assertNotEqual(pilot.method("A", position), pilot.method("B", position))
            # Run the actual receiver command on the neutral input, independently of the scorer.
            folder = self.packet / "reviewer-A" / task_name
            cmd = ["node", "scripts/verify-case.mjs", "--json", "--case", str(folder / "case.json")]
            if (folder / "receiver-records").exists():
                cmd += ["--workflow", "Follow-up review", "--baseline-dir", str(folder / "receiver-records")]
            result = subprocess.run(cmd, cwd=ROOT, capture_output=True, check=False)
            self.assertEqual(json.loads(result.stdout)["disposition"], task["disposition"])
            self.assertEqual(result.returncode, 0 if task["disposition"] == "resolved" else 1)

    def test_real_cli_labels_an_unfilled_sheet_and_refuses_to_overwrite(self):
        cmd = [sys.executable, ROOT / "scripts/reviewer_pilot.py"]
        result = subprocess.run([*cmd, "score", self.packet / "facilitator/sheet-A.json"], capture_output=True, check=True)
        report = json.loads(result.stdout)
        self.assertEqual(report["source"], "unassigned")
        self.assertEqual(report["counts"]["unrun"], 7)
        self.assertIsNone(report["observedIncorrectClosures"])
        self.assertIsNone(report["incorrectResolvedCalls"])
        self.assertTrue(all(row["timeToSupportedSeconds"] is None for row in report["trials"]))
        with self.assertRaisesRegex(ValueError, "unused"):
            pilot.prepare(self.packet)
        oversized = self.work / "large.json"
        oversized.write_bytes(b" " * 32769)
        failed = subprocess.run([*cmd, "score", oversized], capture_output=True, check=False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn(b"32 KiB", failed.stderr)

    def test_supported_times_exclude_wrong_unsupported_abandoned_and_unrun(self):
        sheet = copy.deepcopy(self.template)
        sheet["source"] = "automated-rehearsal"
        for row, key in zip(sheet["trials"][:5], self.rows):
            row.update(end="answered", setupSeconds=5, elapsedSeconds=9, assisted=False, incorrectClosures=0,
                       disposition=key["disposition"], reason=key["reason"], citations=dict.fromkeys(pilot.EVIDENCE, True))
        sheet["trials"][0].update(assisted=True, friction=["locate-action"])
        sheet["trials"][1].update(disposition="resolved", incorrectClosures=2)
        sheet["trials"][2]["citations"]["grant"] = False
        sheet["trials"][3]["reason"] = "other"
        sheet["trials"][4].update(end="abandoned", disposition=None, reason=None, citations=dict.fromkeys(pilot.EVIDENCE))
        report = pilot.score(sheet, self.rows, self.digest)
        self.assertEqual(report["source"], "automated-rehearsal")
        self.assertEqual(report["counts"], {"supported": 1, "incorrect-disposition": 1, "unsupported": 2, "abandoned": 1, "unrun": 2})
        self.assertEqual(report["trials"][0]["timeToSupportedSeconds"], 9)
        self.assertEqual(report["trials"][0]["setupSeconds"], 5)
        self.assertTrue(report["trials"][0]["assisted"])
        self.assertTrue(all(row["timeToSupportedSeconds"] is None for row in report["trials"][1:]))
        self.assertEqual(report["observedIncorrectClosures"], 2)
        self.assertEqual(report["incorrectResolvedCalls"], 1)
        self.assertEqual(report["trials"][2]["missingCitations"], ["grant"])

    def test_stale_incomplete_duplicate_or_unlabelled_observations_are_rejected(self):
        for modify in (lambda s: s.update(kitDigest="older"), lambda s: s["trials"].pop(),
                       lambda s: s["trials"][1].update(task="01"), lambda s: s.update(participant="private"),
                       lambda s: s["trials"][0].update(end="answered"),
                       lambda s: s["trials"][0].update(elapsedSeconds=0)):
            sheet = copy.deepcopy(self.template)
            modify(sheet)
            with self.assertRaises(ValueError):
                pilot.score(sheet, self.rows, self.digest)


if __name__ == "__main__":
    unittest.main()
