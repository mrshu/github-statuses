# github-statuses
A Flat Data attempt at historically documenting GitHub statuses.

## What this repo does
- Parses the historical Atom feed snapshots in git history.
- Produces incident timelines and downtime windows suitable for status-page visualizations.

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

## Automation
After each Flat data update, a GitHub Action runs the parser and commits outputs to `parsed/`.

Run tests:
```
uv run python -m unittest discover -s tests
```

## Status site
Static site lives in `site/` and reads data from `parsed/`.
Serve the repo root with any static server to view it locally.

## Outputs
Outputs are written to the directory passed to `--out` (local examples use `out/`).
The automation workflow writes to `parsed/`.

- `<out>/incidents.json`: merged incident timeline records
- `<out>/incidents.jsonl`: one JSON object per incident (default)
- `<out>/incidents/`: per-incident JSON files when using `--incidents-format split`
- `<out>/segments.csv`: per-status timeline segments for Gantt/phase views
- `<out>/downtime_windows.csv`: downtime windows for incident bar charts

Incident records include optional `impact` and `components` fields when enrichment is enabled.
