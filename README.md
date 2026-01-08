# github-statuses

A Flat Data attempt at historically documenting GitHub statuses.

## About

This project builds the **"missing GitHub status page"**: a historical mirror that shows actual uptime
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

Infer missing components with GLiNER2 (used only when the incident page lacks "affected components"):

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

Some incident pages do not list "affected components". In those cases we use GLiNER2 as a fallback:

- Input text: incident title + non-Resolved updates.
- Labels: the 10 GitHub services with short descriptions.
- Thresholded inference (default: 0.75 confidence).
- Final filter: the label must also appear via explicit service aliases in the text.

This keeps HTML tags as the source of truth and uses ML only to fill gaps.

### GLiNER2 experiment (evaluation + audit)

To validate the fallback approach, an experiment is run that produces:

- **Audit**: every GLiNER2-tagged incident with text evidence snippets.
- **Evaluation**: GLiNER2 predictions compared against incidents that *do* have HTML "affected components".

Reproduce the experiment at a fixed time point (numbers will change as new data arrives):

```
uv run python scripts/run_gliner_experiment.py --as-of 2026-01-08 --output-dir tagging-experiment
```

Outputs are written to:

- `tagging-experiment/gliner2_audit.jsonl` (tagged incidents + evidence snippets)
- `tagging-experiment/gliner2_eval.json` (metrics, per-label breakdown, sample mismatches)
- `tagging-experiment/gliner2_examples.md` (diff-style table of sample errors)

Latest results (as-of 2026-01-08, threshold 0.75, alias filter on, non-Resolved text only):

| Metric | Value |
|---|---:|
| Evaluated incidents | 446 |
| Predicted non-empty | 418 |
| Precision | 0.950 |
| Recall | 0.883 |
| Exact match rate | 0.785 |
| Audit count (missing-tag incidents) | 51 |

Per-label precision/recall (top-level service components):

| Label | Precision | Recall | TP | FP | FN |
|---|---:|---:|---:|---:|---:|
| Git Operations | 0.968 | 0.909 | 60 | 2 | 6 |
| Webhooks | 0.938 | 0.918 | 45 | 3 | 4 |
| API Requests | 0.915 | 0.915 | 54 | 5 | 5 |
| Issues | 1.000 | 0.286 | 22 | 0 | 55 |
| Pull Requests | 0.948 | 0.979 | 92 | 5 | 2 |
| Actions | 0.958 | 0.947 | 161 | 7 | 9 |
| Packages | 0.917 | 0.971 | 33 | 3 | 1 |
| Pages | 0.855 | 0.964 | 53 | 9 | 2 |
| Codespaces | 0.982 | 0.982 | 110 | 2 | 2 |
| Copilot | 1.000 | 0.966 | 57 | 0 | 2 |

Summary: the fallback is high-precision and mostly conservative. Most errors are **false negatives**
(missing a true component), while false positives are typically "extra" components inferred from
multi-service incident titles.

## Outputs

Outputs are written to the directory passed to `--out` (local examples use `out/`).
The GLiNER2 experiment writes to `tagging-experiment/` by default.
The automation workflow writes to `parsed/`.

- `<out>/incidents.json`: merged incident timeline records
- `<out>/incidents.jsonl`: one JSON object per incident (default)
- `<out>/incidents/`: per-incident JSON files when using `--incidents-format split`
- `<out>/segments.csv`: per-status timeline segments for Gantt/phase views
- `<out>/downtime_windows.csv`: downtime windows for incident bar charts

Incident records include optional `impact` and `components` fields when enrichment is enabled.
Service components are sourced as follows:

- **Primary**: the incident page "affected components" section (if present).
- **Fallback**: GLiNER2 schema-driven extraction from the incident title + non-resolved updates, filtered
  by explicit service aliases to avoid generic matches.
