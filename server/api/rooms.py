"""Private rehearsal rooms: director-curated queue plus QR guest participation.

The workspace server remains authoritative. Guest and participant secrets are stored
as SHA-256 hashes and are intentionally separate from Bandstand member credentials.

A room is a public surface: the QR code on the wall is the whole credential, and
anyone who can photograph it can join. So the feature is OFF until the operator sets
BANDSTAND_ROOMS=1 (every route here, guest and director alike, answers 404 while it
is off), and when on it is bounded: BANDSTAND_ROOMS_MAX_OPEN rooms at once,
BANDSTAND_ROOMS_MAX_GUESTS guests in a room, BANDSTAND_ROOMS_PROPOSALS_PER_MINUTE
songs per guest and BANDSTAND_ROOMS_PARTICIPATION_PER_MINUTE votes and volunteers
per guest. Each room takes at most 200 proposals, and each guest can volunteer for
at most 4 instruments on one proposal. The director can remove proposals and close
the room while it is open.
"""

import hashlib
import hmac
import re
import secrets
import time
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, status

from server import auth, config, db
from server.api import events
from server.ulid import new_ulid

ROOMS_OFF_MESSAGE = "Rehearsal rooms are switched off on this server"
MAX_PROPOSALS_PER_ROOM = 200
MAX_VOLUNTEERS_PER_PARTICIPANT = 4


def require_rooms_on() -> None:
    """Every rooms route, guest or director, is behind this. 404 rather than 403: a
    switched-off feature is not there, and a guest holding an old QR code learns
    nothing about the server from the answer."""
    if not config.load().rooms_enabled:
        raise HTTPException(status.HTTP_404_NOT_FOUND, ROOMS_OFF_MESSAGE)


router = APIRouter(dependencies=[Depends(require_rooms_on)])


def _now() -> int:
    return int(time.time() * 1000)


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _clean(value: Any, field: str, limit: int = 120) -> str:
    text = str(value or "").strip()
    if not text:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"{field} is required")
    if len(text) > limit:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, f"{field} is too long")
    return text


def _room_for_guest(conn, room_id: str, token: str | None):
    row = conn.execute("SELECT * FROM rehearsal_rooms WHERE id = ?", (room_id,)).fetchone()
    if row is None or not token or not hmac.compare_digest(row["join_token_hash"], _hash(token)):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid room link")
    if row["state"] != "open":
        raise HTTPException(status.HTTP_410_GONE, "This room is closed")
    if row["join_expires_at"] <= _now():
        raise HTTPException(status.HTTP_410_GONE, "This room link has expired")
    return row


def _participant_for_guest(conn, room_id: str, token: str | None):
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Participant credential required")
    if len(token) > 128:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Your guest sign-in token is too long")
    row = conn.execute(
        "SELECT * FROM room_participants WHERE room_id = ? AND credential_hash = ? "
        "AND left_at IS NULL",
        (room_id, _hash(token)),
    ).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid participant credential")
    return row


def _open_room_for_director(conn, room_id: str):
    row = conn.execute("SELECT * FROM rehearsal_rooms WHERE id = ?", (room_id,)).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Room not found")
    if row["state"] != "open":
        raise HTTPException(status.HTTP_409_CONFLICT, "This room is closed")
    if row["join_expires_at"] <= _now():
        raise HTTPException(status.HTTP_409_CONFLICT, "This room has expired")
    return row


def _touch(conn, room_id: str, *, queue: bool = False) -> int:
    now = _now()
    queue_sql = ", queue_revision = queue_revision + 1" if queue else ""
    conn.execute(
        f"UPDATE rehearsal_rooms SET revision = revision + 1{queue_sql}, updated_at = ? WHERE id = ?",
        (now, room_id),
    )
    return conn.execute(
        "SELECT revision FROM rehearsal_rooms WHERE id = ?", (room_id,)
    ).fetchone()[0]


def _state(conn, room_id: str) -> dict[str, Any]:
    room = conn.execute(
        "SELECT id, title, state, revision, queue_revision, created_at, updated_at, closed_at "
        "FROM rehearsal_rooms WHERE id = ?",
        (room_id,),
    ).fetchone()
    if room is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Room not found")
    participants = [dict(r) for r in conn.execute(
        "SELECT id, display_name, instrument, joined_at FROM room_participants "
        "WHERE room_id = ? AND left_at IS NULL ORDER BY joined_at, id",
        (room_id,),
    )]
    proposals = [dict(r) for r in conn.execute(
        "SELECT p.id, p.participant_id, owner.display_name AS proposed_by, p.title, "
        "p.music_key, p.piece_id, p.sharing_scope, p.state, p.created_at, p.updated_at, "
        "SUM(CASE WHEN v.kind = 'play' THEN 1 ELSE 0 END) AS play_votes, "
        "SUM(CASE WHEN v.kind = 'hear' THEN 1 ELSE 0 END) AS hear_votes "
        "FROM room_proposals p JOIN room_participants owner ON owner.id = p.participant_id "
        "LEFT JOIN room_votes v ON v.proposal_id = p.id "
        "WHERE p.room_id = ? AND p.state != 'withdrawn' GROUP BY p.id "
        "ORDER BY p.created_at, p.id",
        (room_id,),
    )]
    for proposal in proposals:
        proposal["play_votes"] = int(proposal["play_votes"] or 0)
        proposal["hear_votes"] = int(proposal["hear_votes"] or 0)
        proposal["volunteers"] = [dict(r) for r in conn.execute(
            "SELECT v.participant_id, p.display_name, v.instrument "
            "FROM room_volunteers v JOIN room_participants p ON p.id = v.participant_id "
            "WHERE v.proposal_id = ? AND p.left_at IS NULL "
            "ORDER BY v.created_at, v.participant_id, v.instrument",
            (proposal["id"],),
        )]
    queue = [dict(r) for r in conn.execute(
        "SELECT id, proposal_id, title, music_key, state, ordinal, created_at, updated_at "
        "FROM room_queue_entries WHERE room_id = ? ORDER BY ordinal, id",
        (room_id,),
    )]
    return {"room": dict(room), "participants": participants, "proposals": proposals, "queue": queue}


def _publish(room_id: str) -> None:
    events.publish("room_changed", room_id=room_id)


@router.post("/api/rooms", dependencies=[Depends(auth.require_director)])
def create_room(body: dict[str, Any]):
    cfg = config.load()
    room_id = new_ulid()
    token = secrets.token_hex(32)
    title = _clean(body.get("title"), "title")
    conn = db.connect(cfg.db_path)
    try:
        # BEGIN IMMEDIATE takes the write lock, so the count and the insert are one
        # step: two directors opening rooms at once cannot both slip under the cap.
        conn.execute("BEGIN IMMEDIATE")
        now = _now()
        open_rooms = conn.execute(
            "SELECT COUNT(*) FROM rehearsal_rooms WHERE state = 'open' AND join_expires_at > ?",
            (now,),
        ).fetchone()[0]
        if open_rooms >= cfg.rooms_max_open:
            conn.execute("ROLLBACK")
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Close the open room first" if cfg.rooms_max_open == 1
                else f"This server allows {cfg.rooms_max_open} open rooms. Close one first",
            )
        conn.execute(
            "INSERT INTO rehearsal_rooms "
            "(id, title, state, join_token_hash, join_expires_at, revision, queue_revision, created_at, updated_at) "
            "VALUES (?, ?, 'open', ?, ?, 0, 0, ?, ?)",
            (room_id, title, _hash(token), now + 12 * 60 * 60 * 1000, now, now),
        )
        conn.execute("COMMIT")
    finally:
        conn.close()
    _publish(room_id)
    return {"id": room_id, "join_token": token, "state": "open", "revision": 0}


@router.get("/api/rooms/active", dependencies=[Depends(auth.require_identity)])
def active_room():
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute(
            "SELECT id FROM rehearsal_rooms WHERE state = 'open' AND join_expires_at > ? "
            "ORDER BY created_at DESC LIMIT 1",
            (_now(),),
        ).fetchone()
        return _state(conn, row["id"]) if row else None
    finally:
        conn.close()


@router.get("/api/rooms/{room_id}", dependencies=[Depends(auth.require_identity)])
def director_room(room_id: str):
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        return _state(conn, room_id)
    finally:
        conn.close()


@router.post("/api/rooms/{room_id}/close", dependencies=[Depends(auth.require_director)])
def close_room(room_id: str):
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        now = _now()
        changed = conn.execute(
            "UPDATE rehearsal_rooms SET state = 'closed', closed_at = ?, updated_at = ?, "
            "revision = revision + 1 WHERE id = ? AND state = 'open'",
            (now, now, room_id),
        ).rowcount
        if not changed:
            conn.execute("ROLLBACK")
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Open room not found")
        conn.execute("COMMIT")
    finally:
        conn.close()
    _publish(room_id)
    return {"ok": True}


@router.post("/api/rooms/{room_id}/queue", dependencies=[Depends(auth.require_director)])
def promote_proposal(room_id: str, body: dict[str, Any]):
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        _open_room_for_director(conn, room_id)
        proposal = conn.execute(
            "SELECT * FROM room_proposals WHERE id = ? AND room_id = ? AND state = 'open'",
            (body.get("proposal_id"), room_id),
        ).fetchone()
        if proposal is None:
            conn.execute("ROLLBACK")
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Open proposal not found")
        ordinal = conn.execute(
            "SELECT COALESCE(MAX(ordinal), -1) + 1 FROM room_queue_entries WHERE room_id = ?",
            (room_id,),
        ).fetchone()[0]
        now = _now()
        entry_id = new_ulid()
        conn.execute(
            "INSERT INTO room_queue_entries "
            "(id, room_id, proposal_id, title, music_key, state, ordinal, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)",
            (entry_id, room_id, proposal["id"], proposal["title"], proposal["music_key"], ordinal, now, now),
        )
        conn.execute(
            "UPDATE room_proposals SET state = 'queued', updated_at = ? WHERE id = ?",
            (now, proposal["id"]),
        )
        revision = _touch(conn, room_id, queue=True)
        conn.execute("COMMIT")
    finally:
        conn.close()
    _publish(room_id)
    return {"id": entry_id, "revision": revision}


@router.delete("/api/rooms/{room_id}/proposals/{proposal_id}", dependencies=[Depends(auth.require_director)])
def remove_proposal(room_id: str, proposal_id: str):
    """The director takes a song off every screen: the pool, and the queue if it
    was already promoted. The row stays (state 'withdrawn') so the guest's
    per-minute count still sees it."""
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        _open_room_for_director(conn, room_id)
        changed = conn.execute(
            "UPDATE room_proposals SET state = 'withdrawn', updated_at = ? "
            "WHERE id = ? AND room_id = ? AND state != 'withdrawn'",
            (_now(), proposal_id, room_id),
        ).rowcount
        if not changed:
            conn.execute("ROLLBACK")
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Proposal not found")
        dequeued = conn.execute(
            "DELETE FROM room_queue_entries WHERE room_id = ? AND proposal_id = ?",
            (room_id, proposal_id),
        ).rowcount
        revision = _touch(conn, room_id, queue=bool(dequeued))
        conn.execute("COMMIT")
    finally:
        conn.close()
    _publish(room_id)
    return {"ok": True, "revision": revision}


@router.put("/api/rooms/{room_id}/queue/order", dependencies=[Depends(auth.require_director)])
def reorder_queue(room_id: str, body: dict[str, Any]):
    cfg = config.load()
    entry_ids = body.get("entry_ids") or []
    conn = db.connect(cfg.db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        room = _open_room_for_director(conn, room_id)
        queue_revision = room["queue_revision"]
        if int(body.get("expected_revision", -1)) != queue_revision:
            conn.execute("ROLLBACK")
            raise HTTPException(status.HTTP_409_CONFLICT, "Room changed; refresh before reordering")
        existing = [r[0] for r in conn.execute(
            "SELECT id FROM room_queue_entries WHERE room_id = ? ORDER BY ordinal, id", (room_id,)
        )]
        if len(entry_ids) != len(existing) or set(entry_ids) != set(existing):
            conn.execute("ROLLBACK")
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Queue order is incomplete")
        now = _now()
        for ordinal, entry_id in enumerate(entry_ids):
            conn.execute(
                "UPDATE room_queue_entries SET ordinal = ? WHERE id = ? AND room_id = ?",
                (-ordinal - 1, entry_id, room_id),
            )
        for ordinal, entry_id in enumerate(entry_ids):
            conn.execute(
                "UPDATE room_queue_entries SET ordinal = ?, updated_at = ? "
                "WHERE id = ? AND room_id = ?",
                (ordinal, now, entry_id, room_id),
            )
        revision = _touch(conn, room_id, queue=True)
        conn.execute("COMMIT")
    finally:
        conn.close()
    _publish(room_id)
    return {"ok": True, "revision": revision}


@router.post("/api/rooms/{room_id}/queue/{entry_id}/current", dependencies=[Depends(auth.require_director)])
def make_current(room_id: str, entry_id: str):
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        _open_room_for_director(conn, room_id)
        target = conn.execute(
            "SELECT id FROM room_queue_entries WHERE id = ? AND room_id = ?", (entry_id, room_id)
        ).fetchone()
        if target is None:
            conn.execute("ROLLBACK")
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Queue entry not found")
        now = _now()
        conn.execute(
            "UPDATE room_queue_entries SET state = 'played', updated_at = ? "
            "WHERE room_id = ? AND state = 'current' AND id != ?",
            (now, room_id, entry_id),
        )
        conn.execute(
            "UPDATE room_queue_entries SET state = 'current', updated_at = ? WHERE id = ?",
            (now, entry_id),
        )
        revision = _touch(conn, room_id, queue=True)
        conn.execute("COMMIT")
    finally:
        conn.close()
    _publish(room_id)
    return {"ok": True, "revision": revision}


@router.get("/room-api/{room_id}")
def guest_room(room_id: str, x_bandstand_room: str | None = Header(default=None)):
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        _room_for_guest(conn, room_id, x_bandstand_room)
        return _state(conn, room_id)
    finally:
        conn.close()


@router.post("/room-api/{room_id}/join")
def join_room(room_id: str, body: dict[str, Any], x_bandstand_room: str | None = Header(default=None)):
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    token = str(body.get("participant_token") or "")
    participant_id = str(body.get("participant_id") or "")
    try:
        conn.execute("BEGIN IMMEDIATE")
        _room_for_guest(conn, room_id, x_bandstand_room)
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", participant_id):
            conn.execute("ROLLBACK")
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Your guest ID must be 1 to 64 letters, numbers, underscores or hyphens",
            )
        if not 32 <= len(token) <= 128:
            conn.execute("ROLLBACK")
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Your guest sign-in token must be 32 to 128 characters",
            )
        existing = conn.execute(
            "SELECT * FROM room_participants WHERE id = ?", (participant_id,)
        ).fetchone()
        if existing is not None:
            if existing["room_id"] != room_id or not hmac.compare_digest(
                existing["credential_hash"], _hash(token)
            ):
                conn.execute("ROLLBACK")
                raise HTTPException(status.HTTP_409_CONFLICT, "Participant id already exists")
        else:
            # A guest id is chosen by the phone, so the per-guest song limit only
            # holds if joining is bounded too. Counted inside the write lock.
            guests = conn.execute(
                "SELECT COUNT(*) FROM room_participants WHERE room_id = ?", (room_id,)
            ).fetchone()[0]
            if guests >= cfg.rooms_max_guests:
                conn.execute("ROLLBACK")
                raise HTTPException(status.HTTP_409_CONFLICT, "This room is full")
            now = _now()
            conn.execute(
                "INSERT INTO room_participants "
                "(id, room_id, display_name, instrument, credential_hash, joined_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (participant_id, room_id, _clean(body.get("display_name"), "display name", 60),
                 _clean(body.get("instrument"), "instrument", 60), _hash(token), now),
            )
            _touch(conn, room_id)
        conn.execute("COMMIT")
        participant = conn.execute(
            "SELECT id, display_name, instrument, joined_at FROM room_participants WHERE id = ?",
            (participant_id,),
        ).fetchone()
    finally:
        conn.close()
    _publish(room_id)
    return {"participant": dict(participant), "participant_token": token}


@router.post("/room-api/{room_id}/proposals")
def propose_song(
    room_id: str, body: dict[str, Any],
    x_bandstand_room: str | None = Header(default=None),
    x_bandstand_participant: str | None = Header(default=None),
):
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    proposal_id = new_ulid()
    try:
        conn.execute("BEGIN IMMEDIATE")
        _room_for_guest(conn, room_id, x_bandstand_room)
        participant = _participant_for_guest(conn, room_id, x_bandstand_participant)
        now = _now()
        scope = body.get("sharing_scope", "session")
        if scope not in {"session", "save_allowed"}:
            conn.execute("ROLLBACK")
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Invalid sharing scope")
        music_key = str(body.get("music_key") or "").strip()
        music_key = _clean(music_key, "music key", 16) if music_key else None
        piece_id = body.get("piece_id")
        if piece_id is not None and (
            not isinstance(piece_id, str) or conn.execute(
                "SELECT id FROM pieces WHERE id = ? AND deleted_at IS NULL", (piece_id,)
            ).fetchone() is None
        ):
            conn.execute("ROLLBACK")
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "That song is not in the library")
        # All proposals count, including queued and withdrawn rows. Removing a
        # song must not let a guest grow the database past the room's allowance.
        proposals = conn.execute(
            "SELECT COUNT(*) FROM room_proposals WHERE room_id = ?", (room_id,)
        ).fetchone()[0]
        if proposals >= MAX_PROPOSALS_PER_ROOM:
            conn.execute("ROLLBACK")
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"This room already has {MAX_PROPOSALS_PER_ROOM} songs. Start a new room for more",
            )
        # Counted from the table itself, withdrawn ones included, so a removed
        # proposal does not hand the guest a fresh allowance.
        per_minute = cfg.rooms_proposals_per_minute
        if per_minute:
            recent = conn.execute(
                "SELECT COUNT(*) FROM room_proposals "
                "WHERE participant_id = ? AND created_at > ?",
                (participant["id"], now - 60 * 1000),
            ).fetchone()[0]
            if recent >= per_minute:
                conn.execute("ROLLBACK")
                raise HTTPException(
                    status.HTTP_429_TOO_MANY_REQUESTS,
                    f"You can post {per_minute} songs a minute. Try again in a moment",
                )
        conn.execute(
            "INSERT INTO room_proposals "
            "(id, room_id, participant_id, title, music_key, piece_id, sharing_scope, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (proposal_id, room_id, participant["id"], _clean(body.get("title"), "title"),
             music_key, piece_id, scope, now, now),
        )
        revision = _touch(conn, room_id)
        conn.execute("COMMIT")
    finally:
        conn.close()
    _publish(room_id)
    return {"id": proposal_id, "revision": revision}


def _proposal_participation(
    room_id: str, proposal_id: str, instrument: str | None,
    room_token: str | None, participant_token: str | None, kind: str,
):
    cfg = config.load()
    conn = db.connect(cfg.db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        room = _room_for_guest(conn, room_id, room_token)
        participant = _participant_for_guest(conn, room_id, participant_token)
        proposal = conn.execute(
            "SELECT id FROM room_proposals WHERE id = ? AND room_id = ? AND state != 'withdrawn'",
            (proposal_id, room_id),
        ).fetchone()
        if proposal is None:
            conn.execute("ROLLBACK")
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Proposal not found")
        now = _now()
        if kind in {"play", "hear"}:
            existing = conn.execute(
                "SELECT 1 FROM room_votes WHERE proposal_id = ? AND participant_id = ? AND kind = ?",
                (proposal_id, participant["id"], kind),
            ).fetchone()
        else:
            instrument = _clean(instrument, "instrument", 60)
            instrument_key = instrument.casefold()
            existing = conn.execute(
                "SELECT 1 FROM room_volunteers "
                "WHERE proposal_id = ? AND participant_id = ? AND instrument_key = ?",
                (proposal_id, participant["id"], instrument_key),
            ).fetchone()
        if existing is not None:
            # A retry makes no new row and sends no event that could make every
            # guest refetch the room. It remains safe even at either allowance.
            conn.execute("COMMIT")
            return {"ok": True, "revision": room["revision"]}
        if kind == "volunteer":
            volunteers = conn.execute(
                "SELECT COUNT(*) FROM room_volunteers WHERE proposal_id = ? AND participant_id = ?",
                (proposal_id, participant["id"]),
            ).fetchone()[0]
            if volunteers >= MAX_VOLUNTEERS_PER_PARTICIPANT:
                conn.execute("ROLLBACK")
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    f"You can volunteer for at most {MAX_VOLUNTEERS_PER_PARTICIPANT} instruments on one song",
                )
        # One allowance for both kinds of participation, counted under the write
        # lock. Votes and volunteers on withdrawn proposals still count too.
        per_minute = cfg.rooms_participation_per_minute
        if per_minute:
            cutoff = now - 60 * 1000
            recent = conn.execute(
                "SELECT (SELECT COUNT(*) FROM room_votes WHERE participant_id = ? AND created_at > ?) "
                "+ (SELECT COUNT(*) FROM room_volunteers WHERE participant_id = ? AND created_at > ?)",
                (participant["id"], cutoff, participant["id"], cutoff),
            ).fetchone()[0]
            if recent >= per_minute:
                conn.execute("ROLLBACK")
                raise HTTPException(
                    status.HTTP_429_TOO_MANY_REQUESTS,
                    f"You can vote or volunteer {per_minute} times a minute. Try again in a moment",
                )
        if kind in {"play", "hear"}:
            conn.execute(
                "INSERT INTO room_votes "
                "(room_id, proposal_id, participant_id, kind, created_at) VALUES (?, ?, ?, ?, ?)",
                (room_id, proposal_id, participant["id"], kind, now),
            )
        else:
            conn.execute(
                "INSERT INTO room_volunteers "
                "(room_id, proposal_id, participant_id, instrument_key, instrument, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (room_id, proposal_id, participant["id"], instrument_key, instrument, now),
            )
        revision = _touch(conn, room_id)
        conn.execute("COMMIT")
    finally:
        conn.close()
    _publish(room_id)
    return {"ok": True, "revision": revision}


@router.put("/room-api/{room_id}/proposals/{proposal_id}/votes/{kind}")
def vote(
    room_id: str, proposal_id: str, kind: str,
    x_bandstand_room: str | None = Header(default=None),
    x_bandstand_participant: str | None = Header(default=None),
):
    if kind not in {"play", "hear"}:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Invalid vote")
    return _proposal_participation(
        room_id, proposal_id, None, x_bandstand_room, x_bandstand_participant, kind
    )


@router.put("/room-api/{room_id}/proposals/{proposal_id}/volunteers/{instrument}")
def volunteer(
    room_id: str, proposal_id: str, instrument: str,
    x_bandstand_room: str | None = Header(default=None),
    x_bandstand_participant: str | None = Header(default=None),
):
    return _proposal_participation(
        room_id, proposal_id, instrument, x_bandstand_room, x_bandstand_participant, "volunteer"
    )
