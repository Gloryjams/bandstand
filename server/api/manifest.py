import time
import json

from fastapi import APIRouter, Depends

from server import auth, config, db

router = APIRouter()
LIVE = "deleted_at IS NULL"


def _rows(conn, sql: str) -> list[dict]:
    return [dict(r) for r in conn.execute(sql).fetchall()]


@router.get("/api/manifest", dependencies=[Depends(auth.require_identity)])
def manifest():
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        roster = conn.execute("SELECT value FROM settings WHERE device_id = 'band' AND key = 'roster'").fetchone()
        try:
            people = json.loads(roster["value"]) if roster else []
        except (ValueError, TypeError):
            people = []
        return {
            "people": people if isinstance(people, list) else [],
            "pieces": _rows(conn, f"SELECT * FROM pieces WHERE {LIVE}"),
            "files": _rows(conn, f"SELECT * FROM files WHERE {LIVE}"),
            "audio_tracks": _rows(conn, f"SELECT * FROM audio_tracks WHERE {LIVE}"),
            "bookmarks": _rows(conn, "SELECT * FROM bookmarks"),
            "annotations": _rows(conn, "SELECT * FROM annotations"),
            "section_links": _rows(conn, "SELECT * FROM section_links"),
            "setlists": _rows(conn, "SELECT * FROM setlists"),
            "setlist_items": _rows(conn, "SELECT * FROM setlist_items"),
            "server_time_ms": int(time.time() * 1000),
        }
    finally:
        conn.close()
