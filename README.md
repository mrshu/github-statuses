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

Enrich incidents with impact level by scraping the incident pages (cached):
```
uv run python scripts/extract_incidents.py --out out --enrich-impact
```

Run tests:
```
uv run python -m unittest discover -s tests
```

## Outputs
- `out/incidents.json`: merged incident timeline records
- `out/segments.csv`: per-status timeline segments for Gantt/phase views
- `out/downtime_windows.csv`: downtime windows for incident bar charts
