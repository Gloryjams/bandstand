from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from server import auth, config, db
from server.api import events
from server.ingest import chart_meta, pdf_meta, pipeline
from server.ulid import new_ulid
from server.ingest.folder_convention import AUDIO_EXTS, CHORDPRO_EXTS, IMAGE_EXTS, PDF_EXTS

router = APIRouter()

_ALLOWED_EXTS = PDF_EXTS | IMAGE_EXTS | CHORDPRO_EXTS | AUDIO_EXTS


def _discard_partial_upload(target: Path, made_folder: bool) -> None:
    target.unlink(missing_ok=True)
    if made_folder:
        try:
            target.parent.rmdir()  # only when it is still empty
        except OSError:
            pass


@router.post("/api/upload-piece", dependencies=[Depends(auth.require_key)])
async def upload(file: UploadFile = File(...), piece_id: str | None = Form(default=None)):
    cfg = config.load()
    # The uploaded filename is attacker-controlled: strip any directory components
    # so it cannot escape the library, and only accept known media extensions.
    name = Path(file.filename or "untitled.pdf").name
    if not name or name in (".", ".."):
        raise HTTPException(400, "Invalid filename")
    native = chart_meta.is_chart_file(name)
    if Path(name).suffix.lower() not in _ALLOWED_EXTS and not native:
        raise HTTPException(400, "Unsupported file type")
    if piece_id:
        conn = db.connect(cfg.db_path)
        try:
            pipeline.require_placeholder(conn, piece_id)
        finally:
            conn.close()
        if Path(name).suffix.lower() in AUDIO_EXTS:
            raise HTTPException(400, 'Choose a chart to fill this placeholder')
        if not native:
            name = f'{piece_id}/{new_ulid()}-{name}'
    target = (cfg.library_dir / name).resolve()
    if cfg.library_dir.resolve() not in target.parents:
        raise HTTPException(400, "Invalid filename")
    if target.exists():
        raise HTTPException(409, "A file with this name already exists in the library")
    # Stream with a hard cap: file.read() would buffer an arbitrarily large body in
    # RAM and let anyone with the key fill the disk (the demo instance's key is
    # deliberately public, so treat this as an unauthenticated write).
    max_bytes = cfg.max_upload_mb * 1024 * 1024
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(413, f"File too large (limit {cfg.max_upload_mb} MB)")
        chunks.append(chunk)
    contents = b"".join(chunks)
    if total == 0:
        raise HTTPException(400, "This file is empty, so there is nothing to add.")
    if cfg.library_quota_mb:
        used = sum(f.stat().st_size for f in cfg.library_dir.rglob("*") if f.is_file())
        if used + total > cfg.library_quota_mb * 1024 * 1024:
            raise HTTPException(413, "Library is full")
    if native:
        import json
        from server.api.upload_chart import upload_chart
        try:
            chart = json.loads(contents)
        except ValueError:
            raise HTTPException(400, 'Invalid chart file') from None
        result = upload_chart({'chart': chart, 'placeholder_id': piece_id})
        return {'ok': True, 'piece_id': result['id']}
    # The file is written first and ingested second, inside one transaction. Any
    # failure rolls the rows back and removes the file (and the folder made for a
    # placeholder's chart), so a bad upload leaves the library exactly as it was.
    made_folder = not target.parent.exists()
    conn = db.connect(cfg.db_path)
    try:
        conn.execute('BEGIN IMMEDIATE')
        if piece_id:
            pipeline.require_placeholder(conn, piece_id)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(contents)
        imported_id = pipeline.ingest_path(cfg, target, conn=conn, piece_id=piece_id)
        conn.commit()
    except Exception as exc:
        conn.rollback()
        _discard_partial_upload(target, made_folder)
        if isinstance(exc, pdf_meta.PdfReadError):
            raise HTTPException(
                400, "This file is not a PDF that Bandstand can open, so it was not added."
            ) from exc
        raise
    finally:
        conn.close()
    events.publish('piece_changed', path=str(target))
    if imported_id:
        return {'ok': True, 'piece_id': imported_id}
    conn = db.connect(cfg.db_path)
    try:
        # Look up by stem first; fall back to nominal title (folder convention).
        row = conn.execute(
            "SELECT id FROM pieces WHERE title = ? AND deleted_at IS NULL "
            "ORDER BY added_at DESC LIMIT 1",
            (target.stem,),
        ).fetchone()
        return {"ok": True, "piece_id": row["id"] if row else None}
    finally:
        conn.close()
