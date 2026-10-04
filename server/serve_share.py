"""Start the share pages: `python -m server.serve_share`.

The share pages are a second, separate process (server.public). Guests reach this
one and never the main app. It reads the library and writes nothing but its own
cache of rendered pages.

Request logging is always off here: every share address carries its own secret
token, and there is no setting to turn that logging on.
"""
import os
import sys

from server import config, serve, share_access
from server.version import VERSION

DEFAULT_PORT = 7810


def port() -> int:
    raw = os.environ.get("BANDSTAND_SHARE_PORT", "").strip()
    if not raw:
        return DEFAULT_PORT
    try:
        return int(raw)
    except ValueError:
        raise config.ConfigProblem(
            f"BANDSTAND_SHARE_PORT must be a whole number, got {raw!r}"
        ) from None


def main() -> int:
    try:
        cfg = config.load()
        listen_on = port()
        warnings = share_access.check_from_share_process(cfg)
    except (ValueError, share_access.ShareProblem) as problem:
        print(f"Cannot start: {problem}", file=sys.stderr)
        return 1
    print(f"Bandstand share pages {VERSION}")
    print(f"Data folder: {cfg.data_dir} (read only)")
    for line in warnings:
        print(line)
    level = serve.log_level()
    host = os.environ.get("BANDSTAND_HOST", "").strip() or "127.0.0.1"
    print(f"Listening on {host}:{listen_on}", flush=True)

    import uvicorn

    uvicorn.run(
        "server.public:app", host=host, port=listen_on, access_log=False, log_level=level
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
