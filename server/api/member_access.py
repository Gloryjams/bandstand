"""Enabled member reads and own-note writes. Never uses a director key.

The live update stream is the one place a browser cannot send the key header, so it
gets the same ticket the band's own server hands out (server/stream_ticket.py):

1. `POST /bands/<band>/api/events/ticket` with the member key in the header. The
   door checks the key against the band's membership, as for every read, and passes
   the request on with that key. The band's server issues the ticket, to that member.
2. `GET /bands/<band>/api/events?ticket=...` goes on to the band with the ticket in
   the address and no credential header at all. The band redeems it: one minute,
   one stream. The door has nothing to check, and nothing lasting is in the address.

The old `?key=` address is gated here by the same rule as everywhere else
(`stream_ticket.key_in_url_allowed`, read from the band's own record), so a fresh
install refuses it at this door too.
"""
import re
import sqlite3
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from server import db, members, stream_ticket
from server.api.events import OLD_ADDRESS_REFUSED, TICKET_REFUSED
from server.api.workspaces import _directory, _forward

router = APIRouter()
_READ = re.compile(r'(?:health|whoami|manifest|my-notes|events|thumb/[A-Za-z0-9_-]+|(?:file|audio)/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+)')
_OWN_NOTE = re.compile(r'my-notes/[A-Za-z0-9_-]{1,100}')
# The one POST a member may make. It writes nothing: the band's server answers it
# with a one-minute ticket for the stream (see the module docstring).
_TICKET = 'events/ticket'


def enabled_rows():
    try:
        return [r for r in _directory() if r.get('member_url')]
    except HTTPException:
        return []


def _band_db(row: dict) -> Path:
    return Path(row['key_file']).parent / 'library.db'


@router.api_route('/bands/{workspace}/api/{path:path}', methods=['GET', 'HEAD', 'PUT', 'POST'])
async def member_read(workspace: str, path: str, request: Request):
    row = next((r for r in enabled_rows() if r['id'] == workspace), None)
    refused_sync = request.method == 'POST' and path == 'sync'
    allowed = refused_sync or (_OWN_NOTE.fullmatch(path) if request.method == 'PUT'
                              else _READ.fullmatch(path) if request.method in {'GET', 'HEAD'}
                              else path == _TICKET if request.method == 'POST' else False)
    if not row or not allowed:
        raise HTTPException(404, 'Not found')
    key = request.headers.get('X-Bandstand-Key')
    if not key and path == 'events':
        # The stream: a ticket goes on as it is (the band checks it), the old
        # address only while the band's record allows it.
        ticket = request.query_params.get('ticket')
        if ticket is not None:
            if not ticket or len(ticket) > 256:
                raise HTTPException(401, TICKET_REFUSED)
            return await _forward(workspace, path, request, ticket=ticket)
        key = request.query_params.get('key')
        if key and not stream_ticket.key_in_url_allowed(band_db=_band_db(row)):
            raise HTTPException(401, OLD_ADDRESS_REFUSED)
    if not key or len(key) > 256:
        raise HTTPException(401, 'Member sign-in required')
    # This reads only the band's membership DB. Even a valid director credential
    # cannot enter here; public clients never gain cross-band account access.
    try:
        conn = db.connect_ro(_band_db(row))
        try:
            ident = members.find_by_key(conn, key)
        finally:
            conn.close()
    except sqlite3.Error:
        raise HTTPException(503, 'Band temporarily unavailable') from None
    if ident is None or ident.role != 'member':
        raise HTTPException(403, 'Member sign-in required')
    if refused_sync:
        # Older readers queued open-count updates during cold-start identity lookup.
        # A definite role refusal lets their existing queue recover. Never forward it.
        raise HTTPException(403, 'Director key required')
    return await _forward(workspace, path, request, member_key=key)


@router.get('/app')
@router.get('/app/')
@router.get('/app/{path:path}')
def member_app(path: str = ''):
    if not enabled_rows():
        raise HTTPException(404, 'Not found')
    root = (Path(__file__).parent.parent / 'static' / 'app').resolve()
    target = (root / path).resolve()
    if root not in target.parents or not target.is_file():
        if '.' in path.rsplit('/', 1)[-1]:
            raise HTTPException(404, 'Not found')
        target = root / 'index.html'
    if not target.is_file():
        raise HTTPException(404, 'Not found')
    return FileResponse(target, headers={'Cache-Control': 'no-cache'})
