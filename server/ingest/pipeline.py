# TODO(v2): split into ingest/{pieces,doc,audio}.py once API surface stabilizes.
import hashlib
import json
import sqlite3
import time
import unicodedata

from fastapi import HTTPException
from pathlib import Path

from server import db as dbmod
from server.config import Config
from server.ingest import pdf_meta, audio_meta, chordpro_meta, chart_meta, folder_convention as fc
from server.ulid import new_ulid


def _hash_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def scan_library(cfg: Config) -> None:
    """Walk the library directory and ingest any existing files (dedupe by content_hash)."""
    conn = dbmod.connect(cfg.db_path)
    try:
        for path in cfg.library_dir.rglob("*"):
            if path.is_file():
                try:
                    ingest_path(cfg, path, conn=conn)
                except Exception as exc:
                    print(f"[scan_library] {path}: {exc}")
    finally:
        conn.close()


def ingest_path(cfg: Config, path: Path, conn: sqlite3.Connection | None = None, piece_id: str | None = None) -> str | None:
    # Native charts are their own thing: no PDF, no files row — the whole piece is the
    # JSON body. Route them before the media classifier (which only sees a `.json`).
    if chart_meta.is_chart_file(path.name):
        _ingest_chart(cfg, path, conn=conn)
        return
    cls = fc.classify(cfg.library_dir, path)
    if cls.kind == "ignore":
        return
    content_hash = _hash_file(path)
    bytes_size = path.stat().st_size
    now = int(time.time() * 1000)
    owns_conn = conn is None
    if owns_conn:
        conn = dbmod.connect(cfg.db_path)
    try:
        if cls.media == "audio":
            _ingest_audio(conn, cfg, path, cls, content_hash, bytes_size, now)
        else:
            return _ingest_doc(conn, cfg, path, cls, content_hash, bytes_size, now, piece_id=piece_id)
    finally:
        if owns_conn:
            conn.close()


def _normalized_title(value):
    return ' '.join(unicodedata.normalize('NFKC', value or '').casefold().split())


def require_placeholder(conn, piece_id):
    row = conn.execute('SELECT * FROM pieces WHERE id=? AND is_placeholder=1 AND deleted_at IS NULL', (piece_id,)).fetchone()
    if row is None:
        raise HTTPException(409, 'This song is no longer a placeholder. Refresh before adding its chart.')
    return row


def matching_placeholder(conn, title, artist=None):
    rows = [r for r in conn.execute('SELECT * FROM pieces WHERE is_placeholder=1 AND deleted_at IS NULL')
            if _normalized_title(r['title']) == _normalized_title(title)]
    if artist and len(rows) > 1:
        rows = [r for r in rows if not r['composer'] or _normalized_title(r['composer']) == _normalized_title(artist)]
    return rows[0] if len(rows) == 1 else None


def _find_or_create_piece(conn, cls, now: int) -> str:
    placeholder = matching_placeholder(conn, cls.title_default)
    if placeholder:
        return placeholder['id']
    row = conn.execute(
        "SELECT id FROM pieces WHERE title = ? AND is_placeholder=0 AND deleted_at IS NULL",
        (cls.title_default,),
    ).fetchone()
    if row:
        return row["id"]
    piece_id = new_ulid()
    conn.execute(
        "INSERT INTO pieces "
        "(id, title, page_count, added_at, updated_at) "
        "VALUES (?, ?, 0, ?, ?)",
        (piece_id, cls.title_default, now, now),
    )
    return piece_id


def _next_ordinal(conn, piece_id: str) -> int:
    row = conn.execute(
        "SELECT COALESCE(MAX(ordinal), 0) AS m FROM files WHERE piece_id = ?",
        (piece_id,),
    ).fetchone()
    return (row["m"] or 0) + 1


def _ingest_doc(conn, cfg, path, cls, content_hash, bytes_size, now, piece_id=None):
    rel = path.relative_to(cfg.library_dir).as_posix()
    selected = require_placeholder(conn, piece_id) if piece_id else matching_placeholder(conn, cls.title_default)
    selected_id = selected['id'] if selected else None
    existing = conn.execute(
        "SELECT id, piece_id FROM files WHERE content_hash = ? AND deleted_at IS NULL "
        "AND (? IS NULL OR piece_id = ?) "
        "ORDER BY (filename = ?) DESC LIMIT 1",
        (content_hash, selected_id, selected_id, rel),
    ).fetchone()
    if existing:
        rel = path.relative_to(cfg.library_dir).as_posix()
        conn.execute("UPDATE files SET filename = ? WHERE id = ?", (rel, existing["id"]))
        if piece_id:
            _promote_document(conn, piece_id, now)
        return existing['piece_id']
    piece_id = selected_id or _find_or_create_piece(conn, cls, now)
    rel = path.relative_to(cfg.library_dir).as_posix()
    if cls.media == "pdf":
        info = pdf_meta.read(path)
        page_count = info.page_count
        existing_files_count = conn.execute(
            "SELECT COUNT(*) AS n FROM files "
            "WHERE piece_id = ? AND deleted_at IS NULL",
            (piece_id,),
        ).fetchone()["n"]
        # For flat pieces, the filename is just a placeholder — prefer PDF title/author
        # metadata. For multi-file pieces, the folder name is canonical; only the first
        # ingested file can override title/composer (so a folder with a single PDF still
        # benefits from real metadata, but later files don't clobber an earlier choice).
        allow_pdf_meta_override = not selected and (cls.kind == "flat" or existing_files_count == 0)
        if info.title and allow_pdf_meta_override:
            conn.execute(
                "UPDATE pieces SET title = ?, updated_at = ? "
                "WHERE id = ? AND (title = ? OR title IS NULL)",
                (info.title, now, piece_id, cls.title_default),
            )
        if info.author and allow_pdf_meta_override:
            conn.execute(
                "UPDATE pieces SET composer = ?, updated_at = ? WHERE id = ?",
                (info.author, now, piece_id),
            )
        thumb = cfg.thumbs_dir / f"{piece_id}.png"
        if not thumb.exists():
            pdf_meta.render_thumbnail(path, thumb)
        kind = "pdf"
    elif cls.media == "image":
        page_count = 1
        kind = "image"
    elif cls.media == "chordpro":
        text = path.read_text(encoding="utf-8", errors="replace")
        info = chordpro_meta.parse(text)
        if info.title:
            conn.execute(
                "UPDATE pieces SET title = ?, updated_at = ? WHERE id = ?",
                (info.title, now, piece_id),
            )
        if info.composer:
            conn.execute(
                "UPDATE pieces SET composer = COALESCE(composer, ?), "
                "updated_at = ? WHERE id = ?",
                (info.composer, now, piece_id),
            )
        if info.music_key:
            conn.execute(
                "UPDATE pieces SET music_key = COALESCE(music_key, ?), "
                "updated_at = ? WHERE id = ?",
                (info.music_key, now, piece_id),
            )
        page_count = 1
        kind = "chordpro"
    else:
        return
    ordinal = cls.numeric_prefix or _next_ordinal(conn, piece_id)
    if selected:
        # A placeholder may already carry a reference PDF. The delivered score
        # opens first, while retaining the reference and its file identity.
        ordinal = conn.execute('SELECT COALESCE(MIN(ordinal),1)-1 FROM files '
                               'WHERE piece_id=? AND deleted_at IS NULL', (piece_id,)).fetchone()[0]
    conn.execute(
        "INSERT INTO files "
        "(id, piece_id, kind, filename, page_count, ordinal, "
        "content_hash, bytes, added_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (new_ulid(), piece_id, kind, rel, page_count, ordinal,
         content_hash, bytes_size, now),
    )
    total = conn.execute(
        "SELECT COALESCE(SUM(page_count), 0) AS s FROM files "
        "WHERE piece_id = ? AND deleted_at IS NULL",
        (piece_id,),
    ).fetchone()["s"]
    conn.execute(
        "UPDATE pieces SET page_count = ?, updated_at = ? WHERE id = ?",
        (total, now, piece_id),
    )

    if selected:
        _promote_document(conn, piece_id, now)
    return piece_id


def _promote_document(conn, piece_id, now):
    conn.execute("UPDATE pieces SET is_placeholder=0, kind='pdf', "
                 "placeholder_source_id=COALESCE(chart_source_id,placeholder_source_id), "
                 "chart_source_id=NULL, chart_file=NULL, updated_at=? WHERE id=? AND is_placeholder=1", (now, piece_id))


def _ingest_audio(conn, cfg, path, cls, content_hash, bytes_size, now):
    if cls.kind != "multi":
        return
    rel = path.relative_to(cfg.library_dir).as_posix()
    existing = conn.execute(
        "SELECT id FROM audio_tracks WHERE content_hash = ? AND deleted_at IS NULL "
        "ORDER BY (filename = ?) DESC LIMIT 1",
        (content_hash, rel),
    ).fetchone()
    if existing:
        rel = path.relative_to(cfg.library_dir).as_posix()
        conn.execute("UPDATE audio_tracks SET filename = ? WHERE id = ?",
                     (rel, existing["id"]))
        return
    piece_id = _find_or_create_piece(conn, cls, now)
    info = audio_meta.read(path)
    rel = path.relative_to(cfg.library_dir).as_posix()
    ord_row = conn.execute(
        "SELECT COALESCE(MAX(ordinal), -1) AS m FROM audio_tracks WHERE piece_id = ?",
        (piece_id,),
    ).fetchone()
    ordinal = ord_row["m"] + 1
    conn.execute(
        "INSERT INTO audio_tracks "
        "(id, piece_id, filename, label, duration_ms, content_hash, bytes, "
        "added_at, ordinal) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (new_ulid(), piece_id, rel, path.stem, info.duration_ms,
         content_hash, bytes_size, now, ordinal),
    )


def _ingest_chart(cfg, path: Path, conn: sqlite3.Connection | None = None) -> None:
    """Parse a dropped/authored .saltychart.json and upsert its piece. Malformed or
    invalid files are skipped (never crash the watcher / library scan)."""
    try:
        raw = path.read_bytes()
        chart = json.loads(raw)
    except (OSError, ValueError):
        return
    ok, _ = chart_meta.validate(chart, len(raw))
    if not ok:
        return
    # An idless chart can't be UPSERTed (no identity) — skip it, or a hand-crafted idless
    # drop would insert a piece the keyed upload path would then be unable to dedupe.
    if not chart_meta.chart_id(chart):
        print(f"[ingest_chart] {path.name}: skipped, chart has no id")
        return
    now = int(time.time() * 1000)
    rel = path.relative_to(cfg.library_dir).as_posix()
    owns_conn = conn is None
    if owns_conn:
        conn = dbmod.connect(cfg.db_path)
    try:
        upsert_chart_piece(conn, chart, now, chart_file=rel)
    finally:
        if owns_conn:
            conn.close()


def _chart_updated_at(chart: object) -> int:
    """The client-side content timestamp inside the chart body, 0 when absent/garbage.
    This is the ONLY freshness signal for chart content: pieces.updated_at is
    server-stamped and also moves on Bandstand-side meta edits (play_count, tags),
    so comparing against it would let a metadata touch suppress a legitimate edit."""
    if not isinstance(chart, dict):
        return 0
    try:
        return int(chart.get("updatedAt") or 0)
    except (TypeError, ValueError):
        return 0


def stale_chart_row(conn, chart: dict):
    """The existing piece row when its stored chart content is STRICTLY newer than the
    incoming chart, else None. Callers drop the incoming write silently (it still counts
    as applied): same rationale as the /api/sync annotation guard — a device that syncs
    a week-old offline copy must not clobber newer content, and a rejected op would stay
    queued on that device forever. Incoming charts without an updatedAt keep plain
    last-write-wins (guard never fires)."""
    incoming = _chart_updated_at(chart)
    source_id = str(chart.get("id") or "")
    if not source_id:
        return None
    row = _find_chart_row(conn, source_id)
    if row is None:
        return None
    if row['placeholder_source_id'] == source_id and row['chart_source_id'] != source_id:
        return row  # Retired draft, even if an old editor claims it is newer.
    if not incoming:
        return None
    try:
        stored = json.loads(row["chart_json"]) if row["chart_json"] else None
    except ValueError:
        return None
    return row if _chart_updated_at(stored) > incoming else None


def _find_chart_row(conn, source_id: str):
    """The piece row for a chart id, preferring a live row over tombstones (older DBs
    can hold a dead duplicate from the pre-undelete era)."""
    return conn.execute(
        "SELECT * FROM pieces WHERE chart_source_id = ? OR placeholder_source_id = ? "
        "ORDER BY (deleted_at IS NULL) DESC, updated_at DESC LIMIT 1",
        (source_id, source_id),
    ).fetchone()


def upsert_chart_piece(conn, chart: dict, now: int, chart_file: str | None = None,
                       placeholder_id: str | None = None, match_placeholder: bool = True) -> str:
    """Insert or update the piece row for a chart. Identity is the Saltycharts chart.id
    (chart_source_id): a re-sent chart after an edit replaces its content in place rather
    than duplicating. Title falls back to 'Untitled'; composer comes from chart.artist.
    `chart_file` is the on-disk filename (relative to the library dir) so the watcher can
    soft-delete the piece if the file is later removed. Returns the piece id.

    Tombstoned rows are matched too and revived in place (deleted_at cleared): an upload
    targeting a deleted chart is an intentional undelete (the sync client only re-pushes
    when its copy is newer than the delete), and a file dropped into the library is an
    intentional add. Matching only live rows here used to insert a DUPLICATE row with the
    same chart_source_id after a soft delete. A strictly-newer stored copy wins over the
    incoming one (see stale_chart_row)."""
    source_id = str(chart.get("id") or "")
    title = (chart.get("title") or "").strip() or "Untitled"
    artist = (chart.get("artist") or "").strip() or None
    chart_json = json.dumps(chart, separators=(",", ":"))
    row = None
    if source_id:
        stale = stale_chart_row(conn, chart)
        if stale is not None:
            return stale["id"]
        row = _find_chart_row(conn, source_id)
    if row is None and placeholder_id:
        row = require_placeholder(conn, placeholder_id)
    if row is None and match_placeholder:
        row = matching_placeholder(conn, title, artist)
    if row:
        adopted = row['chart_source_id'] != source_id
        has_music = any(isinstance(section, dict) and section.get('bars') for section in chart.get('sections', []))
        placeholder = int(bool(row['is_placeholder']) and not adopted and not has_music)
        # COALESCE keeps an existing filename when a re-send (e.g. from the endpoint,
        # which passes None) doesn't carry one.
        conn.execute(
            "UPDATE pieces SET title = ?, composer = ?, chart_json = ?, "
            "chart_file = COALESCE(?, chart_file), kind = 'chart', "
            "deleted_at = NULL, updated_at = ?, is_placeholder = ?, "
            "placeholder_source_id = ?, chart_source_id = ? WHERE id = ?",
            (title, artist, chart_json, chart_file, now, placeholder,
             row['chart_source_id'] if adopted else row['placeholder_source_id'], source_id, row["id"]),
        )
        return row["id"]
    piece_id = new_ulid()
    conn.execute(
        "INSERT INTO pieces "
        "(id, title, composer, kind, chart_json, chart_source_id, chart_file, "
        "page_count, added_at, updated_at) "
        "VALUES (?, ?, ?, 'chart', ?, ?, ?, 0, ?, ?)",
        (piece_id, title, artist, chart_json, source_id or None, chart_file, now, now),
    )
    return piece_id
