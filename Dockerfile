# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
#
# Bandstand: one image, one band.
#
#   docker build -t bandstand .
#
# With the optional chart editor (SaltyCharts, a separate repository):
#
#   docker build -t bandstand --build-arg WITH_CHARTS=1 \
#       --build-context saltycharts=../saltycharts .
#
# The extra context may be a source checkout (it is built here) or a folder that
# already holds a built bundle (it is copied, without hidden files). WITH_CHARTS
# is the switch: without it the editor is left out whatever the context holds, and
# /charts explains that the editor is not installed.

# Everything the image is built from is pinned by digest, so the same commit gives
# the same image tomorrow. The tag is kept for the reader; the digest is what is
# used. Dependabot proposes the bumps (.github/dependabot.yml).
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ARG PYTHON_IMAGE=python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e
ARG WITH_CHARTS=0

# --- Optional chart editor input ---------------------------------------------
# Replaced by --build-context saltycharts=... when the editor is wanted. The
# stand-in holds one marker file and must not be left empty. With an empty stage
# here, the builder (BuildKit 0.27) reused a cached copy of a real editor for a
# build that supplied none, and afterwards kept serving that first copy whatever
# the context held. With the marker file every change of the context is seen.
FROM scratch AS saltycharts
COPY <<EOF /.chart-editor-not-supplied
No chart editor was supplied to this build.
EOF

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

# --- Stage 1b: chart editor bundle (optional) ----------------------------------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS charts
ENV CI=1 npm_config_update_notifier=false
# Part of the cache key on purpose: a build without WITH_CHARTS=1 never ships an
# editor, whatever an earlier build left in the cache.
ARG WITH_CHARTS
# The editor's own build script writes to ../bandstand/server/static/charts, so the
# source sits at /src/saltycharts and its output lands in /src/bandstand.
WORKDIR /src/saltycharts
COPY --from=saltycharts / ./
RUN set -eu; \
    mkdir -p /out/charts; \
    case "${WITH_CHARTS}" in \
        1) ;; \
        0|"") echo "Chart editor: not asked for. /charts will say it is not installed."; exit 0 ;; \
        *) echo "WITH_CHARTS must be 0 or 1, got: ${WITH_CHARTS}"; exit 1 ;; \
    esac; \
    if [ -f package.json ]; then \
        echo "Chart editor: building from source"; \
        rm -rf node_modules; \
        npm ci --no-audit --no-fund; \
        npm run build:bandstand; \
        cp -R /src/bandstand/server/static/charts/. /out/charts/; \
    elif [ -f index.html ]; then \
        echo "Chart editor: using the supplied bundle"; \
        # Visible entries only. A bundle folder that came from a working copy can
        # hold a .git folder or a credentials file, and /charts is served keyless.
        find . -mindepth 1 -maxdepth 1 ! -name '.*' -exec cp -R -t /out/charts/ {} + ; \
    else \
        echo "WITH_CHARTS=1, but no chart editor was supplied."; \
        echo "Add: --build-context saltycharts=<folder with the source or a built bundle>"; \
        exit 1; \
    fi; \
    find /out/charts -mindepth 1 -name '.*' -prune -exec rm -rf {} +; \
    test -f /out/charts/index.html

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
COPY --from=deps /opt/venv /opt/venv
# The application stays owned by root and read-only to the server process.
# Named one by one: only source reaches the image, never a stray file that was
# lying in the folder. .dockerignore enforces the same list a second time.
COPY server/*.py server/pyproject.toml /app/server/
COPY server/api/*.py /app/server/api/
COPY server/ingest/*.py /app/server/ingest/
COPY server/migrations/*.sql /app/server/migrations/
COPY --from=client /src/server/static/ /app/server/static/
COPY --from=charts /out/charts/ /app/server/static/charts/

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
