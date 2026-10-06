# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
#
# Bandstand: one image, one band.
#
#   docker build -t bandstand .
#
# The reader and SaltyCharts editor are built from this repository together.

# Everything the image is built from is pinned by digest, so the same commit gives
# the same image tomorrow. The tag is kept for the reader; the digest is what is
# used. Dependabot proposes the bumps (.github/dependabot.yml).
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ARG PYTHON_IMAGE=python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e
# --- Stage 1a: client bundles (app, guest, room) -------------------------------
# $BUILDPLATFORM: the output is plain JS and CSS, so a multi-platform build
# compiles it once on the native builder instead of once per target under emulation.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS client
ENV CI=1 npm_config_update_notifier=false
WORKDIR /src/client
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
# "npm run build" type-checks (tsc -b), then writes ../server/static/{app,guest,room}.
RUN npm run build \
 && npm run check:copy \
 && test -f /src/server/static/app/index.html \
 && test -f /src/server/static/guest/guest.js \
 && test -f /src/server/static/room/room.html

# --- Stage 1b: bundled chart editor -------------------------------------------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS charts
ENV CI=1 npm_config_update_notifier=false
WORKDIR /src/charts
COPY charts/package.json charts/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY charts/ ./
RUN npm run build:bandstand \
 && test -f /src/server/static/charts/index.html

# --- Stage 2a: Python dependencies ---------------------------------------------
FROM ${PYTHON_IMAGE} AS deps
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1
RUN python -m venv /opt/venv
COPY server/requirements.lock /tmp/requirements.lock
# Exact versions, verified by hash. Regenerate the lock per RELEASING.md.
RUN /opt/venv/bin/pip install --require-hashes --only-binary=:all: -r /tmp/requirements.lock \
 # The running server never installs anything, so the installer does not ship.
 && /opt/venv/bin/python -m pip uninstall --yes pip

# --- Stage 2b: runtime ---------------------------------------------------------
FROM ${PYTHON_IMAGE} AS runtime

ARG BANDSTAND_UID=1000
ARG BANDSTAND_GID=1000

# No secrets here, and none are ever needed at build time.
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    BANDSTAND_DATA_DIR=/data \
    BANDSTAND_HOST=0.0.0.0 \
    BANDSTAND_PORT=7800

# The share pages run as their own user, in the server's group, so that the one
# process strangers can reach is unable to read the director key.
ARG BANDSTAND_SHARE_UID=1001

# /data is created and owned here so that a fresh named volume inherits the
# ownership and the 0700 mode the first time it is mounted.
RUN groupadd --gid ${BANDSTAND_GID} bandstand \
 && useradd --uid ${BANDSTAND_UID} --gid ${BANDSTAND_GID} \
        --home-dir /data --no-create-home --shell /usr/sbin/nologin bandstand \
 && useradd --uid ${BANDSTAND_SHARE_UID} --gid ${BANDSTAND_GID} \
        --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin bandstand-share \
 && mkdir -p /data /app \
 && chown ${BANDSTAND_UID}:${BANDSTAND_GID} /data \
 && chmod 0700 /data \
 # The running server never installs anything and never changes user. The base
 # image's own installer goes, and no program keeps a set-user or set-group bit,
 # so a plain "docker run" without the compose hardening has nothing to climb.
 && /usr/local/bin/python3 -m pip uninstall --yes pip \
 && rm -rf /usr/local/lib/python3*/ensurepip /usr/local/bin/pip* /root/.cache \
 && find / -xdev -type f -perm /6000 -exec chmod a-s {} +

WORKDIR /app
COPY LICENSE NOTICE TRADEMARKS.md THIRD-PARTY-NOTICES.md /app/
COPY licenses/ /app/licenses/
COPY --from=deps /opt/venv /opt/venv
# The application stays owned by root and read-only to the server process.
# Named one by one: only source reaches the image, never a stray file that was
# lying in the folder. .dockerignore enforces the same list a second time.
COPY server/*.py server/pyproject.toml /app/server/
COPY server/api/*.py /app/server/api/
COPY server/ingest/*.py /app/server/ingest/
COPY server/migrations/*.sql /app/server/migrations/
COPY --from=client /src/server/static/ /app/server/static/
COPY --from=charts /src/server/static/charts/ /app/server/static/charts/

# Numeric, so an orchestrator can verify "runs as non-root" without a passwd lookup.
USER ${BANDSTAND_UID}:${BANDSTAND_GID}

VOLUME ["/data"]
EXPOSE 7800

# The share pages run from this same image on another port. They set
# BANDSTAND_HEALTH_URL so that this probe looks in the right place.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-m", "server.healthcheck"]

# Labels last: a version bump must not invalidate the layers above.
ARG BANDSTAND_VERSION=dev
ARG BANDSTAND_REVISION=unknown
LABEL org.opencontainers.image.title="Bandstand" \
      org.opencontainers.image.description="Self-hosted sheet music reader and gig book. One server per band." \
      org.opencontainers.image.version="${BANDSTAND_VERSION}" \
      org.opencontainers.image.revision="${BANDSTAND_REVISION}"

# First boot creates the director key in /data and prints its PATH, never its value.
CMD ["python", "-m", "server.serve"]
