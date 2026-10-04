"""One director account, several existing libraries, one browser origin.

Only the HQ instance has workspaces.json. It contains explicit loopback ports and
key FILE locations, never key values. Child credentials stay on the server.
"""
import json
import re
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from server import auth, config, stream_ticket
from server.api.events import authenticate_stream

router = APIRouter()
_SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")

# Tickets for streams opened THROUGH this door. Each is tied to the band it was asked
# for. The band's own server never sees a ticket: the door opens the stream there
# with the band's key in the header, as for every other proxied request.
TICKETS = stream_ticket.TicketStore()


def _account(request: Request):
    sent = request.headers.get("X-Bandstand-Key")
    # EventSource cannot send headers. The stream takes a ticket in the address (or,
    # while the setting allows it, the key). Never for any other route.
    if request.url.path.endswith("/api/events") and not sent:
        query = request.query_params
        ident = authenticate_stream(
            request, query.get("key"), query.get("ticket"), TICKETS,
            scope=request.path_params.get("workspace"),
        )
    else:
        ident = auth.identity_for(sent)
    if ident.id != "root":
        raise HTTPException(403, "Director account required")
    return ident


def _directory() -> list[dict]:
    cfg = config.load()
    path = cfg.data_dir / "workspaces.json"
    if not path.exists():
        raise HTTPException(404, "No workspace directory")
    try:
        rows = json.loads(path.read_text())["workspaces"]
        if not isinstance(rows, list) or len(rows) > 100:
            raise ValueError()
        ids = set()
        for row in rows:
            slug = row["id"]
            if not isinstance(slug, str) or not _SLUG.fullmatch(slug) or slug in ids:
                raise ValueError()
            ids.add(slug)
            if type(row["port"]) is not int or not 1024 <= row["port"] <= 65535 or row["port"] == cfg.port:
                raise ValueError()
            if not isinstance(row["label"], str) or not row["label"].strip():
                raise ValueError()
            if not Path(row["key_file"]).is_absolute():
                raise ValueError()
            if not isinstance(row.get("aliases", []), list) or not all(isinstance(v, str) for v in row.get("aliases", [])):
                raise ValueError()
        return rows
    except (OSError, ValueError, KeyError, TypeError):
        raise HTTPException(503, "Band directory is unavailable") from None


@router.get("/api/workspaces", dependencies=[Depends(_account)])
def list_workspaces():
    return JSONResponse({"workspaces": [
        {"id": r["id"], "label": r["label"], "path": f'/bands/{r["id"]}', "aliases": r.get("aliases", []), **({"member_url": r["member_url"]} if r.get("member_url") else {})}
        for r in _directory()
    ]}, headers={"Cache-Control": "no-store"})


def _transport():
    return None  # Test seam for HTTPX's in-process transport.


async def _forward(workspace: str, path: str, request: Request, *, guest=False, member_key: str | None = None,
                   ticket: str | None = None):
    """Send the request on to the band's own server.

    What travels as the credential: `member_key` in the header (the public member
    door, which has checked it); else the band's director key from its key file
    (the HQ door, whose caller is the director); a guest request carries none.
    `ticket` is the exception: a stream ticket the band's own server issued (through
    the member door, to a member) goes on in the address with NO credential header,
    and the band redeems it itself. It must not be used with any other path."""
    if ticket is not None and (path != "events" or member_key is not None or guest):
        raise HTTPException(404, "Not found")
    row = next((r for r in _directory() if r["id"] == workspace), None)
    if row is None:
        raise HTTPException(404, "Band not found")
    # Build URLs only from a fixed loopback host, configured port and plain path
    # segments. Never follow redirects or accept an upstream URL from a client.
    if not re.fullmatch(r"[A-Za-z0-9_./-]+", path) or any(p in {".", "..", ""} for p in path.split("/")):
        raise HTTPException(404, "Not found")
    prefix = "room-api" if guest else "api"
    forwarded = ("content-type", "range", "if-none-match", "if-modified-since", "x-bandstand-client")
    if guest:
        forwarded += ("x-bandstand-room", "x-bandstand-participant")
    headers = {k: request.headers[k] for k in forwarded if k in request.headers}
    if member_key is not None:
        headers["X-Bandstand-Key"] = member_key
    elif ticket is not None:
        pass  # the band checks the ticket; nothing else vouches for this request
    elif not guest:
        try:
            key = Path(row["key_file"]).read_text().strip()
        except OSError:
            raise HTTPException(503, "This band is temporarily unavailable") from None
        if len(key) < 32:
            raise HTTPException(503, "This band is temporarily unavailable")
        headers["X-Bandstand-Key"] = key
    # A key or ticket in the address is spent at this door and never travels on,
    # except the member door's pass-through ticket above.
    params = [(k, v) for k, v in request.query_params.multi_items() if k not in {"key", "ticket"}]
    if ticket is not None:
        params.append(("ticket", ticket))
    ceiling = 512 * 1024 if path.startswith("my-notes/") else 5 * 1024 * 1024
    if not guest and path in {"upload-piece", "transfer/import"}:
        ceiling = (min(500, 10 * config.load().max_upload_mb) if path == "transfer/import" else config.load().max_upload_mb) * 1024 * 1024
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > ceiling:
        raise HTTPException(413, "Body too large")

    async def body():
        size = 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > ceiling:
                raise HTTPException(413, "Body too large")
            yield chunk

    client = httpx.AsyncClient(transport=_transport(), trust_env=False, follow_redirects=False,
        timeout=httpx.Timeout(connect=5, read=None if path == "events" else 120, write=120, pool=5))
    try:
        outgoing = client.build_request(request.method, f'http://127.0.0.1:{row["port"]}/{prefix}/{path}',
            params=params, headers=headers, content=body() if request.method in {"POST", "PUT", "PATCH"} else None)
        response = await client.send(outgoing, stream=True)
    except httpx.HTTPError:
        await client.aclose()
        raise HTTPException(503, "This band is temporarily unavailable. Your saved charts are still on this device.") from None
    except BaseException:
        await client.aclose()
        raise

    async def chunks():
        try:
            # Mock transports may return an already-consumed body.
            if response.is_stream_consumed:
                yield response.content
            else:
                async for chunk in response.aiter_raw():
                    yield chunk
        finally:
            await response.aclose()
            await client.aclose()
    allowed = {"content-type", "content-length", "content-range", "accept-ranges", "content-disposition", "etag", "last-modified", "content-encoding"}
    returned = {k: v for k, v in response.headers.items() if k in allowed}
    returned["Cache-Control"] = "no-store"
    return StreamingResponse(chunks(), status_code=response.status_code, headers=returned)


@router.api_route("/bands/{workspace}/api/{path:path}", methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])
async def director_api(workspace: str, path: str, request: Request, ident=Depends(_account)):
    if path == "events/ticket" and request.method == "POST":
        # Issued here, for this band, spent at this door. See TICKETS above.
        if not any(r["id"] == workspace for r in _directory()):
            raise HTTPException(404, "Band not found")
        return JSONResponse(
            {"ticket": TICKETS.issue(ident, scope=workspace), "expires_in": int(TICKETS.ttl)},
            headers={"Cache-Control": "no-store"},
        )
    return await _forward(workspace, path, request)


@router.api_route("/bands/{workspace}/room-api/{path:path}", methods=["GET", "POST", "PUT"])
async def guest_room_api(workspace: str, path: str, request: Request):
    # Existing per-room and per-participant capabilities gate the upstream API.
    # This path NEVER gets a director credential.
    return await _forward(workspace, path, request, guest=True)
