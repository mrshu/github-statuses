#!/usr/bin/env python3
import argparse
import csv
import html
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta

ATOM_NS = "{http://www.w3.org/2005/Atom}"

MONTH_ABBR = {
    "Jan": 1,
    "Feb": 2,
    "Mar": 3,
    "Apr": 4,
    "May": 5,
    "Jun": 6,
    "Jul": 7,
    "Aug": 8,
    "Sep": 9,
    "Oct": 10,
    "Nov": 11,
    "Dec": 12,
}

MONTH_FULL = {
    "January": 1,
    "February": 2,
    "March": 3,
    "April": 4,
    "May": 5,
    "June": 6,
    "July": 7,
    "August": 8,
    "September": 9,
    "October": 10,
    "November": 11,
    "December": 12,
}

P_RE = re.compile(r"<p>(.*?)</p>", re.DOTALL)
SMALL_RE = re.compile(
    r"<small>([A-Za-z]{3})\s+<var data-var='date'>\s*([0-9]{1,2})\s*</var>,\s*"
    r"<var data-var='time'>\s*([0-9]{2}:[0-9]{2})\s*</var>\s*UTC</small>"
)
STATUS_RE = re.compile(r"<strong>([^<]+)</strong>")
STRIP_TAGS_RE = re.compile(r"<[^>]+>")
BR_RE = re.compile(r"<br\s*/?>")
STATUS_ORDER = {
    "Investigating": 0,
    "Identified": 1,
    "Monitoring": 2,
    "Update": 3,
    "Resolved": 4,
}

IMPACT_RE_1 = re.compile(
    r"On\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+"
    r"(\d{1,2}),\s+(\d{4}),\s+between\s+(\d{1,2}:\d{2})\s+UTC\s+and\s+"
    r"(\d{1,2}:\d{2})\s+UTC",
    re.IGNORECASE,
)
IMPACT_RE_2 = re.compile(
    r"between\s+(\d{1,2}:\d{2})\s+UTC\s+and\s+(\d{1,2}:\d{2})\s+UTC,\s+on\s+"
    r"(January|February|March|April|May|June|July|August|September|October|November|December)\s+"
    r"(\d{1,2}),\s+(\d{4})",
    re.IGNORECASE,
)
CLASS_ATTR_RE = re.compile(r"class=[\"']([^\"']+)[\"']", re.IGNORECASE)
COMPONENTS_RE = re.compile(r"This incident affected:\s*([^.]+)", re.IGNORECASE)
COMPONENTS_ALT_RE = re.compile(r"Affected components?:\s*([^.]+)", re.IGNORECASE)
COMPONENTS_MAINT_RE = re.compile(r"This scheduled maintenance affected:\s*([^.]+)", re.IGNORECASE)

COMPONENT_SCHEMA = {
    "Git Operations": "Git operations like git push, pull, clone, or fetch failures.",
    "Webhooks": "Webhook delivery failures, delays, or retries.",
    "API Requests": "API errors, rate limits, or API request failures.",
    "Issues": "Issues creation, viewing, or updates.",
    "Pull Requests": "Pull request creation, merging, or viewing.",
    "Actions": "GitHub Actions workflows, runners, or build execution.",
    "Packages": "Package registry, container registry, or package downloads.",
    "Pages": "GitHub Pages builds, publishing, or access.",
    "Codespaces": "Codespaces creation, access, or performance.",
    "Copilot": "GitHub Copilot availability, suggestions, or auth.",
}

COMPONENT_ALIASES = {
    "Git Operations": [
        r"\bgit operations?\b",
        r"\bgit (push|pull|fetch|clone)\b",
        r"\bgit\b",
    ],
    "Webhooks": [r"\bwebhooks?\b"],
    "API Requests": [
        r"\bapi requests?\b",
        r"\bgithub api\b",
        r"\brest api\b",
        r"\bgraphql\b",
        r"\bapi rate\b",
    ],
    "Issues": [
        r"\bgithub issues\b",
        r"\bissues and pull requests\b",
        r"\bissue creation\b",
        r"\bissue comments?\b",
        r"\bissues tab\b",
        r"\bissues page\b",
    ],
    "Pull Requests": [r"\bpull requests?\b", r"\bprs?\b", r"\bmerge (pull|requests?)\b"],
    "Actions": [r"\bgithub actions\b", r"\bworkflow runs?\b", r"\bworkflow\b", r"\bactions\b"],
    "Packages": [r"\bpackage registry\b", r"\bcontainer registry\b", r"\bpackages?\b"],
    "Pages": [r"\bgithub pages\b", r"\bpages build\b", r"\bpages\b"],
    "Codespaces": [r"\bcodespaces?\b"],
    "Copilot": [r"\bcopilot\b"],
}

try:
    from gliner2 import GLiNER2
except ImportError:
    GLiNER2 = None

_GLINER_MODEL = None
_GLINER_MODEL_NAME = None


def run_git(args):
    result = subprocess.run(["git"] + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "git command failed")
    return result.stdout


def parse_iso8601(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def parse_datetime_arg(value):
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    if len(value) == 10 and value[4] == "-" and value[7] == "-":
        value = f"{value}T00:00:00Z"
    return parse_iso8601(value)


def infer_year(reference_dt, month, day, hour, minute):
    candidates = []
    for year in (reference_dt.year - 1, reference_dt.year, reference_dt.year + 1):
        try:
            dt = datetime(year, month, day, hour, minute, tzinfo=timezone.utc)
        except ValueError:
            continue
        delta = abs((dt - reference_dt).total_seconds())
        candidates.append((delta, dt))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0])
    return candidates[0][1]


def clean_message(fragment):
    cleaned = SMALL_RE.sub("", fragment)
    cleaned = STATUS_RE.sub("", cleaned, count=1)
    cleaned = BR_RE.sub(" ", cleaned)
    cleaned = STRIP_TAGS_RE.sub("", cleaned)
    cleaned = html.unescape(cleaned)
    cleaned = " ".join(cleaned.split())
    cleaned = cleaned.lstrip("- ").strip()
    return cleaned


def parse_updates(html_content, published_at):
    unescaped = html.unescape(html_content)
    updates = []
    for idx, p_block in enumerate(P_RE.findall(unescaped)):
        small = SMALL_RE.search(p_block)
        status = STATUS_RE.search(p_block)
        if not small or not status:
            continue
        month = MONTH_ABBR.get(small.group(1))
        day = int(small.group(2))
        hour, minute = map(int, small.group(3).split(":"))
        dt = infer_year(published_at, month, day, hour, minute)
        if dt is None:
            continue
        updates.append(
            {
                "at": dt,
                "status": status.group(1).strip(),
                "message": clean_message(p_block),
                "_order": idx,
            }
        )
    # feed is newest-first; sort to chronological
    updates.sort(key=lambda item: item["at"])
    return updates


def parse_impact_window(messages):
    for message in messages:
        match = IMPACT_RE_1.search(message)
        if match:
            month = MONTH_FULL[match.group(1).title()]
            day = int(match.group(2))
            year = int(match.group(3))
            start_time = match.group(4)
            end_time = match.group(5)
            start_hour, start_min = map(int, start_time.split(":"))
            end_hour, end_min = map(int, end_time.split(":"))
            start_at = datetime(year, month, day, start_hour, start_min, tzinfo=timezone.utc)
            end_at = datetime(year, month, day, end_hour, end_min, tzinfo=timezone.utc)
            if end_at <= start_at:
                end_at = end_at + timedelta(days=1)
            return start_at, end_at, message
        match = IMPACT_RE_2.search(message)
        if match:
            start_time = match.group(1)
            end_time = match.group(2)
            month = MONTH_FULL[match.group(3).title()]
            day = int(match.group(4))
            year = int(match.group(5))
            start_hour, start_min = map(int, start_time.split(":"))
            end_hour, end_min = map(int, end_time.split(":"))
            start_at = datetime(year, month, day, start_hour, start_min, tzinfo=timezone.utc)
            end_at = datetime(year, month, day, end_hour, end_min, tzinfo=timezone.utc)
            if end_at <= start_at:
                end_at = end_at + timedelta(days=1)
            return start_at, end_at, message
    return None


def extract_impact_from_html(html_text):
    for match in CLASS_ATTR_RE.finditer(html_text):
        classes = match.group(1).split()
        for cls in classes:
            if cls.startswith("impact-"):
                return cls.replace("impact-", "")
    return None


def extract_components_from_html(html_text):
    text = STRIP_TAGS_RE.sub(" ", html_text)
    text = html.unescape(text)
    text = " ".join(text.split())
    match = COMPONENTS_RE.search(text) or COMPONENTS_MAINT_RE.search(text) or COMPONENTS_ALT_RE.search(text)
    if not match:
        return None
    raw = match.group(1).strip().rstrip(".")
    raw = raw.replace(" and ", ", ")
    parts = [part.strip() for part in raw.split(",") if part.strip()]
    return parts or None


def fetch_url(url, timeout=15):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "github-statuses/0.1 (+https://www.githubstatus.com)",
            "Accept": "text/html",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def get_gliner_model(model_name):
    global _GLINER_MODEL, _GLINER_MODEL_NAME
    if _GLINER_MODEL is not None and _GLINER_MODEL_NAME == model_name:
        return _GLINER_MODEL
    if GLiNER2 is None:
        return None
    _GLINER_MODEL = GLiNER2.from_pretrained(model_name)
    _GLINER_MODEL_NAME = model_name
    return _GLINER_MODEL


def select_components_from_entities(entities, threshold):
    if not entities:
        return None, {}
    selected = []
    confidences = {}
    for label, items in entities.items():
        if not items:
            continue
        max_conf = None
        if isinstance(items, list):
            for item in items:
                if isinstance(item, dict) and "confidence" in item:
                    max_conf = max(max_conf or 0.0, float(item["confidence"]))
        if max_conf is None:
            max_conf = 1.0
        confidences[label] = max_conf
        if max_conf >= threshold:
            selected.append(label)
    return (selected or None), confidences


def filter_components_by_alias(components, text):
    if not components or not text:
        return None
    matched = []
    for label in components:
        patterns = COMPONENT_ALIASES.get(label, [])
        if any(re.search(pattern, text, re.IGNORECASE) for pattern in patterns):
            matched.append(label)
    return matched or None


def infer_components_with_gliner2(incident, model_name, threshold):
    if incident.get("components"):
        return
    if GLiNER2 is None:
        return
    model = get_gliner_model(model_name)
    if model is None:
        return
    parts = [incident.get("title") or ""]
    for update in incident.get("updates") or []:
        if update.get("status") == "Resolved":
            continue
        message = update.get("message")
        if message:
            parts.append(message)
    text = " ".join(p.strip() for p in parts if p)
    if not text:
        return
    result = model.extract_entities(text, COMPONENT_SCHEMA, include_confidence=True)
    entities = result.get("entities", {}) if isinstance(result, dict) else {}
    components, confidences = select_components_from_entities(entities, threshold)
    components = filter_components_by_alias(components, text)
    if components:
        incident["components"] = components
        incident["components_source"] = "gliner2"
        incident["components_confidence"] = {
            label: confidences[label] for label in components if label in confidences
        }


def load_impact_cache(path):
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {}
    if isinstance(payload, dict) and "items" in payload:
        return payload.get("items", {})
    if isinstance(payload, dict):
        return payload
    return {}


def save_impact_cache(path, cache):
    if not path:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    payload = {"version": 1, "items": cache}
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=True)


def enrich_impacts(incidents, cache_path, delay_seconds):
    cache = load_impact_cache(cache_path)
    updated = False
    for incident in incidents:
        url = incident.get("url")
        if not url:
            continue
        cached = cache.get(url)
        if cached:
            if cached.get("impact"):
                incident["impact"] = cached["impact"]
            if cached.get("components"):
                incident["components"] = cached["components"]
        if cached and cached.get("impact") and cached.get("components") is not None:
            continue
        try:
            html_text = fetch_url(url)
        except (urllib.error.URLError, urllib.error.HTTPError):
            continue
        impact = extract_impact_from_html(html_text)
        components = extract_components_from_html(html_text)
        if impact:
            incident["impact"] = impact
        if components:
            incident["components"] = components
        cache[url] = {
            "impact": impact,
            "components": components,
            "fetched_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        updated = True
        save_impact_cache(cache_path, cache)
        if delay_seconds:
            time.sleep(delay_seconds)
    if updated:
        save_impact_cache(cache_path, cache)


def parse_atom(content):
    root = ET.fromstring(content)
    entries = []
    for entry in root.findall(f"{ATOM_NS}entry"):
        entry_id = entry.findtext(f"{ATOM_NS}id") or ""
        link = None
        for link_el in entry.findall(f"{ATOM_NS}link"):
            if link_el.get("rel") == "alternate":
                link = link_el.get("href")
                break
        title = entry.findtext(f"{ATOM_NS}title") or ""
        published_raw = entry.findtext(f"{ATOM_NS}published")
        updated_raw = entry.findtext(f"{ATOM_NS}updated")
        content_el = entry.find(f"{ATOM_NS}content")
        content_html = content_el.text if content_el is not None else ""

        published_at = parse_iso8601(published_raw) if published_raw else None
        updated_at = parse_iso8601(updated_raw) if updated_raw else None
        updates = []
        if content_html and published_at:
            updates = parse_updates(content_html, published_at)

        incident_id = entry_id.split("/")[-1] if "/" in entry_id else entry_id

        entries.append(
            {
                "id": incident_id,
                "entry_id": entry_id,
                "title": title,
                "url": link,
                "published_at": published_at,
                "updated_at": updated_at,
                "updates": updates,
            }
        )
    return entries


def merge_incident(existing, incoming):
    if existing is None:
        return {
            "id": incoming["id"],
            "entry_id": incoming["entry_id"],
            "title": incoming["title"],
            "url": incoming["url"],
            "published_at": incoming["published_at"],
            "updated_at": incoming["updated_at"],
            "updates": {update_key(u): u for u in incoming["updates"]},
        }

    if incoming["published_at"] and (
        existing["published_at"] is None or incoming["published_at"] < existing["published_at"]
    ):
        existing["published_at"] = incoming["published_at"]

    if incoming["updated_at"] and (
        existing["updated_at"] is None or incoming["updated_at"] > existing["updated_at"]
    ):
        existing["updated_at"] = incoming["updated_at"]
        existing["title"] = incoming["title"] or existing["title"]
        existing["url"] = incoming["url"] or existing["url"]
        existing["entry_id"] = incoming["entry_id"] or existing["entry_id"]

    for update in incoming["updates"]:
        existing["updates"].setdefault(update_key(update), update)

    return existing


def update_key(update):
    at = update["at"].isoformat().replace("+00:00", "Z")
    return f"{at}|{update['status']}|{update['message']}"


def finalize_incident(incident):
    updates_by_key = incident["updates"]

    ordered = list(updates_by_key.values())
    ordered.sort(
        key=lambda item: (
            item["at"],
            STATUS_ORDER.get(item["status"], 99),
            item["message"],
        )
    )

    for update in ordered:
        update["at"] = update["at"].isoformat().replace("+00:00", "Z")
        update.pop("_order", None)

    published_at = incident["published_at"]
    updated_at = incident["updated_at"]

    published_str = published_at.isoformat().replace("+00:00", "Z") if published_at else None
    updated_str = updated_at.isoformat().replace("+00:00", "Z") if updated_at else None

    statuses = [u["status"] for u in ordered]
    started_at = next((u["at"] for u in ordered if u["status"] == "Investigating"), None)
    if not started_at and ordered:
        started_at = ordered[0]["at"]
    resolved_at = next((u["at"] for u in reversed(ordered) if u["status"] == "Resolved"), None)
    if not resolved_at and ordered:
        resolved_at = ordered[-1]["at"]

    impact = parse_impact_window([u["message"] for u in ordered])
    impact_window = None
    if impact:
        start_at, end_at, context = impact
        impact_window = {
            "start_at": start_at.isoformat().replace("+00:00", "Z"),
            "end_at": end_at.isoformat().replace("+00:00", "Z"),
            "source": "postmortem",
            "context": context,
        }

    downtime_start = impact_window["start_at"] if impact_window else started_at
    downtime_end = impact_window["end_at"] if impact_window else resolved_at
    duration_minutes = None
    if downtime_start and downtime_end:
        start_dt = parse_iso8601(downtime_start)
        end_dt = parse_iso8601(downtime_end)
        duration_minutes = int((end_dt - start_dt).total_seconds() // 60)

    return {
        "id": incident["id"],
        "entry_id": incident["entry_id"],
        "title": incident["title"],
        "url": incident["url"],
        "published_at": published_str,
        "updated_at": updated_str,
        "status_sequence": statuses,
        "started_at": started_at,
        "resolved_at": resolved_at,
        "impact_window": impact_window,
        "downtime_start": downtime_start,
        "downtime_end": downtime_end,
        "duration_minutes": duration_minutes,
        "updates": ordered,
    }


def build_segments(incident):
    updates = incident["updates"]
    segments = []
    for idx, update in enumerate(updates):
        if idx + 1 >= len(updates):
            break
        segments.append(
            {
                "incident_id": incident["id"],
                "start_at": update["at"],
                "end_at": updates[idx + 1]["at"],
                "status": update["status"],
            }
        )
    return segments


def overlaps_window(incident, since_dt, until_dt):
    if not since_dt and not until_dt:
        return True

    start = incident.get("downtime_start") or incident.get("published_at")
    end = incident.get("downtime_end") or incident.get("updated_at") or start
    if not start:
        return False

    start_dt = parse_iso8601(start)
    end_dt = parse_iso8601(end) if end else start_dt

    if since_dt and end_dt < since_dt:
        return False
    if until_dt and start_dt > until_dt:
        return False
    return True


def main():
    parser = argparse.ArgumentParser(description="Extract GitHub status incidents from git history.")
    parser.add_argument("--path", default="github-status-history.atom")
    parser.add_argument("--out", default="out")
    parser.add_argument("--no-segments", action="store_true")
    parser.add_argument("--no-windows", action="store_true")
    parser.add_argument("--since", help="Filter incidents starting from this ISO date or date-only (UTC).")
    parser.add_argument("--until", help="Filter incidents ending at this ISO date or date-only (UTC).")
    parser.add_argument("--enrich-impact", action="store_true", help="Fetch incident pages to detect impact level.")
    parser.add_argument(
        "--infer-components",
        choices=["off", "gliner2"],
        default="gliner2",
        help="Infer components for incidents missing affected components (default: gliner2).",
    )
    parser.add_argument(
        "--gliner-model",
        default="fastino/gliner2-base-v1",
        help="GLiNER2 model name for component inference.",
    )
    parser.add_argument(
        "--gliner-threshold",
        type=float,
        default=0.75,
        help="Minimum confidence for inferred components.",
    )
    parser.add_argument("--impact-cache", default=".cache/impact.json", help="Path to impact cache JSON.")
    parser.add_argument(
        "--impact-delay",
        type=float,
        default=0.5,
        help="Delay in seconds between impact fetches.",
    )
    parser.add_argument(
        "--incidents-format",
        choices=["jsonl", "split", "json"],
        default="jsonl",
        help="Output format for incidents (default: jsonl).",
    )
    args = parser.parse_args()

    commits_raw = run_git(["log", "--format=%H", "--", args.path])
    commits = [line.strip() for line in commits_raw.splitlines() if line.strip()]
    commits.reverse()

    incidents = {}
    for sha in commits:
        try:
            atom_content = run_git(["show", f"{sha}:{args.path}"])
        except RuntimeError:
            continue
        for entry in parse_atom(atom_content):
            existing = incidents.get(entry["id"])
            incidents[entry["id"]] = merge_incident(existing, entry)

    finalized = [finalize_incident(incident) for incident in incidents.values()]
    finalized.sort(key=lambda item: item["published_at"] or "")

    since_dt = parse_datetime_arg(args.since)
    until_dt = parse_datetime_arg(args.until)
    if since_dt or until_dt:
        finalized = [i for i in finalized if overlaps_window(i, since_dt, until_dt)]

    if args.enrich_impact:
        enrich_impacts(finalized, args.impact_cache, args.impact_delay)

    if args.infer_components == "gliner2":
        if GLiNER2 is None:
            print("GLiNER2 not installed; skipping component inference.", file=sys.stderr)
        else:
            for incident in finalized:
                infer_components_with_gliner2(
                    incident,
                    model_name=args.gliner_model,
                    threshold=args.gliner_threshold,
                )

    out_dir = args.out
    os.makedirs(out_dir, exist_ok=True)

    incidents_path = None
    if args.incidents_format == "json":
        incidents_path = f"{out_dir}/incidents.json"
        with open(incidents_path, "w", encoding="utf-8") as handle:
            json.dump(finalized, handle, indent=2, ensure_ascii=True)
    elif args.incidents_format == "jsonl":
        incidents_path = f"{out_dir}/incidents.jsonl"
        with open(incidents_path, "w", encoding="utf-8") as handle:
            for incident in finalized:
                handle.write(json.dumps(incident, ensure_ascii=True))
                handle.write("\n")
    else:
        incidents_dir = f"{out_dir}/incidents"
        os.makedirs(incidents_dir, exist_ok=True)
        for incident in finalized:
            incident_path = os.path.join(incidents_dir, f"{incident['id']}.json")
            with open(incident_path, "w", encoding="utf-8") as handle:
                json.dump(incident, handle, indent=2, ensure_ascii=True)

    if not args.no_segments:
        segments_path = f"{out_dir}/segments.csv"
        with open(segments_path, "w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=["incident_id", "start_at", "end_at", "status"])
            writer.writeheader()
            for incident in finalized:
                for segment in build_segments(incident):
                    writer.writerow(segment)

    if not args.no_windows:
        windows_path = f"{out_dir}/downtime_windows.csv"
        with open(windows_path, "w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(
                handle,
                fieldnames=[
                    "incident_id",
                    "downtime_start",
                    "downtime_end",
                    "duration_minutes",
                    "source",
                    "title",
                    "impact",
                ],
            )
            writer.writeheader()
            for incident in finalized:
                if not incident["downtime_start"] or not incident["downtime_end"]:
                    continue
                source = "postmortem" if incident["impact_window"] else "updates"
                writer.writerow(
                    {
                        "incident_id": incident["id"],
                        "downtime_start": incident["downtime_start"],
                        "downtime_end": incident["downtime_end"],
                        "duration_minutes": incident["duration_minutes"],
                        "source": source,
                        "title": incident["title"],
                        "impact": incident.get("impact"),
                    }
                )

    if incidents_path:
        print(f"Wrote {len(finalized)} incidents to {incidents_path}")
    else:
        print(f"Wrote {len(finalized)} incidents to {out_dir}/incidents/")


if __name__ == "__main__":
    main()
