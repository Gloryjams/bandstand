import re
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse

from server import auth, config, db

router = APIRouter()

_RANGE = re.compile(r"bytes=(\d+)-(\d*)")
_ULID = re.compile(r"[0-9A-HJKMNP-TV-Z]{26}")  # Crockford base32, for path-param safety


def _content_type(suffix: str) -> str:
    s = suffix.lower()
    return {
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".cho": "text/plain",
        ".chordpro": "text/plain",
        ".crd": "text/plain",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".m4a": "audio/mp4",
        ".flac": "audio/flac",
    }.get(s, "application/octet-stream")


def _stream_with_range(path: Path, range_header: str | None) -> Response:
    file_size = path.stat().st_size
    ctype = _content_type(path.suffix)
    if range_header is None:
        return FileResponse(path, media_type=ctype, headers={"Accept-Ranges": "bytes"})
    m = _RANGE.match(range_header)
    if not m:
        return FileResponse(path, media_type=ctype)
    start = int(m.group(1))
    end = int(m.group(2)) if m.group(2) else file_size - 1
    end = min(end, file_size - 1)
    if start > end:
        raise HTTPException(416, "Range not satisfiable")
    length = end - start + 1

    def gen():
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    return StreamingResponse(
        gen(),
        status_code=206,
        media_type=ctype,
        headers={
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(length),
        },
    )


@router.get("/api/file/{piece_id}/{file_id}", dependencies=[Depends(auth.require_identity)])
def get_file(piece_id: str, file_id: str, range: str | None = Header(default=None)):
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute(
            "SELECT filename FROM files WHERE id = ? AND piece_id = ? AND deleted_at IS NULL",
            (file_id, piece_id),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(404, "Not found")
    path = cfg.library_dir / row["filename"]
    if not path.exists():
        raise HTTPException(404, "File missing on disk")
    return _stream_with_range(path, range)


@router.get("/api/audio/{piece_id}/{track_id}", dependencies=[Depends(auth.require_identity)])
def get_audio(piece_id: str, track_id: str, range: str | None = Header(default=None)):
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute(
            "SELECT filename FROM audio_tracks WHERE id = ? AND piece_id = ? AND deleted_at IS NULL",
            (track_id, piece_id),
        ).fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(404, "Not found")
    path = cfg.library_dir / row["filename"]
    if not path.exists():
        raise HTTPException(404, "File missing on disk")
    return _stream_with_range(path, range)


@router.get("/api/thumb/{piece_id}", dependencies=[Depends(auth.require_identity)])
def get_thumb(piece_id: str):
    cfg = config.load()
    # piece_id is interpolated into a path; require a real ULID so it can't be
    # used to reach outside the thumbs dir (defense-in-depth).
    if not _ULID.fullmatch(piece_id):
        raise HTTPException(404, "No thumbnail")
    thumb = cfg.thumbs_dir / f"{piece_id}.png"
    if not thumb.exists():
        raise HTTPException(404, "No thumbnail")
    return FileResponse(thumb, media_type="image/png")
