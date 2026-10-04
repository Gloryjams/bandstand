from fastapi import APIRouter
from fastapi.responses import JSONResponse

from server import config, db
from server.version import VERSION  # single source of truth: server/pyproject.toml

router = APIRouter()

_MIN_KEY_LENGTH = 32  # the same floor auth.py applies
_key_problem_reported = False


def _key_usable(cfg) -> bool:
    """True when somebody could actually sign in. Without this the server reports
    healthy while every request is answered with 401."""
    global _key_problem_reported
    try:
        usable = len(cfg.key_path.read_text().strip()) >= _MIN_KEY_LENGTH
    except (OSError, UnicodeDecodeError):
        usable = False
    if usable:
        _key_problem_reported = False
    elif not _key_problem_reported:
        # The reason goes to the log, once. A keyless caller only learns "not ok".
        print(
            f"[health] the director key is missing or damaged: {cfg.key_path}. "
            "Nobody can sign in until it is restored.",
            flush=True,
        )
        _key_problem_reported = True
    return usable


def _chart_editor_installed() -> bool:
    # server.main owns the bundle paths and imports this module, so the import
    # happens here, at call time, not at the top of the file.
    from server.main import chart_editor_installed

    return chart_editor_installed()


@router.get("/api/health")
def health():
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM pieces WHERE deleted_at IS NULL"
        ).fetchone()
        # No filesystem paths here: this route is deliberately keyless (pairing
        # probes it) and the demo instance faces the internet.
        body = {
            "ok": True,
            "version": VERSION,
            "name": cfg.display_name,
            "piece_count": row["n"],
            "chart_editor": _chart_editor_installed(),
        }
    finally:
        conn.close()
    if not _key_usable(cfg):
        return JSONResponse(
            {"ok": False, "version": VERSION, "name": cfg.display_name},
            status_code=503,
            headers={"Cache-Control": "no-store"},
        )
    return body
