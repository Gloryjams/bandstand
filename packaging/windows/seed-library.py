"""Seed only generated practice material in the isolated package staging folder."""
from server import config, db
from server.api.sync import _apply_one

cfg = config.load()
db.bootstrap(cfg)
conn = db.connect(cfg.db_path)
try:
    pieces = conn.execute("SELECT id, title FROM pieces WHERE deleted_at IS NULL").fetchall()
    assert len(pieces) == 4, "Expected exactly four generated practice charts"
    ids = {piece["title"]: piece["id"] for piece in pieces}
    setlist_id = "01KDEMOSETLIST00000000000"
    conn.execute("BEGIN")
    _apply_one(conn, {"op": "upsert", "entity": "setlists", "payload": {"id": setlist_id, "name": "Demo Gig"}})
    _apply_one(conn, {"op": "upsert", "entity": "setlist_items", "payload": {
        "setlist_id": setlist_id,
        "items": [{"id": f"01KDEMOITEM{i:013d}", "kind": "piece", "piece_id": ids[title]}
                  for i, title in enumerate(["Demo Blues in F", "Midnight Ballad", "Groove Etude"], 1)],
    }})
    conn.execute("COMMIT")
    assert conn.execute("SELECT COUNT(*) FROM members").fetchone()[0] == 0
    if conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()[0] != 0:
        raise RuntimeError("Practice book checkpoint was busy; refusing to package it.")
finally:
    conn.close()
for suffix in ("-wal", "-shm"):
    cfg.db_path.with_name(cfg.db_path.name + suffix).unlink(missing_ok=True)
print("Generated practice book: four charts, one setlist, no members.")
