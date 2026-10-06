#!/bin/sh
# Smoke test for a built Bandstand image. Used by CI and by hand before a release:
#
#   sh scripts/smoke-test.sh bandstand:candidate
#
# Starts the image the way docker-compose.yml does (read-only, no capabilities),
# checks that it serves, that it is locked down, and that nothing private was
# built into it. Leaves nothing behind.
#
# Settings: SMOKE_PORT (default 7800), EXPECTED_VERSION (optional).
set -eu

image="${1:?usage: smoke-test.sh <image>}"
port="${SMOKE_PORT:-7800}"
name="${SMOKE_NAME:-bandstand-smoke}"
base="http://127.0.0.1:${port}"

say() { printf '%s\n' "$*"; }
fail() { say "FAIL: $*"; exit 1; }
cleanup() { docker rm -f -v "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$name" -p "127.0.0.1:${port}:7800" \
    --read-only --tmpfs /tmp:size=64m --cap-drop ALL \
    --security-opt no-new-privileges:true "$image" >/dev/null

state=starting
for _ in $(seq 1 45); do
    state=$(docker inspect "$name" --format '{{.State.Health.Status}}')
    [ "$state" = "healthy" ] && break
    sleep 2
done
docker logs "$name"
[ "$state" = "healthy" ] || fail "the container did not become healthy (state: $state)"

# Every page is fetched whole, THEN searched. Piping curl into "grep -q" lets grep
# quit at the first match while curl is still writing, which fails the pipe.
health=$(curl -fsS "$base/api/health")
say "$health"
case "$health" in *'"ok":true'*) ;; *) fail "health does not report ok" ;; esac
if [ -n "${EXPECTED_VERSION:-}" ]; then
    case "$health" in
        *"\"version\":\"${EXPECTED_VERSION}\""*) ;;
        *) fail "health does not report version ${EXPECTED_VERSION}" ;;
    esac
fi

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

[ "$(code "$base/app/")" = "200" ] || fail "/app/ is not served"
# Rehearsal rooms are off unless BANDSTAND_ROOMS is set, and this container did not
# set it: the guest page must be the "switched off" sentence, not the room bundle.
[ "$(code "$base/room/")" = "404" ] || fail "/room/ is served although rooms are off"
room=$(curl -s "$base/room/")
case "$room" in
    *"Rehearsal rooms are switched off"*) ;;
    *) fail "/room/ does not explain that rooms are switched off" ;;
esac
[ "$(code "$base/")" = "307" ] || fail "the bare address does not lead to the app"
[ "$(code "$base/api/manifest")" = "401" ] || fail "the library is readable without a key"
[ "$(code "$base/app/.env")" = "404" ] || fail "a hidden path was served"

charts=$(curl -s "$base/charts/")
case "$charts" in
    *'id="root"'*) ;;
    *) fail "the included chart editor is not served at /charts/" ;;
esac
case "$health" in
    *'"chart_editor":true'*) ;;
    *) fail "health does not report the included editor" ;;
esac
[ "$(code "$base/api/charts")" = "401" ] || fail "editor library is readable without a key"
[ "$(code -H 'Content-Type: application/json' -d '{}' "$base/api/upload-chart")" = "401" ] \
    || fail "chart authoring accepts a request without a director key"
[ "$(code "$base/charts/.env.bandstand")" = "404" ] || fail "an editor environment file was served"

# An upload with no key is refused before it is stored anywhere.
blob=$(mktemp)
head -c 8388608 /dev/zero > "$blob"
upload=$(code -F "file=@${blob};filename=x.pdf" "$base/api/upload-piece")
rm -f "$blob"
[ "$upload" = "401" ] || fail "an upload without a key answered $upload, expected 401"

# Non-root, key private, key never logged.
[ "$(docker exec "$name" id -u)" = "1000" ] || fail "the server does not run as user 1000"
docker exec "$name" sh -c 'test -s /app/LICENSE && test -s /app/NOTICE && test -s /app/THIRD-PARTY-NOTICES.md' \
    || fail "the image is missing its licence notices"
[ "$(docker exec "$name" stat -c '%a' /data/.key)" = "600" ] || fail "the key is not private"
docker logs "$name" 2>&1 | docker exec -i "$name" python -c \
    "import sys; k=open('/data/.key').read().strip(); sys.exit(1 if k in sys.stdin.read() else 0)" \
    || fail "the key appears in the log"

# Nothing to climb with, nothing to install with.
docker exec "$name" sh -c '! /usr/local/bin/python3 -m pip --version >/dev/null 2>&1' \
    || fail "the image still contains pip"
left=$(docker exec "$name" find / -xdev -type f -perm /6000 2>/dev/null | wc -l | tr -d ' ')
[ "$left" = "0" ] || fail "$left programs still carry a set-user or set-group bit"

# Only source in the image. CI plants these files in the build folder first.
docker exec "$name" sh -c '
    cd /app/server
    for f in data key.txt service-account.json server.log .envrc tests pytest.ini \
             requirements-dev.lock requirements.lock .venv; do
        if [ -e "$f" ]; then echo "in the image: /app/server/$f"; exit 1; fi
    done
    extra=$(find /app/server -path /app/server/static -prune -o -type f \
        ! -name "*.py" ! -name "*.sql" ! -name pyproject.toml -print)
    if [ -n "$extra" ]; then echo "in the image, and not source:"; echo "$extra"; exit 1; fi
' || fail "the image contains files that are not source"

say "Smoke test passed: $image"
