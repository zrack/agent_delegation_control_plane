"""Verify the served asset boundary and usable module entrypoints."""
import http.client
import importlib.util
from pathlib import Path
import threading
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("dashboard_server", ROOT / "scripts/serve.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ServerContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = module.make_server(0)
        cls.worker = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.worker.join(timeout=2)

    def request(self, path, method="GET", headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        connection.request(method, path, headers=headers or {})
        response = connection.getresponse()
        data = response.read()
        result = response.status, dict(response.getheaders()), data
        connection.close()
        return result

    def test_all_declared_assets_and_module_mime(self):
        for path in module.ASSETS:
            with self.subTest(path=path):
                status, headers, body = self.request(path)
                self.assertEqual(status, 200)
                self.assertTrue(body)
                self.assertIn("connect-src 'none'", headers["Content-Security-Policy"])
                self.assertEqual(headers["Cache-Control"], "no-store")
                if path.endswith((".js", ".mjs")):
                    self.assertIn(headers["Content-type"].split(";")[0], ("text/javascript", "application/javascript"))

    def test_repository_files_traversal_and_listings_are_unavailable(self):
        for path in ["/AGENTS.md", "/.private-records.json", "/../AGENTS.md", "/%2e%2e/AGENTS.md", "/scripts/serve.py", "/src/", "/missing", "//AGENTS.md"]:
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0], 404)

    def test_external_hosts_and_writes_are_rejected(self):
        self.assertEqual(self.request("/", headers={"Host": "attacker.example"})[0], 403)
        for method in ["POST", "PUT", "DELETE"]:
            self.assertEqual(self.request("/", method)[0], 501)

    def test_document_has_local_entrypoints_and_no_external_dependencies(self):
        _, _, body = self.request("/")
        html = body.decode()
        for asset in ["/styles.css", "/app.js"]:
            self.assertIn(asset, html)
        self.assertIn('type="module"', html)
        self.assertNotIn("https://", html)
        self.assertIn('id="investigation"', html)


if __name__ == "__main__":
    unittest.main()
