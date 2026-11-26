#!/usr/bin/env python3
"""Build the fictional portable Codex handoff kit with Python and Node 22+."""
import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KIT = "adcp-codex-handoff-demo"
VERSION = "v0.1.0-alpha.16"
ARCHIVE = f"{KIT}-{VERSION}.zip"


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(output):
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() or output.is_symlink():
        raise FileExistsError("Choose a new output directory.")
    with tempfile.TemporaryDirectory(prefix=".adcp-handoff-", dir=output.parent) as stage_name:
        stage = Path(stage_name)
        kit = stage / KIT
        kit.mkdir()
        subprocess.run(["node", str(ROOT / "scripts/codex-handoff-fixtures.mjs"), str(kit)], check=True)
        docs = ROOT / "docs/codex-handoff"
        for name in ("reviewer", "facilitator"):
            shutil.copytree(docs / name, kit / name)
        for name in ("LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"):
            shutil.copyfile(ROOT / name, kit / name)
        shutil.copyfile(docs / "START_HERE.md", kit / "START_HERE.md")
        descriptor = {"format": "adcp-codex-handoff-demo", "version": VERSION, "firstExercise": "reviewer/TASK_SHEET.md"}
        (kit / "KIT.json").write_bytes((json.dumps(descriptor, indent=2) + "\n").encode("utf-8"))
        files = sorted(path for path in kit.rglob("*") if path.is_file())
        manifest = "".join(f"{sha256(path)}  {path.relative_to(kit).as_posix()}\n" for path in files)
        sums = kit / "SHA256SUMS"
        sums.write_bytes(manifest.encode("utf-8"))

        # The stored method, fixed timestamp and permissions keep bytes identical across
        # checkout locations, file clocks, process umasks and compression-library versions.
        with zipfile.ZipFile(stage / ARCHIVE, "x", compression=zipfile.ZIP_STORED) as archive:
            for path in sorted([*files, sums]):
                info = zipfile.ZipInfo(path.relative_to(stage).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                archive.writestr(info, path.read_bytes())
        checksum = sha256(stage / ARCHIVE)
        checksum_file = stage / (ARCHIVE + ".sha256")
        checksum_file.write_bytes(f"{checksum}  {ARCHIVE}\n".encode("ascii"))
        # Claim the new destination only after the complete build succeeds.
        output.mkdir()
        try:
            for path in (kit, stage / ARCHIVE, checksum_file):
                path.rename(output / path.name)
        except OSError:
            for name in (ARCHIVE, checksum_file.name):
                (output / name).unlink(missing_ok=True)
            if (output / KIT).exists():
                shutil.rmtree(output / KIT)
            output.rmdir()
            raise
        print(f"{output / ARCHIVE}\nSHA-256 {checksum}\nStart with {output / KIT / 'reviewer/TASK_SHEET.md'}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "output" / f"codex-handoff-{VERSION}",
                        help="New output directory for the kit, ZIP and checksum")
    args = parser.parse_args()
    try:
        build(args.output.absolute())
    except (OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Could not build the handoff kit. {error}\n")


if __name__ == "__main__":
    main()
