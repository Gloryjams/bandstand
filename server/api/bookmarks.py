from typing import Any

from fastapi import APIRouter, Depends

from server import auth, config, db

router = APIRouter()

_ALLOWED = {"piece_id", "file_id", "page_index", "label", "ordinal"}


@router.put("/api/bookmarks/{bookmark_id}", dependencies=[Depends(auth.require_key)])
def upsert_bookmark(bookmark_id: str, payload: dict[str, Any]):
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute(
            "SELECT id FROM bookmarks WHERE id = ?", (bookmark_id,)
        ).fetchone()
        if row:
            sets, params = [], []
            for k, v in payload.items():
                if k not in _ALLOWED:
                    continue
                sets.append(f"{k} = ?")
                params.append(v)
            if sets:
                params.append(bookmark_id)
                conn.execute(
                    f"UPDATE bookmarks SET {', '.join(sets)} WHERE id = ?", params
                )
            return {"ok": True}
        # Insert new
        cols = ["id"]
        vals = [bookmark_id]
        for k in ("piece_id", "file_id", "page_index", "label", "ordinal"):
            cols.append(k)
            vals.append(payload.get(k))
        placeholders = ",".join(["?"] * len(cols))
        conn.execute(
            f"INSERT INTO bookmarks ({', '.join(cols)}) VALUES ({placeholders})",
            vals,
        )
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/api/bookmarks/{bookmark_id}", dependencies=[Depends(auth.require_key)])
def delete_bookmark(bookmark_id: str):
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        conn.execute("DELETE FROM bookmarks WHERE id = ?", (bookmark_id,))
        return {"ok": True}
    finally:
        conn.close()
