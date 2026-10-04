import time
from typing import Any

from fastapi import APIRouter, Depends

from server import auth, config, db
from server.ulid import new_ulid

router = APIRouter()

_ALLOWED = {"name", "date", "venue", "notes", "created_at", "updated_at"}


@router.put("/api/setlists/{setlist_id}", dependencies=[Depends(auth.require_key)])
def upsert_setlist(setlist_id: str, payload: dict[str, Any]):
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        now = int(time.time() * 1000)
        row = conn.execute(
            "SELECT id FROM setlists WHERE id = ?", (setlist_id,)
        ).fetchone()
        if row:
            sets, params = [], []
            for k, v in payload.items():
                if k not in _ALLOWED:
                    continue
                sets.append(f"{k} = ?")
                params.append(v)
            if "updated_at" not in payload:
                sets.append("updated_at = ?")
                params.append(now)
            if sets:
                params.append(setlist_id)
                conn.execute(
                    f"UPDATE setlists SET {', '.join(sets)} WHERE id = ?", params
                )
            return {"ok": True}
        conn.execute(
            "INSERT INTO setlists (id, name, date, venue, notes, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                setlist_id,
                payload.get("name", ""),
                payload.get("date"),
                payload.get("venue"),
                payload.get("notes"),
                payload.get("created_at", now),
                payload.get("updated_at", now),
            ),
        )
        return {"ok": True}
    finally:
        conn.close()


@router.put(
    "/api/setlists/{setlist_id}/items",
    dependencies=[Depends(auth.require_key)],
)
def replace_items(setlist_id: str, items: list[dict[str, Any]]):
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        # IMMEDIATE, not deferred: these transactions read then write, and a deferred
        # read->write upgrade returns SQLITE_BUSY WITHOUT invoking the busy handler when
        # another writer holds the lock (it would deadlock on the stale snapshot). Under
        # concurrency (sync-client burst flush + the watcher re-ingesting each uploaded
        # chart file) that surfaced as 500 "database is locked" (2026-08-20 seeding run).
        # IMMEDIATE takes the write lock up front so the 5s busy timeout actually applies.
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute(
                "DELETE FROM setlist_items WHERE setlist_id = ?", (setlist_id,)
            )
            for i, it in enumerate(items):
                conn.execute(
                    "INSERT INTO setlist_items "
                    "(id, setlist_id, kind, piece_id, break_label, ordinal) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        it.get("id") or new_ulid(),
                        setlist_id,
                        it.get("kind", "piece"),
                        it.get("piece_id"),
                        it.get("break_label"),
                        i,
                    ),
                )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/api/setlists/{setlist_id}", dependencies=[Depends(auth.require_key)])
def delete_setlist(setlist_id: str):
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        conn.execute("DELETE FROM setlists WHERE id = ?", (setlist_id,))
        return {"ok": True}
    finally:
        conn.close()
