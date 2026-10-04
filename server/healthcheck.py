"""Container health probe: `python -m server.healthcheck`.

Exit 0 when the local server answers /api/health with ok=true, 1 otherwise. Written
in Python with the standard library so the image needs no curl or wget. Prints
nothing about the instance beyond a one-line reason on failure.

The same image also runs the share pages, which listen on another port and answer
on another path. That process sets BANDSTAND_HEALTH_URL to say where to look.
"""
import json
import os
import sys
import urllib.error
import urllib.request


def url() -> str:
    explicit = os.environ.get("BANDSTAND_HEALTH_URL", "").strip()
    if explicit:
        # A probe looks at its own container and nowhere else.
        if not explicit.startswith(("http://127.0.0.1:", "http://localhost:")):
            raise ValueError("BANDSTAND_HEALTH_URL must start with http://127.0.0.1:")
        return explicit
    raw = os.environ.get("BANDSTAND_PORT", "").strip() or "7800"
    try:
        return f"http://127.0.0.1:{int(raw)}/api/health"
    except ValueError:
        raise ValueError("BANDSTAND_PORT is not a number") from None


def check(target: str, timeout: float = 4.0) -> tuple[bool, str]:
    try:
        with urllib.request.urlopen(target, timeout=timeout) as response:  # noqa: S310
            if response.status != 200:
                return False, f"status {response.status}"
            body = json.loads(response.read(65536))
    except urllib.error.HTTPError as exc:
        return False, f"status {exc.code}"
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return False, type(exc).__name__
    if not isinstance(body, dict) or body.get("ok") is not True:
        return False, "health endpoint did not report ok"
    return True, "ok"


def main() -> int:
    try:
        target = url()
    except ValueError as problem:
        print(f"unhealthy: {problem}", file=sys.stderr)
        return 1
    healthy, reason = check(target)
    if not healthy:
        print(f"unhealthy: {reason}", file=sys.stderr)
    return 0 if healthy else 1


if __name__ == "__main__":
    raise SystemExit(main())
