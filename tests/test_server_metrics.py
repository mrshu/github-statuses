import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))

import server.metrics as gm  # noqa: E402


def _component(name, status, showcase=True):
    return {
        "id": name,
        "name": name,
        "status": status,
        "updated_at": "2026-01-01T00:00:00Z",
        "showcase": showcase,
    }


def _incident(id_, status, impact, created_at="2026-01-01T00:00:00Z", resolved_at=None):
    return {
        "id": id_,
        "name": id_,
        "status": status,
        "impact": impact,
        "created_at": created_at,
        "updated_at": created_at,
        "resolved_at": resolved_at,
    }


class ComputeStatusMetricsTests(unittest.TestCase):
    def test_counts_degraded_and_maps_overall_indicator(self):
        summary = {"status": {"indicator": "major"}}
        components = [
            _component("api", "operational"),
            _component("pages", "major_outage"),
        ]

        result = gm.compute_status_metrics(summary, components)

        self.assertEqual(result["overall"], 2)
        self.assertEqual(result["degraded_total"], 1)
        self.assertEqual(
            result["per_component"],
            [{"component": "api", "value": 0}, {"component": "pages", "value": 3}],
        )

    def test_defaults_unknown_indicator_and_status_to_zero(self):
        result = gm.compute_status_metrics(
            {"status": {"indicator": "unknown"}}, [_component("api", "some_new_status")]
        )

        self.assertEqual(result["overall"], 0)
        self.assertEqual(result["per_component"][0]["value"], 0)

    def test_excludes_non_showcase_components(self):
        components = [
            _component("api", "operational"),
            _component(
                "Visit www.githubstatus.com for more information",
                "operational",
                showcase=False,
            ),
        ]

        result = gm.compute_status_metrics(
            {"status": {"indicator": "none"}}, components
        )

        self.assertEqual([c["component"] for c in result["per_component"]], ["api"])

    def test_non_showcase_components_are_excluded_from_degraded_total(self):
        components = [
            _component("api", "operational"),
            _component(
                "Visit www.githubstatus.com for more information",
                "major_outage",
                showcase=False,
            ),
        ]

        result = gm.compute_status_metrics(
            {"status": {"indicator": "none"}}, components
        )

        self.assertEqual(result["degraded_total"], 0)


class ComputeIncidentMetricsTests(unittest.TestCase):
    def test_reflects_current_snapshot_only(self):
        incidents = [
            _incident("a", "investigating", "major"),
            _incident("b", "resolved", "critical", resolved_at="2026-01-01T01:00:00Z"),
            _incident("c", "monitoring", "major"),
        ]

        result = gm.compute_incident_metrics(incidents)

        self.assertEqual(result["open_by_impact"]["major"], 2)
        self.assertEqual(result["open_by_impact"]["critical"], 0)
        self.assertEqual(result["open_total"], 2)
        self.assertEqual(result["total_by_impact"]["major"], 2)
        self.assertEqual(result["total_by_impact"]["critical"], 1)
        self.assertEqual(result["resolved_by_impact"]["critical"], 1)
        self.assertEqual(result["resolved_by_impact"]["major"], 0)

    def test_computes_average_duration_per_impact(self):
        incidents = [
            _incident(
                "a",
                "resolved",
                "major",
                created_at="2026-01-01T00:00:00Z",
                resolved_at="2026-01-01T01:00:00Z",
            ),
            _incident(
                "b",
                "resolved",
                "major",
                created_at="2026-01-01T00:00:00Z",
                resolved_at="2026-01-01T03:00:00Z",
            ),
        ]

        result = gm.compute_incident_metrics(incidents)

        self.assertEqual(result["average_duration_by_impact"]["major"], 7200.0)

    def test_zero_fills_buckets_with_nothing_this_run(self):
        result = gm.compute_incident_metrics([])

        self.assertEqual(result["resolved_by_impact"]["critical"], 0)
        self.assertEqual(result["average_duration_by_impact"]["critical"], 0.0)

    def test_ignores_incidents_with_unrecognized_impact(self):
        result = gm.compute_incident_metrics(
            [_incident("a", "investigating", "maintenance")]
        )

        self.assertEqual(result["open_total"], 0)
        self.assertEqual(
            result["total_by_impact"],
            {"none": 0, "minor": 0, "major": 0, "critical": 0},
        )


class ParseTagsTests(unittest.TestCase):
    def test_parses_key_value_pairs(self):
        self.assertEqual(
            gm.parse_tags(["env:prod", "team:platform"]),
            {"env": "prod", "team": "platform"},
        )

    def test_sanitizes_invalid_label_name_characters(self):
        self.assertEqual(gm.parse_tags(["Env-Name:prod"]), {"env_name": "prod"})

    def test_prefixes_label_names_starting_with_a_digit(self):
        self.assertEqual(gm.parse_tags(["1env:prod"]), {"_1env": "prod"})

    def test_bare_tag_without_colon_uses_key_as_value(self):
        self.assertEqual(gm.parse_tags(["prod"]), {"prod": "prod"})


class RenderPrometheusTextTests(unittest.TestCase):
    def test_emits_help_type_lines_and_every_impact_bucket(self):
        status = gm.compute_status_metrics(
            {"status": {"indicator": "none"}}, [_component("api", "operational")]
        )
        incident_metrics = gm.compute_incident_metrics(
            [_incident("a", "investigating", "major")]
        )

        text = gm.render_prometheus_text(status, incident_metrics, 100)

        self.assertIn(
            "# HELP github_status_overall Overall page status indicator", text
        )
        self.assertIn("# TYPE github_status_overall gauge", text)
        self.assertIn('github_status_component{component="api"} 0', text)
        self.assertIn('github_incidents_created{impact="major"} 1', text)
        self.assertIn('github_incidents_created{impact="none"} 0', text)
        self.assertIn("github_status_collector_last_success_ts 100", text)

    def test_help_lines_spell_out_every_status_code(self):
        status = gm.compute_status_metrics({"status": {"indicator": "none"}}, [])
        incident_metrics = gm.compute_incident_metrics([])

        text = gm.render_prometheus_text(status, incident_metrics, 100)

        self.assertIn(
            "# HELP github_status_overall Overall page status indicator "
            "(none=0, minor=1, major=2, critical=3)",
            text,
        )
        self.assertIn(
            "# HELP github_status_component Per-component status "
            "(operational=0, degraded_performance=1, partial_outage=2, "
            "major_outage=3, under_maintenance=4)",
            text,
        )

    def test_escapes_label_values(self):
        status = gm.compute_status_metrics(
            {"status": {"indicator": "none"}},
            [_component('weird "name"', "operational")],
        )
        incident_metrics = gm.compute_incident_metrics([])

        text = gm.render_prometheus_text(status, incident_metrics, 0)

        self.assertIn('component="weird \\"name\\""', text)

    def test_extra_tags_are_appended_to_every_metric(self):
        status = gm.compute_status_metrics({"status": {"indicator": "none"}}, [])
        incident_metrics = gm.compute_incident_metrics([])

        text = gm.render_prometheus_text(
            status, incident_metrics, 100, extra_tags={"env": "prod"}
        )

        self.assertIn('github_status_overall{env="prod"} 0', text)
        self.assertIn('github_status_collector_last_success_ts{env="prod"} 100', text)

    def test_extra_tags_are_present_alongside_label_specific_tags(self):
        status = gm.compute_status_metrics({"status": {"indicator": "none"}}, [])
        incident_metrics = gm.compute_incident_metrics(
            [_incident("a", "investigating", "major")]
        )

        text = gm.render_prometheus_text(
            status, incident_metrics, 100, extra_tags={"env": "prod"}
        )

        # prometheus_client's generate_latest sorts label names
        # alphabetically in its output, regardless of declaration order --
        # "env" sorts before "impact".
        self.assertIn('github_incidents_created{env="prod",impact="major"} 1', text)


if __name__ == "__main__":
    unittest.main()
