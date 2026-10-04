import math
import os
import secrets
import sqlite3
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from server import auth, config, db
from server.ulid import new_ulid

router = APIRouter()

NOT_CONFIGURED = (
    "Share pages are not set up on this server. Whoever runs it can switch them on: "
    'see docs/SELF-HOSTING.md, section "Share links".'
)
# Ten years. Far beyond the UI's longest option (30 days), so this is a guard against a
# malformed body, not a product limit; "until revoked" is ttl_hours=null, not a huge ttl.
_MAX_TTL_HOURS = 10 * 365 * 24
_SQLITE_MAX_INT = 2**63 - 1


def _public_base() -> str | None:
    """Origin the guest phone reaches the public app on, or None when the operator has
    not said. Env-driven so nothing personal is hardcoded in an open-source repo.

    There is no default. The old one was this computer's own loopback address, which
    no guest can open: the app handed out links and QR codes that went nowhere."""
    # Blank counts as unset: a compose file passes the variable through even when the
    # operator left it empty, and an empty base would mint links with no host at all.
    configured = os.environ.get("BANDSTAND_PUBLIC_BASE", "").strip().rstrip("/")
    return configured or None


def _state(row: sqlite3.Row, now: int) -> str:
    if row["revoked_at"] is not None:
        return "revoked"
    if row["expires_at"] is not None and row["expires_at"] <= now:
        return "expired"
    return "active"


def _ttl_to_expiry(ttl_hours: Any, now: int) -> int | None:
    if ttl_hours is None:
        return None
    if isinstance(ttl_hours, bool) or not isinstance(ttl_hours, (int, float)):
        raise HTTPException(400, "ttl_hours must be a number or null")
    # JSON happily carries 1e309, which Python parses as inf; NaN slips past every
    # comparison below (all of them are False) and would only blow up at int(). Both are
    # rejected here so a malformed body is a 400, never a 500.
    if isinstance(ttl_hours, float) and not math.isfinite(ttl_hours):
        raise HTTPException(400, "ttl_hours must be a finite number")
    if ttl_hours <= 0:
        raise HTTPException(400, "ttl_hours must be positive")
    # Compared before any arithmetic, so an enormous int is rejected rather than converted.
    if ttl_hours > _MAX_TTL_HOURS:
        raise HTTPException(400, f"ttl_hours must be at most {_MAX_TTL_HOURS}")
    expires_at = now + int(ttl_hours * 3600 * 1000)
    if expires_at > _SQLITE_MAX_INT:
        raise HTTPException(400, "ttl_hours is too large")
    return expires_at


@router.post("/api/shares", dependencies=[Depends(auth.require_key)])
def create_share(body: dict[str, Any]):
    """Mint a share link for one piece or one setlist.

    Body: {target_kind: 'piece'|'setlist', target_id, ttl_hours: number|null}.
    Returns {id, token, url}. The token is the only credential the guest ever holds, so
    it comes from secrets.token_urlsafe(24) (~192 bits) and is never derived from the id.
    """
    cfg = config.load()
    base = _public_base()
    if base is None:
        # Before anything is written: no share row is left behind for a link that
        # was never handed out.
        raise HTTPException(503, NOT_CONFIGURED)
    target_kind = body.get("target_kind")
    if target_kind not in ("piece", "setlist"):
        raise HTTPException(400, "target_kind must be 'piece' or 'setlist'")
    target_id = str(body.get("target_id") or "").strip()
    if not target_id:
        raise HTTPException(422, "target_id is required")
    now = int(time.time() * 1000)
    expires_at = _ttl_to_expiry(body.get("ttl_hours"), now)

    share_id = new_ulid()
    conn = db.connect(cfg.db_path)
    try:
        # IMMEDIATE so the existence check and the INSERT share one write lock: a target
        # deleted between the two must not leave a share pointing at nothing.
        conn.execute("BEGIN IMMEDIATE")
        try:
            if target_kind == "piece":
                row = conn.execute(
                    "SELECT title FROM pieces WHERE id = ? AND deleted_at IS NULL",
                    (target_id,),
                ).fetchone()
            else:
                # Setlists are hard-deleted; there is no deleted_at column to filter on.
                row = conn.execute(
                    "SELECT name FROM setlists WHERE id = ?", (target_id,)
                ).fetchone()
            if not row:
                raise HTTPException(404, "Share target not found")
            label = (row[0] or "").strip() or "Untitled"
            for attempt in range(2):
                token = secrets.token_urlsafe(24)
                try:
                    conn.execute(
                        "INSERT INTO shares "
                        "(id, token, target_kind, target_id, label, created_at, expires_at, revoked_at) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
                        (share_id, token, target_kind, target_id, label, now, expires_at),
                    )
                    break
                except sqlite3.IntegrityError:
                    # Near-impossible token collision; one retry, then give up rather
                    # than spin.
                    if attempt:
                        raise
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.close()
    return {"id": share_id, "token": token, "url": f"{base}/s/{token}"}


@router.get("/api/shares", dependencies=[Depends(auth.require_key)])
def list_shares():
    cfg = config.load()
    now = int(time.time() * 1000)
    conn = db.connect(cfg.db_path)
    try:
        # Deliberately no `token`, and no `url` built from one: this endpoint answers on
        # every Settings open, and a list response is the last place a live bearer
        # credential should sit. The token is returned exactly once, at creation.
        rows = conn.execute(
            "SELECT id, target_kind, target_id, label, created_at, expires_at, revoked_at "
            "FROM shares ORDER BY created_at DESC, id DESC"
        ).fetchall()
    finally:
        conn.close()
    return [dict(r) | {"state": _state(r, now)} for r in rows]


@router.post("/api/shares/{share_id}/revoke", dependencies=[Depends(auth.require_key)])
def revoke_share(share_id: str):
    cfg = config.load()
    now = int(time.time() * 1000)
    conn = db.connect(cfg.db_path)
    try:
        # Autocommit connection, so this is committed by the time we return: a revoke
        # that is still in flight is not a revoke.
        cur = conn.execute(
            "UPDATE shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
            (now, share_id),
        )
        # rowcount 0 means either "already revoked" (fine, revoking twice is the same
        # outcome) or "no such share", which is the only case worth an error.
        if cur.rowcount == 0 and not conn.execute(
            "SELECT 1 FROM shares WHERE id = ?", (share_id,)
        ).fetchone():
            raise HTTPException(404, "Share not found")
        return {"ok": True}
    finally:
        conn.close()
