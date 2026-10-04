"""Saltycharts library sync: the pull + delete half of the server-side library.

Push existed first (/api/upload-chart, /api/upload-setlist). These endpoints let a
Saltycharts client PULL the library back down and propagate deletes, which is what
makes Bandstand the library of record instead of each browser's per-origin
localStorage (the recurring "where did my charts go" incidents, third one 2026-08-20).

Freshness is judged on the updatedAt INSIDE chart_json — the client clock domain the
devices themselves compare in — never on pieces.updated_at, which is server-stamped
and also moves on Bandstand-side meta edits (play_count, tags) that don't change the
chart's content. Tombstoned chart pieces are included in the pull so a delete made on
one device reaches the others; deleted_at is a server timestamp, which is fine for the
rare delete-vs-edit race across one director's own clock-synced devices.
"""
import json
import time

from fastapi import APIRouter, Depends, HTTPException

from server import auth, config, db
from server.api import events

router = APIRouter()


@router.get("/api/charts", dependencies=[Depends(auth.require_key)])
def list_charts():
    """Every chart piece, live AND tombstoned, keyed by the Saltycharts chart id.

    The full set is small (a working library is dozens of charts of a few KB), so
    there is no incremental `since` — the client always merges against the complete
    truth, which also makes "absent = the server never saw it" a safe inference.
    """
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        rows = conn.execute(
            "SELECT chart_source_id, chart_json, updated_at, deleted_at "
            "FROM pieces WHERE kind = 'chart' AND chart_source_id IS NOT NULL"
        ).fetchall()
    finally:
        conn.close()
    out = []
    for r in rows:
        try:
            chart = json.loads(r["chart_json"]) if r["chart_json"] else None
        except ValueError:
            chart = None
        out.append({
            "source_id": r["chart_source_id"],
            "chart": chart,
            "updated_at": r["updated_at"],
            "deleted_at": r["deleted_at"],
        })
    return {"charts": out}


@router.delete("/api/charts/{source_id}", dependencies=[Depends(auth.require_key)])
def delete_chart(source_id: str):
    """Soft-delete a chart piece by its Saltycharts id and remove its library file.

    The file removal is what prevents resurrection: boot-time scan_library re-ingests
    every .saltychart.json it finds, and a tombstoned row would come back as a fresh
    piece. The chart body survives in the tombstoned row's chart_json. The watcher's
    own delete event for the removed file then matches an already-deleted piece, which
    is a no-op.
    """
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute(
            "SELECT id, chart_file FROM pieces "
            "WHERE chart_source_id = ? AND kind = 'chart' AND deleted_at IS NULL",
            (source_id,),
        ).fetchone()
        if not row:
            raise HTTPException(404, "Chart not found")
        now = int(time.time() * 1000)
        conn.execute(
            "UPDATE pieces SET deleted_at = ?, updated_at = ? WHERE id = ?",
            (now, now, row["id"]),
        )
    finally:
        conn.close()

    removed_path = None
    if row["chart_file"]:
        target = (cfg.library_dir / row["chart_file"]).resolve()
        if cfg.library_dir.resolve() in target.parents and target.is_file():
            target.unlink()
            removed_path = str(target)
    events.publish("piece_deleted", path=removed_path or row["chart_file"] or "")
    return {"ok": True}


@router.delete("/api/saltycharts-setlists/{source_id}",
               dependencies=[Depends(auth.require_key)])
def delete_saltycharts_setlist(source_id: str):
    """Delete a Saltycharts-born setlist by its Saltycharts id. Hard delete, matching
    Bandstand's own DELETE /api/setlists/{id} semantics (no tombstone column on
    setlists); items go with it via the FK cascade. Absence from the next
    /api/saltycharts-setlists snapshot is what tells other devices. Deleting a setlist
    never touches its charts. Idempotent: deleting an unknown id is ok=True, so a
    re-flushed offline queue can't wedge on a 404."""
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        conn.execute("DELETE FROM setlists WHERE source_id = ?", (source_id,))
    finally:
        conn.close()
    events.publish("data_changed")
    return {"ok": True}


@router.get("/api/saltycharts-setlists", dependencies=[Depends(auth.require_key)])
def list_saltycharts_setlists():
    """Setlists that originated in Saltycharts (source_id set), with their chart ids
    in item order. Bandstand-native break rows and non-chart pieces are skipped, the
    same information loss upload_setlist already documents. Setlist deletes are HARD
    deletes in Bandstand (no tombstone column), so absence from this full snapshot is
    the delete signal; the client guards its own un-pushed setlists with its pending
    queue before honoring an absence.
    """
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        setlists = conn.execute(
            "SELECT id, source_id, name, updated_at FROM setlists "
            "WHERE source_id IS NOT NULL"
        ).fetchall()
        out = []
        for sl in setlists:
            chart_ids = [
                r["chart_source_id"]
                for r in conn.execute(
                    "SELECT p.chart_source_id FROM setlist_items si "
                    "JOIN pieces p ON p.id = si.piece_id "
                    "WHERE si.setlist_id = ? AND si.kind = 'piece' "
                    "AND p.chart_source_id IS NOT NULL AND p.deleted_at IS NULL "
                    "ORDER BY si.ordinal",
                    (sl["id"],),
                ).fetchall()
            ]
            out.append({
                "source_id": sl["source_id"],
                "name": sl["name"],
                "chart_source_ids": chart_ids,
                "updated_at": sl["updated_at"],
            })
        return {"setlists": out}
    finally:
        conn.close()
