import json
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from server import auth, config, db

router = APIRouter()

_ALLOWED = {
    "title", "composer", "music_key", "time_sig", "tempo", "genre",
    "tags", "notes", "preferred_orientation", "default_half_page_turns",
    "last_opened_at", "play_count",
}


@router.put("/api/pieces/{piece_id}", dependencies=[Depends(auth.require_key)])
def upsert_piece(piece_id: str, patch: dict[str, Any]):
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute("SELECT id FROM pieces WHERE id = ?", (piece_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Piece not found")
        sets, params = [], []
        for k, v in patch.items():
            if k not in _ALLOWED:
                continue
            if k == "tags" and isinstance(v, list):
                v = json.dumps(v)
            sets.append(f"{k} = ?")
            params.append(v)
        if not sets:
            return {"ok": True}
        sets.append("updated_at = ?")
        params.append(int(time.time() * 1000))
        params.append(piece_id)
        conn.execute(f"UPDATE pieces SET {', '.join(sets)} WHERE id = ?", params)
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/api/pieces/{piece_id}", dependencies=[Depends(auth.require_key)])
def delete_piece(piece_id: str):
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        now = int(time.time() * 1000)
        conn.execute(
            "UPDATE pieces SET deleted_at = ?, updated_at = ? WHERE id = ?",
            (now, now, piece_id),
        )
        return {"ok": True}
    finally:
        conn.close()
