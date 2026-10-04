import json
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from server import auth, config, db
from server.api import events
from server.config import Config
from server.ingest import chart_meta, pipeline
from server.ulid import new_ulid

router = APIRouter()


def prepare_chart(cfg: Config, chart: Any) -> tuple[Any, Path, str]:
    """Validate one chart and resolve its on-disk target, raising BEFORE any write so a
    batch (the setlist endpoint) can validate every chart up front and stay all-or-nothing.
    400 = bad envelope or oversize; 422 = missing/blank id (the UPSERT identity and the
    on-disk stem — Saltycharts always sends one, but don't trust that it did). Returns the
    (chart, resolved target path, library-relative filename) the writer needs."""
    raw = json.dumps(chart).encode("utf-8") if chart is not None else b""
    ok, err = chart_meta.validate(chart, len(raw))
    if not ok:
        raise HTTPException(400, err)
    source_id = chart_meta.chart_id(chart)
    if not source_id:
        raise HTTPException(422, "Chart 'id' is required")
    # Deterministic filename from the chart id so a re-send overwrites its own file.
    stem = chart_meta.safe_stem(source_id) or new_ulid()
    target = (cfg.library_dir / f"{stem}{chart_meta.CHART_SUFFIX}").resolve()
    if cfg.library_dir.resolve() not in target.parents:
        raise HTTPException(400, "Invalid chart id")
    rel = target.relative_to(cfg.library_dir).as_posix()
    return chart, target, rel


def write_and_upsert(conn, cfg: Config, chart: Any, target: Path, rel: str, now: int,
                     placeholder_id: str | None = None, match_placeholder: bool = True) -> str:
    """Write the chart JSON to disk (durability + parity with every other piece) and upsert
    its piece row, keyed on the Saltycharts chart.id. Runs inside the CALLER's transaction;
    `chart`/`target`/`rel` must come from prepare_chart. Returns the piece id.

    A stale push (stored copy strictly newer, see pipeline.stale_chart_row) is dropped
    BEFORE the disk write, not just the row update — otherwise an old offline device
    would overwrite the newer on-disk .saltychart.json while the DB kept the newer copy,
    and the two would disagree until the next edit."""
    stale = pipeline.stale_chart_row(conn, chart)
    if stale is not None:
        return stale["id"]
    if placeholder_id:
        selected = pipeline.require_placeholder(conn, placeholder_id)
        existing = pipeline._find_chart_row(conn, str(chart.get('id') or ''))
        if existing and existing['id'] != selected['id']:
            raise HTTPException(409, 'This chart already belongs to another song')
    cfg.library_dir.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(chart, ensure_ascii=False, indent=2), encoding="utf-8")
    return pipeline.upsert_chart_piece(conn, chart, now, chart_file=rel,
                                       placeholder_id=placeholder_id, match_placeholder=match_placeholder)


@router.post("/api/upload-chart", dependencies=[Depends(auth.require_key)])
def upload_chart(body: dict[str, Any]):
    """Persist a Saltycharts chart as a native piece.

    Body: {"chart": {...}} — the full Chart object. The chart is written to disk as a
    <id>.saltychart.json file (durability + parity with every other piece), the piece
    row is upserted (kind='chart', chart_json filled, title/composer from the chart), and
    a live-push tells other devices to re-mirror. UPSERT is keyed on the Saltycharts
    chart.id, so Saltycharts re-sending after an edit replaces the piece in place.
    """
    cfg = config.load()
    chart, target, rel = prepare_chart(cfg, body.get("chart"))

    now = int(time.time() * 1000)
    conn = db.connect(cfg.db_path)
    try:
        # IMMEDIATE, not deferred: these transactions read then write, and a deferred
        # read->write upgrade returns SQLITE_BUSY WITHOUT invoking the busy handler when
        # another writer holds the lock (it would deadlock on the stale snapshot). Under
        # concurrency (sync-client burst flush + the watcher re-ingesting each uploaded
        # chart file) that surfaced as 500 "database is locked" (2026-08-20 seeding run).
        # IMMEDIATE takes the write lock up front so the 5s busy timeout actually applies.
        conn.execute("BEGIN IMMEDIATE")
        piece_id = write_and_upsert(conn, cfg, chart, target, rel, now, placeholder_id=body.get('placeholder_id'))
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()

    # Same live-push a watcher-ingested chart fires, so other devices re-mirror at once
    # instead of waiting on the filesystem debounce.
    events.publish("piece_changed", path=str(target))
    return {"id": piece_id}
