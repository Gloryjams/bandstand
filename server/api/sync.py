import json
import time
from typing import Any

from fastapi import APIRouter, Depends, Request

from server import auth, config, db
from server.api import events
from server.ulid import new_ulid

router = APIRouter()

_PIECE_FIELDS = {
    "title", "composer", "music_key", "time_sig", "tempo", "genre",
    "tags", "notes", "preferred_orientation", "default_half_page_turns",
    "last_opened_at", "play_count",
}
_BOOKMARK_FIELDS = {"piece_id", "file_id", "page_index", "label", "ordinal"}
_LINK_FIELDS = {
    "piece_id", "from_file_id", "from_page_index",
    "to_bookmark_id", "initial_triggers", "active",
}
_SETLIST_FIELDS = {"name", "date", "venue", "notes", "created_at", "updated_at"}


def _apply_one(conn, op: dict[str, Any]) -> None:
    action = op.get("op")
    entity = op.get("entity")
    payload = op.get("payload", {}) or {}
    now = int(time.time() * 1000)

    if entity == "annotations":
        piece_id = payload["piece_id"]
        file_id = payload["file_id"]
        page_index = int(payload["page_index"])
        if action == "delete":
            conn.execute(
                "DELETE FROM annotations WHERE piece_id = ? AND file_id = ? AND page_index = ?",
                (piece_id, file_id, page_index),
            )
            return
        svg = json.dumps(payload.get("svg_paths", []))
        # Stale-write guard: a phone that syncs week-old ink must not clobber newer
        # ink already on the server (real incident 2026-07-03). If the payload carries
        # an updated_at and the existing row is strictly newer, silently drop the write.
        # It must NOT raise — a rejected op stays queued on the offline client forever
        # and a non-empty queue blocks its manifest mirror, wedging the device; a silent
        # drop still counts as applied. Payloads without updated_at keep last-write-wins.
        if "updated_at" in payload:
            ts = int(payload["updated_at"])
            existing = conn.execute(
                "SELECT updated_at FROM annotations "
                "WHERE piece_id = ? AND file_id = ? AND page_index = ?",
                (piece_id, file_id, page_index),
            ).fetchone()
            if existing is not None and existing[0] > ts:
                return
        else:
            ts = now
        conn.execute(
            "INSERT INTO annotations (piece_id, file_id, page_index, svg_paths, updated_at) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(piece_id, file_id, page_index) "
            "DO UPDATE SET svg_paths = excluded.svg_paths, updated_at = excluded.updated_at",
            (piece_id, file_id, page_index, svg, ts),
        )
        return

    if entity == "bookmarks":
        bookmark_id = payload.get("id") or payload.get("bookmark_id")
        if action == "delete":
            conn.execute("DELETE FROM bookmarks WHERE id = ?", (bookmark_id,))
            return
        row = conn.execute(
            "SELECT id FROM bookmarks WHERE id = ?", (bookmark_id,)
        ).fetchone()
        if row:
            sets, params = [], []
            for k, v in payload.items():
                if k in _BOOKMARK_FIELDS:
                    sets.append(f"{k} = ?")
                    params.append(v)
            if sets:
                params.append(bookmark_id)
                conn.execute(
                    f"UPDATE bookmarks SET {', '.join(sets)} WHERE id = ?", params
                )
        else:
            conn.execute(
                "INSERT INTO bookmarks (id, piece_id, file_id, page_index, label, ordinal) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    bookmark_id,
                    payload.get("piece_id"),
                    payload.get("file_id"),
                    payload.get("page_index"),
                    payload.get("label"),
                    payload.get("ordinal"),
                ),
            )
        return

    if entity == "section_links":
        link_id = payload.get("id") or payload.get("link_id")
        if action == "delete":
            conn.execute("DELETE FROM section_links WHERE id = ?", (link_id,))
            return
        row = conn.execute(
            "SELECT id FROM section_links WHERE id = ?", (link_id,)
        ).fetchone()
        if row:
            sets, params = [], []
            for k, v in payload.items():
                if k in _LINK_FIELDS:
                    sets.append(f"{k} = ?")
                    params.append(v)
            if sets:
                params.append(link_id)
                conn.execute(
                    f"UPDATE section_links SET {', '.join(sets)} WHERE id = ?", params
                )
        else:
            conn.execute(
                "INSERT INTO section_links "
                "(id, piece_id, from_file_id, from_page_index, "
                "to_bookmark_id, initial_triggers, active) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    link_id,
                    payload.get("piece_id"),
                    payload.get("from_file_id"),
                    payload.get("from_page_index"),
                    payload.get("to_bookmark_id"),
                    payload.get("initial_triggers", 1),
                    payload.get("active", 1),
                ),
            )
        return

    if entity == "pieces":
        piece_id = payload.get("id") or payload.get("piece_id")
        if action == "delete":
            conn.execute(
                "UPDATE pieces SET deleted_at = ?, updated_at = ? WHERE id = ?",
                (now, now, piece_id),
            )
            return
        sets, params = [], []
        for k, v in payload.items():
            if k not in _PIECE_FIELDS:
                continue
            if k == "tags" and isinstance(v, list):
                v = json.dumps(v)
            sets.append(f"{k} = ?")
            params.append(v)
        if sets:
            sets.append("updated_at = ?")
            params.append(now)
            params.append(piece_id)
            conn.execute(f"UPDATE pieces SET {', '.join(sets)} WHERE id = ?", params)
        return

    if entity == "setlists":
        setlist_id = payload.get("id") or payload.get("setlist_id")
        if action == "delete":
            conn.execute("DELETE FROM setlists WHERE id = ?", (setlist_id,))
            return
        row = conn.execute(
            "SELECT id FROM setlists WHERE id = ?", (setlist_id,)
        ).fetchone()
        if row:
            sets, params = [], []
            for k, v in payload.items():
                if k in _SETLIST_FIELDS:
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
        else:
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
        return

    if entity == "setlist_items":
        # Replace mode — payload: {setlist_id, items: [...]}
        setlist_id = payload.get("setlist_id")
        items = payload.get("items", [])
        conn.execute("DELETE FROM setlist_items WHERE setlist_id = ?", (setlist_id,))
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
        return

    raise ValueError(f"unknown entity: {entity!r}")


@router.post("/api/sync", dependencies=[Depends(auth.require_key)])
def sync(body: dict[str, Any], request: Request):
    cfg = config.load()
    ops = body.get("ops", [])
    applied = 0
    errors: list[dict[str, Any]] = []
    conn = db.connect(cfg.db_path)
    try:
        for i, op in enumerate(ops):
            # Each op is its own transaction: a multi-statement op (e.g. setlist_items
            # replace) applies all-or-nothing, and one bad op can't wedge the rest.
            try:
                # IMMEDIATE, not deferred: these transactions read then write, and a deferred
                # read->write upgrade returns SQLITE_BUSY WITHOUT invoking the busy handler when
                # another writer holds the lock (it would deadlock on the stale snapshot). Under
                # concurrency (sync-client burst flush + the watcher re-ingesting each uploaded
                # chart file) that surfaced as 500 "database is locked" (2026-08-20 seeding run).
                # IMMEDIATE takes the write lock up front so the 5s busy timeout actually applies.
                conn.execute("BEGIN IMMEDIATE")
                _apply_one(conn, op)
                conn.execute("COMMIT")
                applied += 1
            except Exception as exc:
                conn.execute("ROLLBACK")
                errors.append({"index": i, "error": str(exc)})
    finally:
        conn.close()
    # Tell other devices to re-mirror — excluding the one that made the change, so it
    # doesn't pointlessly re-pull its own writes (annotations sync often).
    if applied:
        events.publish("data_changed", exclude_client=request.headers.get("X-Bandstand-Client"))
    return {"ok": True, "applied": applied, "errors": errors}
