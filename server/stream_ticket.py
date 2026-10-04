"""Short-lived tickets for the live update stream.

A browser cannot attach a header to the request that opens an event stream, so
`GET /api/events` used to take the key in the address (`?key=...`). Every proxy,
tunnel and access log on the way then records the key. A ticket takes its place:

1. The app asks `POST /api/events/ticket` with its key in the header, as for every
   other request.
2. The server answers with a ticket that lives `TTL_SECONDS` and opens ONE stream.
3. The app opens `GET /api/events?ticket=...`. The ticket is spent on the spot.

A ticket that turns up in a log is worth nothing a minute later, and nothing at all
once its stream has opened.

The old `?key=` address stays for one release, behind `BANDSTAND_EVENTS_KEY_IN_URL`.
Without that setting, an install that already had data before this release keeps
the old address working (its devices may run an app that still uses it), and a new
install refuses it. See `key_in_url_allowed`.

Tickets live in memory. One server process serves one band, and a ticket only has
to survive the second between being issued and being used.
"""
from __future__ import annotations

import hashlib
import secrets
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from server import config, db
from server.members import Identity

TTL_SECONDS = 60
# A ceiling on tickets that were asked for and never used. Far above anything a band
# needs; only there so that a flood of requests cannot grow the store without end.
MAX_OUTSTANDING = 1000

# The settings row that remembers whether this install predates tickets.
_SETTING_DEVICE = "server"
_SETTING_KEY = "events_key_in_url"
ENV_FLAG = "BANDSTAND_EVENTS_KEY_IN_URL"


@dataclass(frozen=True)
class _Entry:
    identity: Identity
    scope: str | None
    expires_at: float


def _digest(ticket: str) -> str:
    return hashlib.sha256(ticket.encode()).hexdigest()


class TicketStore:
    """Issue and redeem single-use tickets. Only a hash of each ticket is kept."""

    def __init__(self, ttl: float = TTL_SECONDS, clock: Callable[[], float] = time.monotonic):
        self._ttl = ttl
        self._clock = clock
        self._entries: dict[str, _Entry] = {}

    @property
    def ttl(self) -> float:
        return self._ttl

    def _prune(self) -> None:
        now = self._clock()
        for key in [k for k, e in self._entries.items() if e.expires_at <= now]:
            del self._entries[key]

    def issue(self, identity: Identity, scope: str | None = None) -> str:
        """A fresh ticket for `identity`. `scope` ties it to one place, such as one
        band behind a front door; `redeem` must name the same scope."""
        self._prune()
        # dict keeps insertion order, so the oldest tickets make room first.
        while len(self._entries) >= MAX_OUTSTANDING:
            del self._entries[next(iter(self._entries))]
        ticket = secrets.token_urlsafe(32)
        self._entries[_digest(ticket)] = _Entry(identity, scope, self._clock() + self._ttl)
        return ticket

    def redeem(self, ticket: str | None, scope: str | None = None) -> Identity | None:
        """The identity a ticket was issued to, once. None for anything unknown,
        spent, expired or issued for another scope."""
        if not ticket:
            return None
        entry = self._entries.pop(_digest(ticket), None)
        if entry is None:
            return None
        if entry.expires_at <= self._clock() or entry.scope != scope:
            return None
        return entry.identity

    def outstanding(self) -> int:
        self._prune()
        return len(self._entries)


# ----------------------------------------------------------------------------
# The old address: the key in the query string.
# ----------------------------------------------------------------------------


def _flag_from_env() -> bool | None:
    # The same parser config.load runs at boot, so a value nobody can read has
    # already stopped the server before any stream is opened.
    return config.events_key_in_url_from_env()


def record_install_age(conn: sqlite3.Connection, *, existing: bool) -> None:
    """Remember, once, whether this data folder predates stream tickets. Called
    from the schema bootstrap, which is where a fresh install is told apart from an
    upgrade. A row that is already there is never changed: the answer belongs to the
    install, not to whichever version happens to boot."""
    row = conn.execute(
        "SELECT value FROM settings WHERE device_id = ? AND key = ?",
        (_SETTING_DEVICE, _SETTING_KEY),
    ).fetchone()
    if row is not None:
        return
    conn.execute(
        "INSERT INTO settings (device_id, key, value, updated_at) VALUES (?, ?, ?, ?)",
        (_SETTING_DEVICE, _SETTING_KEY, "1" if existing else "0", int(time.time())),
    )


def _recorded(conn: sqlite3.Connection) -> bool:
    try:
        row = conn.execute(
            "SELECT value FROM settings WHERE device_id = ? AND key = ?",
            (_SETTING_DEVICE, _SETTING_KEY),
        ).fetchone()
    except sqlite3.Error:
        return False
    return row is not None and row[0] == "1"


def key_in_url_allowed(cfg: config.Config | None = None, *,
                       band_db: Path | None = None) -> bool:
    """May `GET /api/events?key=...` still open the stream?

    `BANDSTAND_EVENTS_KEY_IN_URL=1` says yes and `0` says no. Unset, the answer is the
    one recorded when this data folder first met a server that has tickets: yes for
    a folder that already had data (its devices may still run the old app), no for a
    fresh install. No record at all means no.

    `band_db` is for a door that stands in front of another band's server (the
    public member door): the record read is that band's, and its database is opened
    read-only, because the public process never writes to one."""
    from_env = _flag_from_env()
    if from_env is not None:
        return from_env
    if band_db is not None:
        db_path, open_db = band_db, db.connect_ro
    else:
        cfg = config.load() if cfg is None else cfg
        db_path, open_db = cfg.db_path, db.connect
    if not db_path.exists():
        return False
    try:
        conn = open_db(db_path)
    except sqlite3.Error:
        return False
    try:
        return _recorded(conn)
    finally:
        conn.close()
