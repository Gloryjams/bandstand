from typing import Any

from fastapi import APIRouter, Depends

from server import auth, config, db

router = APIRouter()

_ALLOWED = {
    "piece_id", "from_file_id", "from_page_index",
    "to_bookmark_id", "initial_triggers", "active",
}


@router.put("/api/section-links/{link_id}", dependencies=[Depends(auth.require_key)])
def upsert_section_link(link_id: str, payload: dict[str, Any]):
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute(
            "SELECT id FROM section_links WHERE id = ?", (link_id,)
        ).fetchone()
        if row:
            sets, params = [], []
            for k, v in payload.items():
                if k not in _ALLOWED:
                    continue
                sets.append(f"{k} = ?")
                params.append(v)
            if sets:
                params.append(link_id)
                conn.execute(
                    f"UPDATE section_links SET {', '.join(sets)} WHERE id = ?", params
                )
            return {"ok": True}
        cols = ["id"]
        vals = [link_id]
        for k in ("piece_id", "from_file_id", "from_page_index",
                  "to_bookmark_id", "initial_triggers", "active"):
            if k in payload:
                cols.append(k)
                vals.append(payload[k])
        placeholders = ",".join(["?"] * len(cols))
        conn.execute(
            f"INSERT INTO section_links ({', '.join(cols)}) VALUES ({placeholders})",
            vals,
        )
        return {"ok": True}
    finally:
        conn.close()


@router.delete("/api/section-links/{link_id}", dependencies=[Depends(auth.require_key)])
def delete_section_link(link_id: str):
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        conn.execute("DELETE FROM section_links WHERE id = ?", (link_id,))
        return {"ok": True}
    finally:
        conn.close()
