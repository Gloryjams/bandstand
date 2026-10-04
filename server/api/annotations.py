import json
from typing import Any

from fastapi import APIRouter, Depends

from server import auth, config, db

router = APIRouter()


@router.put(
    "/api/annotations/{piece_id}/{file_id}/{page_index}",
    dependencies=[Depends(auth.require_key)],
)
def upsert_annotation(piece_id: str, file_id: str, page_index: int, payload: dict[str, Any]):
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        svg = json.dumps(payload.get("svg_paths", []))
        ts = int(payload.get("updated_at", 0))
        conn.execute(
            "INSERT INTO annotations (piece_id, file_id, page_index, svg_paths, updated_at) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(piece_id, file_id, page_index) "
            "DO UPDATE SET svg_paths = excluded.svg_paths, updated_at = excluded.updated_at",
            (piece_id, file_id, page_index, svg, ts),
        )
        return {"ok": True}
    finally:
        conn.close()


@router.delete(
    "/api/annotations/{piece_id}/{file_id}/{page_index}",
    dependencies=[Depends(auth.require_key)],
)
def delete_annotation(piece_id: str, file_id: str, page_index: int):
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        conn.execute(
            "DELETE FROM annotations WHERE piece_id = ? AND file_id = ? AND page_index = ?",
            (piece_id, file_id, page_index),
        )
        return {"ok": True}
    finally:
        conn.close()
