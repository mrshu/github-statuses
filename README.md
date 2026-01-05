# github-statuses

A Flat Data attempt at historically documenting GitHub statuses.

## About

This project builds the **“missing GitHub status page”**: a historical mirror that shows actual uptime
percentages and incidents across the entire platform, plus per-service uptime based on the incident data.
It reconstructs timelines from the Atom feed history and turns them into structured outputs and a static site.

## Quick start (uv)

```
uv venv
```

Run the extractor across all history:

```
uv run python scripts/extract_incidents.py --out out
```

Run the extractor for the last year (UTC example):

```
uv run python scripts/extract_incidents.py --out out_last_year --since 2025-01-03 --until 2026-01-03
```

Use JSONL (default) or split per-incident outputs:

```
uv run python scripts/extract_incidents.py --out out --incidents-format jsonl
uv run python scripts/extract_incidents.py --out out --incidents-format split
```

Enrich incidents with impact level by scraping the incident pages (cached):

```
uv run python scripts/extract_incidents.py --out out --enrich-impact
```

Infer missing components with GLiNER2 (used only when the incident page lacks “affected components”):

```
uv run python scripts/extract_incidents.py --out out --infer-components gliner2
```

## Automation

After each Flat data update, a GitHub Action runs the parser and commits outputs to `parsed/`.

Run tests:

```
uv run python -m unittest discover -s tests
```

## Status site

Static site lives in `site/` and reads data from `parsed/`.
Serve the repo root with any static server to view it locally.

## GLiNER2 component inference

Some incident pages do not list “affected components”. In those cases we use GLiNER2 as a fallback:

- Input text: incident title + non‑Resolved updates.
- Labels: the 10 GitHub services with short descriptions.
- Thresholded inference (default: 0.75 confidence).
- Final filter: the label must also appear via explicit service aliases in the text.

This keeps HTML tags as the source of truth and uses ML only to fill gaps.

### GLiNER2 experiment (evaluation + audit)

To validate the fallback approach, an experiment was run:

- **Audit**: every GLiNER2‑tagged incident is written with text evidence snippets.
- **Evaluation**: GLiNER2 predictions are compared against incidents that *do* have HTML “affected components”.

Latest results (threshold 0.75, alias filter on, non‑Resolved text only):

- Precision: **0.95**
- Recall: **0.884**
- Exact match rate: **0.786**
- Evaluated incidents: **444**

Summary: the fallback is high‑precision and mostly conservative. Most errors are **false negatives**
(missing a true component), while false positives are typically “extra” components inferred from
multi‑service incident titles.

## Outputs

Outputs are written to the directory passed to `--out` (local examples use `out/`).
The automation workflow writes to `parsed/`.

- `<out>/incidents.json`: merged incident timeline records
- `<out>/incidents.jsonl`: one JSON object per incident (default)
- `<out>/incidents/`: per-incident JSON files when using `--incidents-format split`
- `<out>/segments.csv`: per-status timeline segments for Gantt/phase views
- `<out>/downtime_windows.csv`: downtime windows for incident bar charts

Incident records include optional `impact` and `components` fields when enrichment is enabled.
Service components are sourced as follows:

- **Primary**: the incident page “affected components” section (if present).
- **Fallback**: GLiNER2 schema-driven extraction from the incident title + non-resolved updates, filtered
  by explicit service aliases to avoid generic matches.
