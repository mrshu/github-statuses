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

    def test_impact_window_from_to_utc(self):
        message = (
            "On March 27, 2026, from 02:30 to 04:56 UTC, "
            "a misconfiguration in our rate limiting system caused errors."
        )
        start_at, end_at, _ = ei.parse_impact_window([message])
        self.assertEqual(start_at.isoformat(), "2026-03-27T02:30:00+00:00")
        self.assertEqual(end_at.isoformat(), "2026-03-27T04:56:00+00:00")

    def test_impact_window_from_utc_to_utc(self):
        message = (
            "On August 28, 2024, from 22:37 UTC to 04:47 UTC, "
            "some GitHub services were degraded."
        )
        start_at, end_at, _ = ei.parse_impact_window([message])
        self.assertEqual(start_at.isoformat(), "2024-08-28T22:37:00+00:00")
        self.assertEqual(end_at.isoformat(), "2024-08-29T04:47:00+00:00")

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

    def test_select_components_from_entities(self):
        entities = {
            "Copilot": [{"text": "Copilot", "confidence": 0.88}],
            "Actions": [{"text": "Actions", "confidence": 0.62}],
        }
        selected, confidences = ei.select_components_from_entities(entities, 0.75)
        self.assertEqual(selected, ["Copilot"])
        self.assertGreaterEqual(confidences["Copilot"], 0.88)

    def test_select_components_from_entities_empty(self):
        selected, confidences = ei.select_components_from_entities({}, 0.75)
        self.assertIsNone(selected)
        self.assertEqual(confidences, {})

    def test_filter_components_by_alias(self):
        components = ["Copilot", "Actions"]
        text = "Incident With Copilot impacting suggestions."
        filtered = ei.filter_components_by_alias(components, text)
        self.assertEqual(filtered, ["Copilot"])

    def test_filter_components_by_alias_generic_issues(self):
        components = ["Issues"]
        text = "We are investigating issues with service reliability."
        filtered = ei.filter_components_by_alias(components, text)
        self.assertIsNone(filtered)

    def test_update_key_collapses_edited_resolution(self):
        at = datetime(2026, 6, 10, 16, 39, tzinfo=timezone.utc)
        terse = {"at": at, "status": "Resolved", "message": "This incident has been resolved."}
        rca = {"at": at, "status": "Resolved", "message": "On 2026-06-10 a config change..."}
        self.assertEqual(ei.update_key(terse), ei.update_key(rca))

    def test_update_key_keeps_simultaneous_component_updates(self):
        at = datetime(2026, 6, 10, 16, 39, tzinfo=timezone.utc)
        pages = {"at": at, "status": "Update", "message": "GitHub Pages is operating normally."}
        packages = {"at": at, "status": "Update", "message": "GitHub Packages is degraded."}
        self.assertNotEqual(ei.update_key(pages), ei.update_key(packages))

    def test_merge_incident_lets_edited_resolution_win(self):
        at = datetime(2026, 6, 10, 16, 39, tzinfo=timezone.utc)
        existing = {
            "id": "1",
            "title": "Incident",
            "updates": {},
            "published_at": None,
            "updated_at": None,
            "url": "https://example/1",
            "entry_id": "1",
        }
        for message in ("This incident has been resolved.", "On 2026-06-10 a config change..."):
            ei.merge_incident(
                existing,
                {
                    "id": "1",
                    "title": "Incident",
                    "updates": [{"at": at, "status": "Resolved", "message": message}],
                    "published_at": None,
                    "updated_at": None,
                    "url": "https://example/1",
                    "entry_id": "1",
                },
            )
        self.assertEqual(len(existing["updates"]), 1)
        kept = next(iter(existing["updates"].values()))
        self.assertEqual(kept["message"], "On 2026-06-10 a config change...")

    def test_gliner_fingerprint_tracks_inputs(self):
        base = ei.gliner_fingerprint("some text", "model-a", 0.5)
        self.assertEqual(base, ei.gliner_fingerprint("some text", "model-a", 0.5))
        self.assertNotEqual(base, ei.gliner_fingerprint("some text!", "model-a", 0.5))
        self.assertNotEqual(base, ei.gliner_fingerprint("some text", "model-b", 0.5))
        self.assertNotEqual(base, ei.gliner_fingerprint("some text", "model-a", 0.9))

    def test_inference_reruns_when_incident_text_grows(self):
        calls = []

        class Model:
            def extract_entities(self, text, schema, include_confidence=True):
                calls.append(text)
                return {"entities": {}}

        original = ei.get_gliner_model
        ei.get_gliner_model = lambda name: Model()
        try:
            cache = {}
            thin = {"url": "https://example/1", "title": "Incident with Actions", "updates": []}
            ei.infer_components_with_gliner2(thin, "m", 0.5, cache)
            ei.infer_components_with_gliner2(dict(thin), "m", 0.5, cache)
            self.assertEqual(len(calls), 1, "identical text must reuse the cached inference")

            grown = dict(thin, updates=[{"status": "Update", "message": "Runs are delayed."}])
            ei.infer_components_with_gliner2(grown, "m", 0.5, cache)
            self.assertEqual(len(calls), 2, "a cached empty result must not freeze the incident")
        finally:
            ei.get_gliner_model = original

    def test_inference_falls_back_to_cache_when_model_unavailable(self):
        original = ei.get_gliner_model
        ei.get_gliner_model = lambda name: None
        try:
            cache = {
                "https://example/1": {
                    "components_gliner": ["Actions"],
                    "components_gliner_confidence": {"Actions": 0.9},
                    "components_gliner_fp": "stale",
                }
            }
            incident = {"url": "https://example/1", "title": "Incident with Actions", "updates": []}
            ei.infer_components_with_gliner2(incident, "m", 0.5, cache)
            self.assertEqual(incident["components"], ["Actions"])
            self.assertEqual(incident["components_source"], "gliner2")
        finally:
            ei.get_gliner_model = original


if __name__ == "__main__":
    unittest.main()
