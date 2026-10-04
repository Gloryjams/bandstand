"""Refuse a request that is too large, or that has no business sending a large body,
BEFORE the body is read.

Why this exists: a multipart upload is written to a temporary file in full before
the route (and with it the key check) runs. Without this layer, anybody who can
reach the port can make the server store as many bytes as they care to send, key or
no key. In a container, where temporary files may live in memory, that is a way to
take the server down.

Three rules, in this order:

1. A declared size (Content-Length) above the ceiling for that address is refused
   with 413 straight away.
2. The two addresses that accept large bodies are director-only. The key is checked
   here, from the headers alone. A request without a valid director key never
   reaches the application: nothing of its body is parsed, kept in memory or
   written to disk. The bytes are read off the connection and thrown away, up to
   the ceiling, so that the sender gets a clean 401 or 403 and not a broken
   connection.
3. The body is counted as it arrives. A request that declared no size, or lied
   about it, is cut off with 413 when it crosses the ceiling.

Pure ASGI (not BaseHTTPMiddleware), because it has to wrap `receive`.
"""
from fastapi import HTTPException
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from server import auth, config

MB = 1024 * 1024

# Nothing legitimate in a JSON write approaches this, and without it a single huge
# svg_paths blob would be re-serialized into every manifest mirror.
JSON_CEILING = 5 * MB
# Room for the multipart envelope (boundaries, part headers, the piece_id field)
# around a file that is itself exactly at the limit.
_ENVELOPE = 1 * MB

UPLOAD_PATH = "/api/upload-piece"
TRANSFER_IMPORT_PATH = "/api/transfer/import"
LARGE_BODY_PATHS = frozenset({UPLOAD_PATH, TRANSFER_IMPORT_PATH})
_GUARDED_METHODS = frozenset({"POST", "PUT", "PATCH"})
_GUARDED_PREFIXES = ("/api/", "/room-api/")


def ceiling_for(path: str) -> int:
    if path == UPLOAD_PATH:
        return config.load().max_upload_mb * MB + _ENVELOPE
    if path == TRANSFER_IMPORT_PATH:
        from server.api import transfer

        return transfer._limit(config.load()) + _ENVELOPE
    return JSON_CEILING


def _too_large() -> JSONResponse:
    # "Connection: close": the unread body is not drained, so the connection cannot
    # be reused for another request.
    return JSONResponse(
        {"detail": "Body too large"}, status_code=413, headers={"Connection": "close"}
    )


async def _discard(receive: Receive, ceiling: int) -> None:
    """Read the body off the wire and keep none of it. Stops at the ceiling."""
    seen = 0
    while True:
        message = await receive()
        if message["type"] != "http.request":
            return
        seen += len(message.get("body", b""))
        if seen > ceiling or not message.get("more_body", False):
            return


class BodyLimitMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope["method"] not in _GUARDED_METHODS
            or not scope["path"].startswith(_GUARDED_PREFIXES)
        ):
            await self.app(scope, receive, send)
            return

        path = scope["path"]
        headers = Headers(scope=scope)
        ceiling = ceiling_for(path)

        declared = headers.get("content-length", "")
        if declared.isdigit() and int(declared) > ceiling:
            await _too_large()(scope, receive, send)
            return

        if path in LARGE_BODY_PATHS:
            try:
                auth.require_key(headers.get("x-bandstand-key"))
            except HTTPException as refusal:
                await _discard(receive, ceiling)
                response = JSONResponse(
                    {"detail": refusal.detail},
                    status_code=refusal.status_code,
                    headers={"Connection": "close"},
                )
                await response(scope, receive, send)
                return

        received = 0

        async def counted() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > ceiling:
                    # An HTTPException, because FastAPI turns any OTHER error raised
                    # while it parses a body into a 400.
                    raise HTTPException(status_code=413, detail="Body too large")
            return message

        await self.app(scope, counted, send)
