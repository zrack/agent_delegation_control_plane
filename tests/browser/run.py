"""Run the real-browser checks against the ZIP built from this checkout."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Thread
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from serve import DashboardHandler, make_server


class QuietDashboardHandler(DashboardHandler):
    def log_request(self, code="-", size="-"):
        if isinstance(code, int) and code >= 400:
            super().log_request(code, size)


def build_demo(work):
    output = work / "built"
    subprocess.run([sys.executable, "scripts/build_codex_handoff.py", "--output", str(output)],
                   cwd=ROOT, check=True)
    archive, = output.glob("*.zip")
    extracted = work / "extracted"
    with ZipFile(archive) as demo:
        demo.extractall(extracted)
    return extracted / "adcp-codex-handoff-demo"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kit", type=Path, help="Use an already extracted fictional handoff kit")
    args = parser.parse_args()
    with TemporaryDirectory(prefix="adcp-acceptance-") as temp, make_server(0) as server:
        work = Path(temp)
        kit = args.kit.resolve() if args.kit else build_demo(work)
        assert (kit / "cases/history-on.json").is_file(), "Fictional Codex handoff kit is missing"
        env = dict(os.environ, ADCP_TEST_ORIGIN=f"http://127.0.0.1:{server.server_port}",
                   ADCP_TEST_KIT=str(kit), ADCP_TEST_WORK=temp)
        server.RequestHandlerClass = QuietDashboardHandler
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            tests = sorted((ROOT / "tests/browser").glob("*.test.mjs"))
            return subprocess.run(["node", "--test", *tests], cwd=ROOT, env=env).returncode
        finally:
            server.shutdown()
            thread.join()


if __name__ == "__main__":
    sys.exit(main())
