"""
FastAPI server for running github-statuses on Kubernetes (or anywhere else
that isn't GitHub Pages) as a genuinely live alternative to the static
site deploy -- not a redeploy-nightly snapshot of it.

This is a second, independent way to run the same project. It does not
touch site/, scripts/extract_incidents.py, or .github/workflows/*.yaml --
extract_incidents.py in particular is *invoked* as a
subprocess with the exact flags .github/workflows/parse.yaml uses, so it
stays byte-for-byte unmodified and this server can never drift from what
the nightly job actually does. server/metrics.py, by contrast, lives here
because it has no reason to exist outside this server giving the ability
to serve a live Prometheus metrics endpoint that can be injested into
Promethus/ELK/Datadog and updating incident history inside the live running
application.

Two background loops, started from `lifespan`, are what make this "live"
instead of "redeploy nightly":

- `_metrics_poll_loop` polls githubstatus.com's summary/components/incidents
  JSON directly (via server/metrics.py) and refreshes an in-memory
  Prometheus snapshot that GET /metrics serves on every scrape.
- `_incidents_poll_loop` refreshes parsed/incidents.jsonl in place on the
  pod's filesystem, so the static site files this app also serves stay
  current without ever rebuilding/redeploying the image.

`_incidents_poll_loop`'s trick: scripts/extract_incidents.py reconstructs
incident history by walking the *git history* of github-status-history.atom
(one commit per historical Flat snapshot) via `git log`/`git show` -- it was
built for a scheduled batch job, not a live poller. Rather than change that
script, `_refresh_atom_feed` fetches the live atom feed directly from
githubstatus.com and, if it changed, makes a local-only git commit of it --
manufacturing exactly the kind of history entry the Flat GitHub Action would
have produced, so extract_incidents.py's unmodified git-log replay has
something new to find. These commits are never pushed anywhere; they're
internal bookkeeping for this one script's own mechanism, confined to
whatever git checkout the container has.
"""

import asyncio
import contextlib
import os
import pathlib
import subprocess
import sys
import time
import typing

import fastapi
import fastapi.responses
import fastapi.staticfiles
import prometheus_client

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPTS_DIR = ROOT / "scripts"
SITE_DIR = ROOT / "site"
PARSED_DIR = ROOT / "parsed"
ATOM_PATH = ROOT / "github-status-history.atom"
EXTRACT_SCRIPT = SCRIPTS_DIR / "extract_incidents.py"

ATOM_FEED_URL = "https://www.githubstatus.com/history.atom"

# Same flags .github/workflows/parse.yaml passes to extract_incidents.py --
# keep these two in sync by hand; there's no shared source for them since
# one is a subprocess argv list and the other is a YAML `run:` block.
EXTRACT_INCIDENTS_ARGS = [
    "--out",
    str(PARSED_DIR),
    "--incidents-format",
    "jsonl",
    "--enrich-impact",
    "--impact-delay",
    "0.1",
]

sys.path.insert(0, str(SCRIPTS_DIR))
import extract_incidents  # noqa: E402 -- unmodified, see scripts/extract_incidents.py

from server import metrics  # noqa: E402

# 30 seconds - keep metrics endpoint polling low for reporting purposes
METRICS_POLL_INTERVAL_SECONDS = float(
    os.environ.get("METRICS_POLL_INTERVAL_SECONDS", "30")
)
INCIDENTS_POLL_INTERVAL_SECONDS = float(
    os.environ.get("INCIDENTS_POLL_INTERVAL_SECONDS", "3600")  # 1 hour
)
EXTRA_TAGS = metrics.parse_tags(
    [tag for tag in os.environ.get("METRICS_TAGS", "").split(",") if tag]
)
# Set to "1" in tests (and available for local debugging) to skip starting
# the two background loops -- they hit real network endpoints, run a real
# subprocess, and make real local git commits, none of which a unit test
# should do.
BACKGROUND_TASKS_DISABLED = os.environ.get("DISABLE_BACKGROUND_TASKS") == "1"
DEBUG = os.environ.get("DEBUG") == "1"

START_TIME = time.time()

state: dict[str, typing.Any] = {
    "metrics_text": None,
    "metrics_last_success_ts": None,
    "incidents_last_success_ts": None,
}


def _debug_log(message: str) -> None:
    if DEBUG:
        print(f"[debug] {message}", file=sys.stderr)


def _git(*args, check=True):
    return subprocess.run(
        ["git", *args], cwd=ROOT, check=check, capture_output=True, text=True
    )


def refresh_atom_feed():
    """
    Fetches the live atom feed and, if its content changed, makes a
    local-only commit of it. Returns True if a new commit was made.
    """
    new_content = extract_incidents.fetch_url(ATOM_FEED_URL, timeout=30)
    if ATOM_PATH.exists() and ATOM_PATH.read_text(encoding="utf-8") == new_content:
        return False

    ATOM_PATH.write_text(new_content, encoding="utf-8")
    _git("add", str(ATOM_PATH.relative_to(ROOT)))
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "github-statuses-service",
        "GIT_AUTHOR_EMAIL": "github-statuses-service@localhost",
        "GIT_COMMITTER_NAME": "github-statuses-service",
        "GIT_COMMITTER_EMAIL": "github-statuses-service@localhost",
    }
    subprocess.run(
        ["git", "commit", "-q", "-m", "live: refresh github-status-history.atom"],
        cwd=ROOT,
        check=True,
        env=env,
    )
    return True


def refresh_incidents_once():
    refresh_atom_feed()
    subprocess.run(
        [sys.executable, str(EXTRACT_SCRIPT), *EXTRACT_INCIDENTS_ARGS],
        cwd=ROOT,
        check=True,
    )


async def _metrics_poll_loop():
    loop = asyncio.get_running_loop()
    while True:
        _debug_log("metrics poll triggered")
        try:
            collected = await loop.run_in_executor(None, metrics.collect_metrics)
            now = int(time.time())
            state["metrics_text"] = metrics.render_prometheus_text(
                collected["status"],
                collected["incident_metrics"],
                now,
                extra_tags=EXTRA_TAGS,
            )
            state["metrics_last_success_ts"] = now
        except Exception as exc:  # noqa: BLE001 -- a failed poll must not crash the loop or wipe the last good snapshot
            print(f"metrics poll failed: {exc}", file=sys.stderr)
        await asyncio.sleep(METRICS_POLL_INTERVAL_SECONDS)


async def _incidents_poll_loop():
    loop = asyncio.get_running_loop()
    while True:
        _debug_log("incidents refresh triggered")
        try:
            await loop.run_in_executor(None, refresh_incidents_once)
            state["incidents_last_success_ts"] = int(time.time())
        except Exception as exc:  # noqa: BLE001 -- see _metrics_poll_loop
            print(f"incidents refresh failed: {exc}", file=sys.stderr)
        await asyncio.sleep(INCIDENTS_POLL_INTERVAL_SECONDS)


@contextlib.asynccontextmanager
async def lifespan(_app: fastapi.FastAPI):
    tasks = []
    if not BACKGROUND_TASKS_DISABLED:
        tasks = [
            asyncio.create_task(_metrics_poll_loop()),
            asyncio.create_task(_incidents_poll_loop()),
        ]
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


app = fastapi.FastAPI(lifespan=lifespan)


@app.get("/metrics", tags=["metrics"])
def get_metrics() -> fastapi.responses.Response:
    if state["metrics_text"] is None:
        raise fastapi.HTTPException(status_code=503, detail="metrics not yet available")
    return fastapi.responses.PlainTextResponse(
        state["metrics_text"], media_type=prometheus_client.CONTENT_TYPE_LATEST
    )


@app.get("/health", tags=["health"])
@app.get("/health/liveness", tags=["health"])
async def liveness() -> dict:
    return {"status": "alive", "uptime_s": round(time.time() - START_TIME, 1)}


@app.get("/health/readiness", tags=["health"])
async def readiness(response: fastapi.Response) -> dict:
    checks = {
        "metrics": state["metrics_last_success_ts"] is not None,
        "incidents": state["incidents_last_success_ts"] is not None,
    }
    healthy = all(checks.values())
    if not healthy:
        response.status_code = fastapi.status.HTTP_503_SERVICE_UNAVAILABLE
    return {"status": "ok" if healthy else "unavailable", "checks": checks}


# Registered last; a StaticFiles mount at "/" matches any path
# under it, so /metrics and /health above must already be registered as routes
app.mount(
    "/parsed", fastapi.staticfiles.StaticFiles(directory=str(PARSED_DIR)), name="parsed"
)
app.mount(
    "/",
    fastapi.staticfiles.StaticFiles(directory=str(SITE_DIR), html=True),
    name="site",
)
