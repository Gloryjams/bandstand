import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from server import auth, config, db
from server.api import events
from server.api.upload_chart import prepare_chart, write_and_upsert
from server.ulid import new_ulid

router = APIRouter()

# A gig-sized set. Refuse an implausibly long payload before ingesting 50+ charts.
MAX_SET_CHARTS = 50


def _upsert_setlist_row(conn, source_id: str, name: str, now: int,
                        client_updated_at: int | None = None) -> str | None:
    """Insert or update the Bandstand setlist row keyed on the Saltycharts setlist id.
    On re-send only `name` and `updated_at` follow the payload; date/venue/notes are
    Bandstand-native and left intact (Saltycharts never sends them). Returns the Bandstand
    setlist id (a ULID, stable across re-sends — not the Saltycharts id).

    When the client sends its `updatedAt`, it is STORED as updated_at (keeping the
    freshness column in the client clock domain the sync compares in), and a payload
    older than the stored row is silently dropped (returns None; the caller must then
    leave the items untouched too). Same wedge rationale as the /api/sync annotation
    guard: a stale offline device must neither clobber newer state nor error forever."""
    ts = int(client_updated_at) if client_updated_at else now
    row = conn.execute(
        "SELECT id, updated_at FROM setlists WHERE source_id = ?", (source_id,)
    ).fetchone()
    if row:
        if client_updated_at and row["updated_at"] and row["updated_at"] > ts:
            return None
        conn.execute(
            "UPDATE setlists SET name = ?, updated_at = ? WHERE id = ?",
            (name, ts, row["id"]),
        )
        return row["id"]
    setlist_id = new_ulid()
    conn.execute(
        "INSERT INTO setlists (id, source_id, name, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (setlist_id, source_id, name, now, ts),
    )
    return setlist_id


def _replace_piece_items(conn, setlist_id: str, piece_ids: list[str]) -> None:
    """Rebuild the setlist's items from the payload order (Saltycharts is the source of
    truth for order). Full DELETE + re-insert mirrors the /api/setlists/{id}/items and
    sync setlist_items paths. Any prior items — including Bandstand-native break rows —
    are dropped; a piece-only payload gives interspersed breaks no anchor to survive."""
    conn.execute("DELETE FROM setlist_items WHERE setlist_id = ?", (setlist_id,))
    for i, pid in enumerate(piece_ids):
        conn.execute(
            "INSERT INTO setlist_items "
            "(id, setlist_id, kind, piece_id, break_label, ordinal) "
            "VALUES (?, ?, 'piece', ?, NULL, ?)",
            (new_ulid(), setlist_id, pid, i),
        )


@router.post("/api/upload-setlist", dependencies=[Depends(auth.require_key)])
def upload_setlist(body: dict[str, Any]):
    """Persist a whole Saltycharts setlist as a native Bandstand setlist.

    Body: {"setlist": {"id", "name", "charts": [<Chart>, ...in set order]}}. Every chart
    is upserted exactly as /api/upload-chart does (same prepare/write path), then a setlist
    row is upserted keyed on the Saltycharts setlist id and its items rebuilt to match the
    incoming chart order. Atomic: every chart is validated before anything is written, so a
    single invalid chart rejects the whole set (422) with nothing persisted. Fires the same
    `data_changed` live-push the sync path fires so open devices re-mirror at once.
    """
    cfg = config.load()
    setlist = body.get("setlist")
    if not isinstance(setlist, dict):
        raise HTTPException(422, "'setlist' object is required")
    # id is the UPSERT identity — reject before any writes.
    source_id = str(setlist.get("id") or "").strip()
    if not source_id:
        raise HTTPException(422, "Setlist 'id' is required")
    raw_name = setlist.get("name")
    name = raw_name.strip() if isinstance(raw_name, str) and raw_name.strip() else "Untitled set"
    charts = setlist.get("charts")
    if not isinstance(charts, list):
        raise HTTPException(422, "Setlist 'charts' must be an array")
    if len(charts) > MAX_SET_CHARTS:
        raise HTTPException(422, f"Too many charts (max {MAX_SET_CHARTS})")

    # Validate + resolve EVERY chart before touching disk or DB, so one bad chart aborts
    # the whole set (atomicity beats a partial set). prepare_chart raises 400/422.
    prepared = [prepare_chart(cfg, chart) for chart in charts]

    now = int(time.time() * 1000)
    conn = db.connect(cfg.db_path)
    piece_ids: list[str] = []
    # Optional client content timestamp (the sync path sends it; the manual
    # send-the-set button predates it and may not). Bad values degrade to None.
    try:
        client_updated_at = int(setlist.get("updatedAt")) or None
    except (TypeError, ValueError):
        client_updated_at = None

    try:
        # IMMEDIATE, not deferred: these transactions read then write, and a deferred
        # read->write upgrade returns SQLITE_BUSY WITHOUT invoking the busy handler when
        # another writer holds the lock (it would deadlock on the stale snapshot). Under
        # concurrency (sync-client burst flush + the watcher re-ingesting each uploaded
        # chart file) that surfaced as 500 "database is locked" (2026-08-20 seeding run).
        # IMMEDIATE takes the write lock up front so the 5s busy timeout actually applies.
        conn.execute("BEGIN IMMEDIATE")
        for chart, target, rel in prepared:
            piece_ids.append(write_and_upsert(conn, cfg, chart, target, rel, now))
        setlist_id = _upsert_setlist_row(conn, source_id, name, now, client_updated_at)
        # None = the stored setlist is strictly newer than this payload; the charts
        # above still self-guarded individually, but the setlist row and its item
        # order stay as they are.
        if setlist_id is not None:
            _replace_piece_items(conn, setlist_id, piece_ids)
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()

    # Same broadcast /api/sync fires after applying ops. The origin here is Saltycharts
    # (a separate app, not a paired Bandstand device), so nothing is excluded.
    events.publish("data_changed")
    return {"id": setlist_id, "pieceIds": piece_ids}
