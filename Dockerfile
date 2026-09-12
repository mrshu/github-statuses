# syntax=docker/dockerfile:1
#
# Runs github-statuses as a live FastAPI service (server/app.py) instead of
# the static GitHub Pages deploy -- see server/app.py's module docstring
# for what "live" means here. site/, scripts/, and .github/workflows/*.yaml
# are untouched by this; the Pages deploy keeps working independently of
# whatever is built from this file.
#
# Deliberately NOT using --infer-components off : the goal
# is for the in-cluster incidents refresh to run scripts/extract_incidents.py
# with the exact same flags .github/workflows/parse.yaml uses (see
# server/app.py's EXTRACT_INCIDENTS_ARGS), which means the full GLiNER2
# component-inference dependency (torch) has to be present too, not a
# stripped-down subset. That's a real, deliberate size/build-time cost.

# scripts/extract_incidents.py and server/app.py only ever run git against
# github-status-history.atom (git log/show -- that path). This stage rewrites
# a copy of the repo's history down to just the commits/blobs that touch that
# one file, so the runtime image doesn't have to ship the whole project's
# git history. This runs entirely inside the build container -- filter-repo
# rewrites the checkout that was COPYed in here, never the host repo the
# build was invoked from.
#
# Only /repo/.git is taken from this stage below, not /repo's working tree:
# filter-repo rewrites every commit's tree to contain just the path it was
# given, so the checkout in this stage now has only github-status-history.atom

FROM public.ecr.aws/amazonlinux/amazonlinux:2023 AS git-history-filter

RUN dnf install -y \
    git  \
    python3.13 \
    python3.13-pip \
    && dnf clean all \
    && rm -rf /var/cache/dnf

# Create symlinks for Python
RUN ln -sf /usr/bin/python3.13 /usr/bin/python3 && \
    ln -sf /usr/bin/python3 /usr/bin/python && \
    ln -sf /usr/bin/pip3.13 /usr/bin/pip3 && \
    ln -sf /usr/bin/pip3 /usr/bin/pip

RUN pip install --no-cache-dir git-filter-repo

WORKDIR /repo
COPY . .
# --force: filter-repo refuses to run on anything but a fresh clone by
# default. This checkout only ever exists inside this build stage.
RUN git filter-repo --force --path github-status-history.atom

FROM public.ecr.aws/amazonlinux/amazonlinux:2023 AS builder

# install python 3.13
RUN dnf install -y \
    python3.13 \
    tar \
    gzip \
    && dnf clean all \
    && rm -rf /var/cache/dnf

# Create symlinks for Python
RUN ln -sf /usr/bin/python3.13 /usr/bin/python3 && \
    ln -sf /usr/bin/python3 /usr/bin/python

# install uv
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# Set working directory
WORKDIR /app

# Copy project files for dependency installation
COPY pyproject.toml README.md uv.lock ./
COPY server/ /app/server/
COPY scripts/ /app/scripts/

# Create a virtual environment and install dependencies using uv
# Install all dependencies exactly as locked in uv.lock (ensures reproducible builds)
RUN uv sync --frozen --no-dev --python 3.13

# Pre-download the GLiNER2 component-inference model (scripts/extract_incidents.py's
# --gliner-model default, matching server/app.py's EXTRACT_INCIDENTS_ARGS, which
# doesn't override it) so a freshly started container never has to fetch it from
# Hugging Face Hub. Without this, the first incidents refresh in
# _incidents_poll_loop blocks on that download with no timeout, which leaves
# /health/readiness reporting {"incidents": false} / 503 for however long it takes.
ENV HF_HOME=/app/.cache/huggingface
RUN uv run python -c "from gliner2 import GLiNER2; GLiNER2.from_pretrained('fastino/gliner2-base-v1')"

# Final stage - runtime image
FROM public.ecr.aws/amazonlinux/amazonlinux:2023

# No python3.13-pip / uv here either: docker-entrypoint.sh runs uvicorn
# directly off the already-frozen venv (via the PATH entry below), so
# there's nothing left at container startup for uv or pip to do.
RUN dnf install -y \
    git  \
    python3.13 \
    && dnf clean all \
    && rm -rf /var/cache/dnf

# Create symlinks for Python
RUN ln -sf /usr/bin/python3.13 /usr/bin/python3 && \
    ln -sf /usr/bin/python3 /usr/bin/python

# Create a non-root user
RUN useradd -m -u 1000 appuser

# Set working directory
WORKDIR /app

# Copy only the necessary files from the builder stage
COPY --from=git-history-filter /repo/.git /app/.git
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/server /app/server
COPY --from=builder /app/scripts /app/scripts
COPY --from=builder /app/.cache/huggingface /app/.cache/huggingface
COPY parsed/ /app/parsed/
COPY github-status-history.atom /app/
COPY site/ /app/site/
COPY .cache/ /app/.cache/
COPY docker-entrypoint.sh /app/

RUN chmod +x /app/docker-entrypoint.sh && \
    # Set ownership for application directories
    chown -R appuser:appuser /app

# git commit (server/app.py:refresh_atom_feed) needs an identity even
# though GIT_AUTHOR_*/GIT_COMMITTER_* env vars are set per-commit already
# This has to live here, not in builder: it's /app/.git (from git-history-filter)
RUN git config --global user.email "github-statuses-service@localhost" \
    && git config --global user.name "github-statuses-service" \
    && git config --global --add safe.directory /app

ENV HOST=0.0.0.0
ENV PORT=8000
ENV PYTHONUNBUFFERED=1
ENV PATH="/app/.venv/bin:$PATH"
# Must match the builder stage's HF_HOME so the model baked in there
ENV HF_HOME=/app/.cache/huggingface

# Configure Datadog logging
ENV DD_LOGS_INJECTION=true
ENV DD_TRACE_SAMPLE_RATE=1.0
ENV DD_PROFILING_ENABLED=true
ENV DD_LOGS_CONFIG_PROCESSING_ENABLED=true
ENV DD_LOGS_INJECTION_ENABLED=true

EXPOSE 8000

# switch to non-root user
USER appuser

ENTRYPOINT ["/app/docker-entrypoint.sh"]