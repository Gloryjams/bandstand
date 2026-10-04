import asyncio
import json
from typing import AsyncIterator

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse

from server import auth, stream_ticket
from server.members import Identity

router = APIRouter()

# One store per process: one process is one band.
TICKETS = stream_ticket.TicketStore()

# Said the same way at every door.
OLD_ADDRESS_REFUSED = (
    "The live update stream no longer takes the key in the address. "
    "Ask for a ticket first (POST /api/events/ticket)."
)
TICKET_REFUSED = "Stream ticket is unknown, used or expired"

# Each subscriber carries the client id of the device that opened the stream, so a
# device-originated change (publish with exclude_client=that id) is NOT echoed back
# to the device that made it — only to the others.
_subscribers: list[tuple[str | None, asyncio.Queue]] = []

# The event loop that owns every subscriber queue. publish() is called from worker
# threads (the watchdog observer; the /api/sync threadpool), and asyncio.Queue is not
# thread-safe — so we marshal the fan-out back onto this loop via call_soon_threadsafe.
_loop: asyncio.AbstractEventLoop | None = None


async def _stream(request: Request, client_id: str | None) -> AsyncIterator[dict]:
    global _loop
    _loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue(maxsize=64)
    entry = (client_id, queue)
    _subscribers.append(entry)
    try:
        yield {"event": "hello", "data": json.dumps({"ok": True})}
        while True:
            if await request.is_disconnected():
                break
            try:
                event = await asyncio.wait_for(queue.get(), timeout=15)
                yield {"event": event["type"], "data": json.dumps(event)}
            except asyncio.TimeoutError:
                yield {"event": "ping", "data": "{}"}
    finally:
        if entry in _subscribers:
            _subscribers.remove(entry)


@router.post("/api/events/ticket")
def issue_ticket(ident: Identity = Depends(auth.require_identity)):
    """A ticket that opens the live update stream once, within a minute. Members get
    one too: they subscribe to the stream for live refresh of director edits."""
    return JSONResponse(
        {"ticket": TICKETS.issue(ident), "expires_in": int(TICKETS.ttl)},
        headers={"Cache-Control": "no-store"},
    )


def authenticate_stream(request: Request, key: str | None, ticket: str | None,
                        store: stream_ticket.TicketStore = TICKETS,
                        scope: str | None = None) -> Identity:
    """Who is opening a stream. In order: the header (a proxy or a test client can
    send one), a ticket (the app), and, while the setting allows it, the key in the
    address. Raises 401 otherwise. auth.identity_for keeps the missing/truncated-.key
    refusals this route always had."""
    sent = request.headers.get("X-Bandstand-Key")
    if sent:
        return auth.identity_for(sent)
    if ticket is not None:
        ident = store.redeem(ticket, scope)
        if ident is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, TICKET_REFUSED)
        return ident
    if key is not None and not stream_ticket.key_in_url_allowed():
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, OLD_ADDRESS_REFUSED)
    return auth.identity_for(key)


@router.get("/api/events")
async def events(request: Request, key: str | None = Query(default=None),
                 ticket: str | None = Query(default=None),
                 client: str | None = Query(default=None)):
    authenticate_stream(request, key, ticket)
    return EventSourceResponse(_stream(request, client))


def _fan_out(event_type: str, exclude_client: str | None, payload: dict) -> None:
    """Push the event onto every subscriber queue. MUST run on the event-loop thread."""
    msg = {"type": event_type, **payload}
    for client_id, q in list(_subscribers):
        if exclude_client is not None and client_id == exclude_client:
            continue
        try:
            q.put_nowait(msg)
        except asyncio.QueueFull:
            pass


def publish(event_type: str, exclude_client: str | None = None, **payload) -> None:
    # Callable from any thread. Once a stream has connected we have the loop, so hop
    # onto it (thread-safe). Before that there are no subscribers, so deliver inline
    # (also the path unit tests take, with no running loop).
    loop = _loop
    if loop is None:
        _fan_out(event_type, exclude_client, payload)
    else:
        loop.call_soon_threadsafe(_fan_out, event_type, exclude_client, payload)
