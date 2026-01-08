#!/usr/bin/env python3
import argparse
import json
import os
import re
from collections import defaultdict
from datetime import datetime

import extract_incidents as ei


def parse_iso(value):
    if not value:
        return None
    value = value.strip()
    if not value:
        return None
    if len(value) == 10 and value[4] == "-" and value[7] == "-":
        value = f"{value}T00:00:00Z"
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def incident_text(incident):
    parts = [incident.get("title") or ""]
    for update in incident.get("updates") or []:
        if update.get("status") == "Resolved":
            continue
        message = update.get("message")
        if message:
            parts.append(message)
    return " ".join(part.strip() for part in parts if part.strip())


def build_alias_patterns():
    return {
        label: [re.compile(pattern, re.IGNORECASE) for pattern in patterns]
        for label, patterns in ei.COMPONENT_ALIASES.items()
    }


def find_evidence(text, label, alias_patterns):
    for pattern in alias_patterns.get(label, []):
        match = pattern.search(text)
        if match:
            start = max(match.start() - 40, 0)
            end = min(match.end() + 40, len(text))
            return text[start:end]
    return None


def infer_components(model, text, threshold):
    if not text:
        return [], {}
    result = model.extract_entities(text, ei.COMPONENT_SCHEMA, include_confidence=True)
    entities = result.get("entities", {}) if isinstance(result, dict) else {}
    components, confidences = ei.select_components_from_entities(entities, threshold)
    components = ei.filter_components_by_alias(components, text)
    if not components:
        return [], {}
    return components, {label: confidences.get(label) for label in components}


def main():
    parser = argparse.ArgumentParser(
        description="Evaluate GLiNER2 component inference against HTML-tagged incidents."
    )
    parser.add_argument(
        "--incidents",
        default="parsed/incidents.jsonl",
        help="Path to incidents JSONL (default: parsed/incidents.jsonl)",
    )
    parser.add_argument(
        "--output-dir",
        default="out",
        help="Directory to write audit/eval files (default: out)",
    )
    parser.add_argument(
        "--as-of",
        help="Only include incidents published on or before this ISO date/time (UTC).",
    )
    parser.add_argument(
        "--model",
        default="fastino/gliner2-base-v1",
        help="GLiNER2 model name (default: fastino/gliner2-base-v1)",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=0.75,
        help="Minimum confidence threshold for components (default: 0.75)",
    )
    args = parser.parse_args()

    if ei.GLiNER2 is None:
        raise SystemExit("GLiNER2 is not installed. Run `uv add gliner2` first.")

    model = ei.get_gliner_model(args.model)
    alias_patterns = build_alias_patterns()
    cutoff = parse_iso(args.as_of)

    incidents = []
    with open(args.incidents, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            incident = json.loads(line)
            if cutoff:
                published = incident.get("published_at")
                if published and parse_iso(published) > cutoff:
                    continue
            incidents.append(incident)

    os.makedirs(args.output_dir, exist_ok=True)

    audit_path = os.path.join(args.output_dir, "gliner2_audit.jsonl")
    eval_path = os.path.join(args.output_dir, "gliner2_eval.json")

    audit_count = 0
    with open(audit_path, "w", encoding="utf-8") as handle:
        for inc in incidents:
            if inc.get("components") and inc.get("components_source") != "gliner2":
                continue
            text = incident_text(inc)
            components, confidences = infer_components(model, text, args.threshold)
            if not components:
                continue
            evidence = {
                label: find_evidence(text, label, alias_patterns) for label in components
            }
            handle.write(
                json.dumps(
                    {
                        "id": inc.get("id"),
                        "url": inc.get("url"),
                        "title": inc.get("title"),
                        "components": components,
                        "components_confidence": confidences,
                        "evidence": evidence,
                    },
                    ensure_ascii=True,
                )
            )
            handle.write("\n")
            audit_count += 1

    truth_pool = [
        inc
        for inc in incidents
        if inc.get("components") and inc.get("components_source") != "gliner2"
    ]

    metrics = {
        "total": len(truth_pool),
        "predicted_non_empty": 0,
        "exact_match": 0,
        "tp": 0,
        "fp": 0,
        "fn": 0,
    }
    per_label = defaultdict(lambda: {"tp": 0, "fp": 0, "fn": 0})
    examples_fp = []
    examples_fn = []

    for inc in truth_pool:
        text = incident_text(inc)
        predicted, _ = infer_components(model, text, args.threshold)
        truth = inc.get("components") or []

        pred_set = set(predicted)
        truth_set = set(truth)

        if pred_set:
            metrics["predicted_non_empty"] += 1

        if pred_set == truth_set:
            metrics["exact_match"] += 1

        tp = pred_set & truth_set
        fp = pred_set - truth_set
        fn = truth_set - pred_set

        metrics["tp"] += len(tp)
        metrics["fp"] += len(fp)
        metrics["fn"] += len(fn)

        for label in tp:
            per_label[label]["tp"] += 1
        for label in fp:
            per_label[label]["fp"] += 1
        for label in fn:
            per_label[label]["fn"] += 1

        if fp and len(examples_fp) < 5:
            examples_fp.append(
                {
                    "title": inc.get("title"),
                    "url": inc.get("url"),
                    "predicted": sorted(pred_set),
                    "truth": sorted(truth_set),
                }
            )
        if fn and len(examples_fn) < 5:
            examples_fn.append(
                {
                    "title": inc.get("title"),
                    "url": inc.get("url"),
                    "predicted": sorted(pred_set),
                    "truth": sorted(truth_set),
                }
            )

    precision = (
        metrics["tp"] / (metrics["tp"] + metrics["fp"]) if (metrics["tp"] + metrics["fp"]) else 0
    )
    recall = (
        metrics["tp"] / (metrics["tp"] + metrics["fn"]) if (metrics["tp"] + metrics["fn"]) else 0
    )
    exact_match_rate = metrics["exact_match"] / metrics["total"] if metrics["total"] else 0

    report = {
        "model": args.model,
        "threshold": args.threshold,
        "as_of": args.as_of,
        "metrics": {
            **metrics,
            "precision": precision,
            "recall": recall,
            "exact_match_rate": exact_match_rate,
        },
        "per_label": dict(per_label),
        "examples": {"false_positive": examples_fp, "false_negative": examples_fn},
        "audit_count": audit_count,
    }

    with open(eval_path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, ensure_ascii=True)

    print(f"Wrote audit: {audit_path}")
    print(f"Wrote eval: {eval_path}")
    print(
        f"Precision {precision:.3f} | Recall {recall:.3f} | Exact match {exact_match_rate:.3f} "
        f"| Audit {audit_count} | Evaluated {metrics['total']}"
    )


if __name__ == "__main__":
    main()
