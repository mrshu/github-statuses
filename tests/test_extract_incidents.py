import pathlib
import sys
import unittest
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT / "scripts"))

import extract_incidents as ei  # noqa: E402


class ExtractIncidentsTests(unittest.TestCase):
    def test_infer_year_boundary(self):
        reference = datetime(2025, 1, 2, 12, 0, tzinfo=timezone.utc)
        result = ei.infer_year(reference, 12, 31, 23, 0)
        self.assertEqual(result.year, 2024)

    def test_impact_window_cross_midnight(self):
        message = (
            "On January 13, 2025, between 23:35 UTC and 00:24 UTC "
            "all Git operations were unavailable due to a configuration change."
        )
        start_at, end_at, _ = ei.parse_impact_window([message])
        self.assertEqual(start_at.isoformat(), "2025-01-13T23:35:00+00:00")
        self.assertEqual(end_at.isoformat(), "2025-01-14T00:24:00+00:00")

    def test_impact_window_alt_phrase(self):
        message = (
            "We experienced disruption between 01:00 UTC and 14:00 UTC, "
            "on January 28, 2024, impacting avatars."
        )
        start_at, end_at, _ = ei.parse_impact_window([message])
        self.assertEqual(start_at.isoformat(), "2024-01-28T01:00:00+00:00")
        self.assertEqual(end_at.isoformat(), "2024-01-28T14:00:00+00:00")

    def test_finalize_prefers_postmortem_window(self):
        published = datetime(2025, 1, 13, 23, 44, tzinfo=timezone.utc)
        updates = [
            {
                "at": datetime(2025, 1, 13, 23, 44, tzinfo=timezone.utc),
                "status": "Investigating",
                "message": "Investigating reports of an outage.",
            },
            {
                "at": datetime(2025, 1, 14, 0, 28, tzinfo=timezone.utc),
                "status": "Resolved",
                "message": (
                    "On January 13, 2025, between 23:35 UTC and 00:24 UTC "
                    "all Git operations were unavailable due to a configuration change."
                ),
            },
        ]
        incident = {
            "id": "test",
            "entry_id": "test",
            "title": "Incident with Git Operations",
            "url": "https://example.com",
            "published_at": published,
            "updated_at": published,
            "updates": {ei.update_key(u): u for u in updates},
        }
        finalized = ei.finalize_incident(incident)
        self.assertEqual(finalized["downtime_start"], "2025-01-13T23:35:00Z")
        self.assertEqual(finalized["downtime_end"], "2025-01-14T00:24:00Z")
        self.assertIsNotNone(finalized["impact_window"])

    def test_finalize_orders_by_status(self):
        published = datetime(2026, 1, 1, 22, 0, tzinfo=timezone.utc)
        same_time = datetime(2026, 1, 1, 22, 31, tzinfo=timezone.utc)
        updates = [
            {"at": same_time, "status": "Update", "message": "Update text."},
            {"at": same_time, "status": "Investigating", "message": "Investigation started."},
            {"at": same_time, "status": "Resolved", "message": "Resolved."},
        ]
        incident = {
            "id": "order-test",
            "entry_id": "order-test",
            "title": "Ordering test",
            "url": None,
            "published_at": published,
            "updated_at": published,
            "updates": {ei.update_key(u): u for u in updates},
        }
        finalized = ei.finalize_incident(incident)
        statuses = [u["status"] for u in finalized["updates"]]
        self.assertEqual(statuses, ["Investigating", "Update", "Resolved"])

    def test_build_segments(self):
        updates = [
            {"at": "2025-01-01T00:00:00Z", "status": "Investigating", "message": "Start."},
            {"at": "2025-01-01T00:10:00Z", "status": "Update", "message": "Update."},
            {"at": "2025-01-01T00:20:00Z", "status": "Resolved", "message": "Done."},
        ]
        incident = {"id": "seg-test", "updates": updates}
        segments = ei.build_segments(incident)
        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0]["start_at"], "2025-01-01T00:00:00Z")
        self.assertEqual(segments[0]["end_at"], "2025-01-01T00:10:00Z")
        self.assertEqual(segments[0]["status"], "Investigating")

    def test_overlaps_window(self):
        incident = {
            "downtime_start": "2025-01-10T00:00:00Z",
            "downtime_end": "2025-01-10T02:00:00Z",
            "published_at": "2025-01-10T00:00:00Z",
            "updated_at": "2025-01-10T02:00:00Z",
        }
        since = datetime(2025, 1, 9, 0, 0, tzinfo=timezone.utc)
        until = datetime(2025, 1, 11, 0, 0, tzinfo=timezone.utc)
        self.assertTrue(ei.overlaps_window(incident, since, until))
        since = datetime(2025, 1, 11, 0, 0, tzinfo=timezone.utc)
        self.assertFalse(ei.overlaps_window(incident, since, None))

    def test_extract_impact_from_html(self):
        html = '<div class="incident-title impact impact-major">Major outage</div>'
        self.assertEqual(ei.extract_impact_from_html(html), "major")

    def test_extract_impact_from_html_none(self):
        html = '<div class="incident-title">No impact class</div>'
        self.assertIsNone(ei.extract_impact_from_html(html))

    def test_extract_components_from_html(self):
        html = '<div>This incident affected: Git Operations, Webhooks, and API Requests.</div>'
        self.assertEqual(
            ei.extract_components_from_html(html),
            ["Git Operations", "Webhooks", "API Requests"],
        )

    def test_extract_components_from_html_scheduled(self):
        html = '<div>This scheduled maintenance affected: Actions.</div>'
        self.assertEqual(ei.extract_components_from_html(html), ["Actions"])

    def test_extract_components_from_html_none(self):
        html = '<div>No components listed here.</div>'
        self.assertIsNone(ei.extract_components_from_html(html))

    def test_infer_components_from_text(self):
        self.assertEqual(ei.infer_components_from_text("Incident With Copilot"), ["Copilot"])

    def test_infer_components_from_text_none(self):
        self.assertIsNone(ei.infer_components_from_text("Disruptions in Login and Signup Flows"))


if __name__ == "__main__":
    unittest.main()
