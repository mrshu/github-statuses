"""
Exposes a /metrics and /health endpoint using FastAPI service so the app
can be deployed in a container, with updates to incidents.jsonl and
downtime_windows.csv happening in the background using lifespan.

Every gauge is a pure function of "the current statuspage API response":
no diffing against a previous poll, no reading of previously-cached state.
Every impact/component bucket is always emitted (zero-filled if absent
this run) so a stale bucket never lingers at its last nonzero value.
"""

import datetime
import json
import re
import urllib.request

from prometheus_client import CollectorRegistry, Gauge, generate_latest

SUMMARY_URL = "https://www.githubstatus.com/api/v2/summary.json"
COMPONENTS_URL = "https://www.githubstatus.com/api/v2/components.json"
INCIDENTS_URL = "https://www.githubstatus.com/api/v2/incidents.json"

COMPONENT_STATUS_VALUES = {
    "operational": 0,
    "degraded_performance": 1,
    "partial_outage": 2,
    "major_outage": 3,
    "under_maintenance": 4,
}

INDICATOR_VALUES = {"none": 0, "minor": 1, "major": 2, "critical": 3}

# GitHub's own Statuspage impact vocabulary -- distinct from this project's
# own extended IMPACT_ORDER (site/app.js), which adds "maintenance" for the
# parsed incident history. This module talks to the live API directly, so
# it stays on the same four levels the original collector used.
IMPACT_LEVELS = ["none", "minor", "major", "critical"]

INVALID_LABEL_NAME_RE = re.compile(r"[^a-zA-Z0-9_]")


def fetch_json(url, timeout=15):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "github-statuses/0.1 (+https://www.githubstatus.com)",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_summary():
    return fetch_json(SUMMARY_URL)


def fetch_components():
    return fetch_json(COMPONENTS_URL).get("components", [])


def fetch_incidents():
    return fetch_json(INCIDENTS_URL).get("incidents", [])


def parse_tags(tags):
    """
    Parses `key:value` tag strings (the METRICS_TAGS env var, comma
    separated -- see server/app.py) into a dict suitable for use as
    constant Prometheus labels on every metric.
    """
    parsed = {}
    for tag in tags:
        key, _, value = tag.partition(":")
        if not value:
            value = key
        label_name = INVALID_LABEL_NAME_RE.sub("_", key.lower())
        if not label_name:
            continue
        if label_name[0].isdigit():
            label_name = f"_{label_name}"
        parsed[label_name] = value
    return parsed


def compute_status_metrics(summary, components):
    overall = INDICATOR_VALUES.get(summary.get("status", {}).get("indicator"), 0)
    per_component = [
        {
            "component": component["name"],
            "value": COMPONENT_STATUS_VALUES.get(component["status"], 0),
        }
        for component in components
        # showcase=false marks non-service entries GitHub adds to the page
        # we are only interested in the components with showcase=true things
        # with showcase=false shouldn't count towards degraded_total either.
        if component.get("showcase")
    ]
    degraded_total = sum(1 for c in per_component if c["value"] > 0)
    return {
        "overall": overall,
        "per_component": per_component,
        "degraded_total": degraded_total,
    }


def compute_incident_metrics(incidents):
    total_by_impact = {level: 0 for level in IMPACT_LEVELS}
    open_by_impact = {level: 0 for level in IMPACT_LEVELS}
    resolved_by_impact = {level: 0 for level in IMPACT_LEVELS}
    duration_sum_by_impact = {level: 0.0 for level in IMPACT_LEVELS}
    duration_count_by_impact = {level: 0 for level in IMPACT_LEVELS}

    for incident in incidents:
        impact = incident.get("impact")
        if impact not in total_by_impact:
            continue

        total_by_impact[impact] += 1
        if incident.get("status") != "resolved":
            open_by_impact[impact] += 1
            continue

        resolved_by_impact[impact] += 1
        resolved_at = incident.get("resolved_at")
        created_at = incident.get("created_at")
        if not resolved_at or not created_at:
            continue
        duration = (
            _parse_timestamp(resolved_at) - _parse_timestamp(created_at)
        ).total_seconds()
        duration_sum_by_impact[impact] += duration
        duration_count_by_impact[impact] += 1

    average_duration_by_impact = {
        impact: (
            duration_sum_by_impact[impact] / duration_count_by_impact[impact]
            if duration_count_by_impact[impact]
            else 0.0
        )
        for impact in IMPACT_LEVELS
    }

    open_total = sum(open_by_impact.values())

    return {
        "total_by_impact": total_by_impact,
        "open_by_impact": open_by_impact,
        "resolved_by_impact": resolved_by_impact,
        "average_duration_by_impact": average_duration_by_impact,
        "open_total": open_total,
    }


def _parse_timestamp(value):
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))


def _describe_values(mapping):
    """Renders a name->code mapping as `a=0, b=1, ...` for a HELP line,
    sorted by code so it reads in order."""
    return ", ".join(
        f"{name}={value}"
        for name, value in sorted(mapping.items(), key=lambda item: item[1])
    )


def render_prometheus_text(status, incident_metrics, last_success_ts, extra_tags=None):
    """
    Builds a fresh registry/set of gauges on every call
    every impact/component bucket must be zero-filled from
    scratch each poll (see module docstring)
    """
    extra_tags = extra_tags or {}
    registry = CollectorRegistry()

    def emit(name, help_text, labelnames, samples):
        """samples: [(labels_dict, value), ...] -- labels_dict holds only the
        metric-specific labels (e.g. {"impact": "major"}); extra_tags is
        merged in here so callers below don't have to repeat it."""
        gauge = Gauge(name, help_text, [*labelnames, *extra_tags], registry=registry)
        for labels, value in samples:
            merged = {**labels, **extra_tags}
            (gauge.labels(**merged) if merged else gauge).set(value)

    def by_impact(values_by_impact):
        return [
            ({"impact": impact}, values_by_impact[impact]) for impact in IMPACT_LEVELS
        ]

    emit(
        "github_status_overall",
        f"Overall page status indicator ({_describe_values(INDICATOR_VALUES)})",
        [],
        [({}, status["overall"])],
    )
    emit(
        "github_status_component",
        f"Per-component status ({_describe_values(COMPONENT_STATUS_VALUES)})",
        ["component"],
        [({"component": c["component"]}, c["value"]) for c in status["per_component"]],
    )
    emit(
        "github_status_components_degraded_total",
        "Count of components not currently operational",
        [],
        [({}, status["degraded_total"])],
    )
    emit(
        "github_incidents_open",
        "Currently unresolved incidents, bucketed by impact",
        ["impact"],
        by_impact(incident_metrics["open_by_impact"]),
    )
    emit(
        "github_incidents_open_total",
        "Currently unresolved incidents, all impacts",
        [],
        [({}, incident_metrics["open_total"])],
    )
    emit(
        "github_incidents_created",
        "Incidents currently visible in the API's response, bucketed by impact",
        ["impact"],
        by_impact(incident_metrics["total_by_impact"]),
    )
    emit(
        "github_incidents_resolved",
        "Currently resolved incidents, bucketed by impact",
        ["impact"],
        by_impact(incident_metrics["resolved_by_impact"]),
    )
    emit(
        "github_incidents_duration_seconds",
        "Average time-to-resolution across currently resolved incidents, by impact",
        ["impact"],
        by_impact(incident_metrics["average_duration_by_impact"]),
    )
    emit(
        "github_status_collector_last_success_ts",
        "Epoch of the last successful poll -- detects a stalled collector",
        [],
        [({}, last_success_ts)],
    )

    return generate_latest(registry).decode("utf-8")


def collect_metrics():
    summary = fetch_summary()
    components = fetch_components()
    incidents = fetch_incidents()
    return {
        "status": compute_status_metrics(summary, components),
        "incident_metrics": compute_incident_metrics(incidents),
    }
