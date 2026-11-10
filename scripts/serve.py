#!/usr/bin/env python3
"""Serve only the local synthetic dashboard, on IPv4 loopback."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
import argparse

ROOT = Path(__file__).resolve().parents[1] / "src"
ASSETS = {"/": "index.html", "/index.html": "index.html", "/styles.css": "styles.css",
          "/app.js": "app.js", "/fixtures.mjs": "fixtures.mjs", "/evaluator.mjs": "evaluator.mjs",
          "/import.mjs": "import.mjs", "/storage.mjs": "storage.mjs", "/comparison.mjs": "comparison.mjs",
          "/review.mjs": "review.mjs", "/review-view.mjs": "review-view.mjs"}


class DashboardHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_head(self):
        host = self.headers.get("Host", "")
        expected = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        if host not in expected:
            self.send_error(403, "Local host required")
            return None
        asset = ASSETS.get(urlsplit(self.path).path)
        if asset is None or (ROOT / asset).is_symlink() or not (ROOT / asset).is_file():
            self.send_error(404, "Asset not found")
            return None
        self.path = "/" + asset
        return super().send_head()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
        super().end_headers()


def make_server(port=48731):
    return ThreadingHTTPServer(("127.0.0.1", port), DashboardHandler)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=48731)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    with make_server(args.port) as server:
        print(f"Delegation dashboard: http://127.0.0.1:{server.server_port}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
