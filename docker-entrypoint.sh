#!/bin/sh
set -e

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"

# Single worker, deliberately: server/app.py keeps its live-polling state
# (the metrics snapshot, the incidents-refresh git commits) in one
# process's memory and one on-disk git checkout -- multiple worker
# processes would each run their own background pollers and race each
# other's git commits.
#
# Runs uvicorn directly instead of through `uv run` -- the venv was already
# frozen at image build time, so there's nothing left for uv to resolve at
# container startup. Found via PATH (see the Dockerfile's
# `ENV PATH="/app/.venv/bin:$PATH"`), not `uv`, which isn't installed here.
set -- uvicorn server.app:app --host "$HOST" --port "$PORT" --workers 1

if command -v ddtrace-run >/dev/null 2>&1; then
  exec ddtrace-run "$@"
else
  exec "$@"
fi
