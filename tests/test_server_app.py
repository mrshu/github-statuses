import os
import pathlib
import subprocess
import sys
import unittest
import unittest.mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# Must be set before importing server.app -- it reads this env var at
# import time to decide whether to start the live-polling background
# tasks, which hit real network endpoints, run a real subprocess, and make
# real local git commits. None of that belongs in a unit test.
os.environ["DISABLE_BACKGROUND_TASKS"] = "1"

from fastapi.testclient import TestClient  # noqa: E402
from prometheus_client import CONTENT_TYPE_LATEST  # noqa: E402

import server.app as server_app  # noqa: E402


class HealthAndMetricsEndpointTests(unittest.TestCase):
    def setUp(self):
        server_app.state["metrics_text"] = None
        server_app.state["metrics_last_success_ts"] = None
        server_app.state["incidents_last_success_ts"] = None
        self.client = TestClient(server_app.app)

    def test_liveness_is_always_ok(self):
        response = self.client.get("/health/liveness")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "alive")

    def test_readiness_is_503_before_first_successful_poll(self):
        response = self.client.get("/health/readiness")

        self.assertEqual(response.status_code, 503)
        self.assertEqual(
            response.json(),
            {"status": "unavailable", "checks": {"metrics": False, "incidents": False}},
        )

    def test_readiness_is_ok_once_both_pollers_have_succeeded(self):
        server_app.state["metrics_last_success_ts"] = 100
        server_app.state["incidents_last_success_ts"] = 100

        response = self.client.get("/health/readiness")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {"status": "ok", "checks": {"metrics": True, "incidents": True}},
        )

    def test_metrics_is_503_before_first_successful_poll(self):
        response = self.client.get("/metrics")

        self.assertEqual(response.status_code, 503)

    def test_metrics_serves_the_current_snapshot_as_text_plain(self):
        server_app.state["metrics_text"] = "github_status_overall 0\n"

        response = self.client.get("/metrics")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], CONTENT_TYPE_LATEST)
        self.assertEqual(response.text, "github_status_overall 0\n")

    def test_serves_the_static_site_at_root(self):
        response = self.client.get("/")

        self.assertEqual(response.status_code, 200)
        self.assertIn("<html", response.text.lower())

    def test_serves_parsed_incidents_under_parsed(self):
        response = self.client.get("/parsed/incidents.jsonl")

        self.assertEqual(response.status_code, 200)


class RefreshAtomFeedTests(unittest.TestCase):
    """
    Exercises refresh_atom_feed against a throwaway git repo instead of
    this checkout -- it makes a real commit, which must never land in the
    real project history from a test run.
    """

    def _make_scratch_repo(self, tmp_path):
        subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=tmp_path,
            check=True,
        )
        subprocess.run(["git", "config", "user.name", "Test"], cwd=tmp_path, check=True)

    def test_commits_only_when_content_changed(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = pathlib.Path(tmp)
            self._make_scratch_repo(tmp_path)
            atom_path = tmp_path / "github-status-history.atom"

            with (
                unittest.mock.patch.object(server_app, "ROOT", tmp_path),
                unittest.mock.patch.object(server_app, "ATOM_PATH", atom_path),
                unittest.mock.patch.object(
                    server_app.extract_incidents,
                    "fetch_url",
                    return_value="<feed>v1</feed>",
                ),
            ):
                changed = server_app.refresh_atom_feed()
                self.assertTrue(changed)
                self.assertEqual(atom_path.read_text(), "<feed>v1</feed>")
                log = subprocess.run(
                    ["git", "log", "--oneline"],
                    cwd=tmp_path,
                    check=True,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(len(log.stdout.strip().splitlines()), 1)

                # Same content again -- no new commit.
                changed_again = server_app.refresh_atom_feed()
                self.assertFalse(changed_again)
                log_again = subprocess.run(
                    ["git", "log", "--oneline"],
                    cwd=tmp_path,
                    check=True,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(len(log_again.stdout.strip().splitlines()), 1)

            with (
                unittest.mock.patch.object(server_app, "ROOT", tmp_path),
                unittest.mock.patch.object(server_app, "ATOM_PATH", atom_path),
                unittest.mock.patch.object(
                    server_app.extract_incidents,
                    "fetch_url",
                    return_value="<feed>v2</feed>",
                ),
            ):
                changed = server_app.refresh_atom_feed()
                self.assertTrue(changed)
                log = subprocess.run(
                    ["git", "log", "--oneline"],
                    cwd=tmp_path,
                    check=True,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(len(log.stdout.strip().splitlines()), 2)


class ExtractIncidentsArgsTests(unittest.TestCase):
    """
    Guards against server/app.py's subprocess invocation of
    extract_incidents.py silently drifting from what
    .github/workflows/parse.yaml actually runs -- there's no shared source
    for the two, so this has to compare them by hand.
    """

    def test_matches_parse_workflow_flags(self):
        parse_yaml = (ROOT / ".github" / "workflows" / "parse.yaml").read_text(
            encoding="utf-8"
        )

        self.assertIn("--out parsed", parse_yaml)
        self.assertIn("--incidents-format jsonl", parse_yaml)
        self.assertIn("--enrich-impact", parse_yaml)
        self.assertIn("--impact-delay 0.1", parse_yaml)

        self.assertEqual(
            server_app.EXTRACT_INCIDENTS_ARGS,
            [
                "--out",
                str(server_app.PARSED_DIR),
                "--incidents-format",
                "jsonl",
                "--enrich-impact",
                "--impact-delay",
                "0.1",
            ],
        )


if __name__ == "__main__":
    unittest.main()
