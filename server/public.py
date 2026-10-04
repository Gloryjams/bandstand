"""Bandstand's public read-only surface (uvicorn target: `public:app`).

A separate FastAPI process from the main app, bound to 127.0.0.1:7810 and reachable only
through the Cloudflare tunnel. Share reads open SQLite through db.connect_ro();
the only local write is the render cache. Explicitly enabled band-member reads
are routed by member_access, with a member credential required on every request
(the one exception is the live update stream, which opens with a one-minute ticket
the band's own server issued to a member through this door and redeems itself).
Director credentials and all library writes are excluded from that route.

Every share a guest can reach is gated on a share token. The gate has exactly one failure
mode, `ShareNotFound`, which renders one byte-identical 404 for a malformed token, an
unknown token, an expired or revoked token, and a valid token reaching for something
outside its share. Tokens are bearer credentials, so they never appear in a log line or
an exception message.
"""
import hashlib
import html
import io
import json
import logging
import math
import os
import re
import secrets
import sqlite3
import threading
import time
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Any, Iterator

import pymupdf
from fastapi import FastAPI, Request
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from PIL import Image

from server import config, db
from server.config import Config

_STATIC_GUEST = Path(__file__).parent / "static" / "guest"

# Tokens are secrets.token_urlsafe(24); the class is fixed, the length is not pinned so a
# future widening does not silently 404 every old link.
_TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{16,128}")

# ASCII digits only, and bounded. str.isdigit() would accept both superscripts and
# thousand-digit strings, either of which makes the following int() raise (ValueError past
# CPython's int-string limit) and turn a bad URL into a 500. Six digits is far past the
# 200-page ceiling below.
_PAGE_RE = re.compile(r"[0-9]{1,6}")

# Render bounds. Phones are ~400 CSS px wide at 2x-3x DPR, so ~1400 device px is a sharp
# page without shipping a poster. The megapixel cap catches A0-sized source pages.
_TARGET_WIDTH = 1400
_MAX_PIXELS = 4_000_000
_MAX_SOURCE_BYTES = 100 * 1024 * 1024
_MAX_PDF_PAGES = 200
# Decode bomb guard, checked from the header before Pillow loads any pixels. 25 MP of RGB
# is ~75 MB decoded; with two render slots that stays well inside the 512 MB PM2 cap.
_MAX_IMAGE_PIXELS = 25_000_000
# Part of the ETag and the cache key: the render parameter, not the per-page scale, so a
# conditional request can be answered without opening the source file.
_SCALE_TAG = f"w{_TARGET_WIDTH}"
_RENDERER_VERSION = "v1"

_CACHE_CAP_BYTES = 500 * 1024 * 1024
_RENDER_SLOTS = threading.Semaphore(2)
# Waiting forever for a slot pins a threadpool thread, so a handful of slow renders would
# take the whole app down. Give up and shed load instead.
_RENDER_WAIT_S = 10

_THROTTLE_WINDOW_S = 60.0
# Misses are keyed on (ip, token), not ip alone: at a gig every guest is behind one venue
# NAT address, so a bare-IP budget would have them throttling each other, and one share
# could starve every other share the director handed out that night. The ceiling covers a couple
# of phones paging a long set at once before the cache warms (a 200-page book is the hard
# limit, and only misses count).
_THROTTLE_MAX_MISSES = 120
# The gate is cheap (one indexed SELECT), so this only has to stop a grinder.
_THROTTLE_MAX_GATE = 240
_THROTTLE_MAX_KEYS = 4096

# Chart keys a guest is allowed to see, at every level. Built by picking, never by
# deleting, so a field added upstream is excluded by default instead of leaking until
# someone notices. Nesting matters: projecting only the top level would ship a new
# per-section or per-bar field (a private performance note, say) verbatim.
_PUBLIC_CHART_KEYS = (
    "title", "artist", "key", "time", "bpm", "style", "capo",
    "sections", "arrangement", "settings",
)
_PUBLIC_SECTION_KEYS = ("id", "label", "bars", "barsPerRow", "description", "hits")
_PUBLIC_BAR_KEYS = ("chords", "lyrics", "barline", "ending", "sign", "direction", "hits")
_PUBLIC_STEP_KEYS = ("id", "sectionId", "repeats", "open", "solos", "hits", "note")

# Everything is same-origin or inline-with-a-nonce; there are no third-party assets and
# the guest surface never posts, frames or navigates anywhere.
_CSP_STATIC = (
    "default-src 'none'; img-src 'self' data:; connect-src 'self'; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)


class ShareNotFound(Exception):
    """The one and only way a guest request fails."""


class RenderBusy(Exception):
    """All render slots were occupied for too long. Raised after the token gate, so it
    tells a guest nothing it did not already know."""


# ---------------------------------------------------------------- responses


_GUEST_CSS = """
:root{--bg:#0b0d10;--fg:#e8ecf1;--dim:#8a94a3;--cyan:#6CF;--line:#1b212a}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);
 font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
 -webkit-text-size-adjust:100%}
a{color:inherit;text-decoration:none}
.wrap{max-width:44rem;margin:0 auto;padding:1.25rem 1rem 3rem}
.mark{font-size:.7rem;letter-spacing:.22em;text-transform:uppercase;color:var(--cyan)}
h1{font-size:1.5rem;line-height:1.2;margin:.5rem 0 .25rem;font-weight:600}
.sub{margin:0;color:var(--dim);font-size:.85rem}
.list{list-style:none;margin:1.5rem 0 0;padding:0}
.row{border-top:1px solid var(--line)}
.row a,.row .dead{display:flex;gap:.75rem;align-items:baseline;padding:.85rem .25rem}
.row .n{color:var(--dim);font-size:.8rem;min-width:1.5rem;font-variant-numeric:tabular-nums}
.row .t{flex:1;min-width:0}
.row .m{color:var(--dim);font-size:.8rem}
.row .dead .t{color:var(--dim)}
.brk{border-top:1px solid var(--line);padding:.7rem .25rem;color:var(--cyan);
 font-size:.7rem;letter-spacing:.18em;text-transform:uppercase}
footer{margin-top:2.5rem;padding-top:1rem;border-top:1px solid var(--line);
 color:var(--dim);font-size:.75rem}
.stage{position:fixed;inset:0 0 2.75rem 0;display:flex;align-items:center;
 justify-content:center;background:#000;touch-action:pinch-zoom;overflow:hidden}
.stage img{max-width:100%;max-height:100%;display:block}
.bar{position:fixed;left:0;right:0;bottom:0;height:2.75rem;display:flex;
 align-items:center;justify-content:space-between;gap:1rem;padding:0 1rem;
 background:var(--bg);border-top:1px solid var(--line);font-size:.78rem;color:var(--dim)}
.bar .who{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
 color:var(--fg)}
.bar .count{font-variant-numeric:tabular-nums;color:var(--cyan)}
.bar .back{color:var(--dim)}
.note{margin-top:2rem;padding:1rem;border:1px solid var(--line);border-radius:.5rem;
 color:var(--dim);font-size:.9rem}
"""

def _nonce() -> str:
    """A per-response CSP nonce. token_urlsafe(16) is always 22 characters, which keeps
    every response body (and Content-Length) the same size whichever nonce is drawn: the
    404 has to stay indistinguishable across reasons."""
    return secrets.token_urlsafe(16)


def _csp(nonce: str) -> str:
    return f"{_CSP_STATIC}; style-src 'self' 'nonce-{nonce}'; script-src 'self' 'nonce-{nonce}'"


_GUEST_ICONS = (
    '<link rel="icon" type="image/svg+xml" href="/guest/favicon.svg">'
    '<link rel="apple-touch-icon" sizes="180x180" href="/guest/apple-touch-icon.png">'
)


def _not_found_html(nonce: str) -> str:
    return (
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        f"{_GUEST_ICONS}"
        f"<title>Not available</title><style nonce=\"{nonce}\">{_GUEST_CSS}</style>"
        "</head><body>"
        "<div class=\"wrap\"><div class=\"mark\">Bandstand</div>"
        "<h1>This link is not available</h1>"
        "<p class=\"sub\">It may have expired, it may have been revoked, or it may never "
        f"have existed.</p><footer>{_attribution_text()}</footer></div></body></html>"
    )


def not_found_response() -> Response:
    """The single 404. Same status, body, content type, length and headers for every reason
    a request can fail, so the response cannot be used to probe what exists. The nonce is
    the only part that varies, and it varies at random rather than with the reason."""
    nonce = _nonce()
    return Response(
        content=_not_found_html(nonce).encode("utf-8"),
        status_code=404,
        media_type="text/html; charset=utf-8",
        headers={"Cache-Control": "no-store", "Content-Security-Policy": _csp(nonce)},
    )


def _html_response(body: str, nonce: str) -> Response:
    return Response(
        content=body.encode("utf-8"),
        media_type="text/html; charset=utf-8",
        headers={"Cache-Control": "no-store", "Content-Security-Policy": _csp(nonce)},
    )


def _page(title: str, body: str, nonce: str) -> str:
    return (
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        "<meta name=\"robots\" content=\"noindex, nofollow, noarchive\">"
        f"{_GUEST_ICONS}"
        f"<title>{html.escape(title)}</title>"
        f"<style nonce=\"{nonce}\">{_GUEST_CSS}</style></head>"
        f"<body>{body}</body></html>"
    )


def _embed_json(value: Any) -> str:
    """The HTML-to-JavaScript boundary: everything embedded in a <script> body goes
    through here and nothing else. json.dumps does the escaping a JS string context
    actually needs, and `</` is broken up so a string in the data cannot close the tag.
    Callers pass RAW values; html.escape() is the wrong transform here and would corrupt
    them (an ampersand in a filename would arrive as &amp;)."""
    return json.dumps(value).replace("</", "<\\/")


# ---------------------------------------------------------------- token gate


def _now_ms() -> int:
    return int(time.time() * 1000)


@contextmanager
def share_gate(
    cfg: Config, request: Request, token: str
) -> Iterator[tuple[sqlite3.Connection, sqlite3.Row]]:
    """Open a read-only connection and resolve a usable share, or raise ShareNotFound.

    Malformed, unknown, expired and revoked all leave by the same door. Gate attempts are
    rate limited per client: high-entropy tokens already make guessing hopeless, this just
    stops one host from grinding the database.
    """
    if not allow_gate(client_ip(request)):
        raise RenderBusy()
    if not _TOKEN_RE.fullmatch(token):
        raise ShareNotFound()
    try:
        conn = db.connect_ro(cfg.db_path)
    except sqlite3.Error:
        # Missing/locked database. Never surface the reason: the message would travel
        # back on a request that carries a token.
        raise ShareNotFound() from None
    try:
        try:
            row = conn.execute(
                "SELECT id, target_kind, target_id, label, expires_at, revoked_at "
                "FROM shares WHERE token = ?",
                (token,),
            ).fetchone()
        except sqlite3.Error:
            raise ShareNotFound() from None
        if row is None or row["revoked_at"] is not None:
            raise ShareNotFound()
        if row["expires_at"] is not None and row["expires_at"] <= _now_ms():
            raise ShareNotFound()
        yield conn, row
    finally:
        conn.close()


def piece_reachable(conn: sqlite3.Connection, share: sqlite3.Row, piece_id: str) -> bool:
    """Is this piece inside the share, right now? Never cached: a piece pulled out of a
    shared setlist has to stop resolving on the very next request."""
    if share["target_kind"] == "piece":
        if piece_id != share["target_id"]:
            return False
        row = conn.execute(
            "SELECT 1 FROM pieces WHERE id = ? AND deleted_at IS NULL", (piece_id,)
        ).fetchone()
        return row is not None
    row = conn.execute(
        "SELECT 1 FROM setlist_items si JOIN pieces p ON p.id = si.piece_id "
        "WHERE si.setlist_id = ? AND si.piece_id = ? AND si.kind = 'piece' "
        "AND p.deleted_at IS NULL",
        (share["target_id"], piece_id),
    ).fetchone()
    return row is not None


def _live_files(conn: sqlite3.Connection, piece_id: str) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT id, kind, filename, page_count, ordinal, content_hash FROM files "
        "WHERE piece_id = ? AND deleted_at IS NULL ORDER BY ordinal, id",
        (piece_id,),
    ).fetchall()


def _files_for_pieces(
    conn: sqlite3.Connection, piece_ids: list[str]
) -> dict[str, list[sqlite3.Row]]:
    """Live files for many pieces in one query, grouped by piece and kept in render order."""
    if not piece_ids:
        return {}
    unique = list(dict.fromkeys(piece_ids))
    placeholders = ",".join("?" * len(unique))
    rows = conn.execute(
        f"SELECT id, piece_id, kind, page_count FROM files "
        f"WHERE piece_id IN ({placeholders}) AND deleted_at IS NULL ORDER BY ordinal, id",
        unique,
    ).fetchall()
    grouped: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        grouped.setdefault(row["piece_id"], []).append(row)
    return grouped


def _renderable_files(files: list[sqlite3.Row]) -> list[sqlite3.Row]:
    """The files a guest can actually be shown. A PDF past the page ceiling is excluded
    here rather than at render time, so an oversized book is listed as unsupported instead
    of opening a pager whose every page 404s into a black screen."""
    out = []
    for f in files:
        if f["kind"] == "image":
            out.append(f)
        elif f["kind"] == "pdf" and 0 < (f["page_count"] or 0) <= _MAX_PDF_PAGES:
            out.append(f)
    return out


def _reachable_file(
    conn: sqlite3.Connection, share: sqlite3.Row, file_id: str, kind: str
) -> sqlite3.Row:
    row = conn.execute(
        "SELECT id, piece_id, kind, filename, page_count, content_hash FROM files "
        "WHERE id = ? AND deleted_at IS NULL",
        (file_id,),
    ).fetchone()
    if row is None or row["kind"] != kind:
        raise ShareNotFound()
    if not piece_reachable(conn, share, row["piece_id"]):
        raise ShareNotFound()
    return row


# ---------------------------------------------------------------- file access


def library_path(cfg: Config, filename: str) -> Path:
    """Resolve a DB filename inside the library dir, or raise.

    The row is trusted to name a file, not to stay inside the library: a hostile or
    corrupted `files.filename` ("../../evil.pdf", or an absolute path, which would make
    the join discard the root entirely) must not become a readable path.
    """
    root = cfg.library_dir.resolve()
    try:
        candidate = (root / filename).resolve()
    except (OSError, ValueError):
        raise ShareNotFound() from None
    if candidate == root or root not in candidate.parents:
        raise ShareNotFound()
    if not candidate.is_file():
        raise ShareNotFound()
    return candidate


def _check_source_size(path: Path) -> None:
    try:
        if path.stat().st_size > _MAX_SOURCE_BYTES:
            raise ShareNotFound()
    except OSError:
        raise ShareNotFound() from None


def _fit_scale(width: float, height: float) -> float:
    if width <= 0 or height <= 0:
        raise ShareNotFound()
    scale = min(max(_TARGET_WIDTH / width, 1.0), 4.0)
    if width * scale * height * scale > _MAX_PIXELS:
        scale = math.sqrt(_MAX_PIXELS / (width * height))
    return scale


@contextmanager
def _render_slot() -> Iterator[None]:
    """Bound concurrent decodes, and give up rather than pin a threadpool thread forever."""
    if not _RENDER_SLOTS.acquire(timeout=_RENDER_WAIT_S):
        raise RenderBusy()
    try:
        yield
    finally:
        _RENDER_SLOTS.release()


def render_pdf_page(path: Path, page: int) -> bytes:
    _check_source_size(path)
    with _render_slot():
        try:
            doc = pymupdf.open(str(path))
        except Exception:
            raise ShareNotFound() from None
        try:
            if doc.page_count > _MAX_PDF_PAGES or not 0 <= page < doc.page_count:
                raise ShareNotFound()
            rect = doc[page].rect
            scale = _fit_scale(rect.width, rect.height)
            pix = doc[page].get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
            return pix.tobytes("png")
        except ShareNotFound:
            raise
        except Exception:
            # Encrypted, truncated or otherwise pathological PDF. Same 404 as everything
            # else; the guest learns nothing about why.
            raise ShareNotFound() from None
        finally:
            doc.close()


def _downscale(width: int, height: int) -> float:
    """Shrink-only factor keeping the output under the megapixel cap. Guest images are
    never upscaled, so this is not _fit_scale."""
    if width <= 0 or height <= 0:
        raise ShareNotFound()
    if width * height <= _MAX_PIXELS:
        return 1.0
    return math.sqrt(_MAX_PIXELS / (width * height))


def render_image(path: Path) -> bytes:
    """Decode and re-encode. Raw disk bytes never reach a guest, so a file that is only
    nominally an image cannot be handed over intact."""
    _check_source_size(path)
    with _render_slot():
        try:
            with Image.open(path) as img:
                # Image.open only reads the header, so the bomb check happens before any
                # pixels are allocated.
                w, h = img.size
                if w * h > _MAX_IMAGE_PIXELS:
                    raise ShareNotFound()
                scale = _downscale(w, h)
                target = (max(1, int(w * scale)), max(1, int(h * scale)))
                # For JPEG this makes libjpeg decode straight to (roughly) the target size
                # instead of allocating the full frame and shrinking afterwards.
                img.draft("RGB", target)
                img = img.convert("RGB")
                if img.size != target and scale < 1.0:
                    img = img.resize(target)
                out = io.BytesIO()
                img.save(out, format="PNG")
                return out.getvalue()
        except (ShareNotFound, RenderBusy):
            raise
        except Exception:
            raise ShareNotFound() from None


# ---------------------------------------------------------------- render cache


_key_locks: dict[str, threading.Lock] = {}
_key_locks_guard = threading.Lock()
_evicting = threading.Lock()


def cache_dir(cfg: Config) -> Path:
    """Sits outside library/ so the main app's watcher never sees these writes."""
    return cfg.data_dir / ".share-cache"


@contextmanager
def _key_lock(key: str) -> Iterator[None]:
    """One render per key under concurrent misses. The entry is dropped on the way out so
    the table tracks in-flight renders rather than every page ever requested."""
    with _key_locks_guard:
        lock = _key_locks.setdefault(key, threading.Lock())
    lock.acquire()
    try:
        yield
    finally:
        lock.release()
        with _key_locks_guard:
            if key in _key_locks and not _key_locks[key].locked():
                del _key_locks[key]


def _evict_lru(directory: Path) -> None:
    """Trim the cache to the cap, oldest first. Called after a write, never on the read
    path, and skipped entirely if another thread is already trimming."""
    if not _evicting.acquire(blocking=False):
        return
    try:
        entries = []
        total = 0
        for f in directory.glob("*.png"):
            try:
                st = f.stat()
            except OSError:
                continue
            entries.append((st.st_mtime, st.st_size, f))
            total += st.st_size
        if total <= _CACHE_CAP_BYTES:
            return
        entries.sort()
        target = int(_CACHE_CAP_BYTES * 0.8)
        for _, size, f in entries:
            if total <= target:
                break
            try:
                f.unlink()
                total -= size
            except OSError:
                continue
    finally:
        _evicting.release()


def cache_path(cfg: Config, key: str) -> Path:
    return cache_dir(cfg) / f"{hashlib.sha256(key.encode()).hexdigest()}.png"


def _read_cached(path: Path) -> bytes | None:
    try:
        data = path.read_bytes()
    except OSError:
        return None
    try:
        # Stamp the hit so eviction is genuinely least-recently-USED. Without this the
        # mtime only ever records the write and eviction degrades to FIFO, throwing away
        # the set the director is actually paging through.
        os.utime(path, None)
    except OSError:
        pass
    return data


def cached_render(cfg: Config, key: str, produce) -> bytes:
    """Serve the render from disk, or produce it once. The per-key lock means concurrent
    misses on the same page render once, not once each."""
    path = cache_path(cfg, key)
    hit = _read_cached(path)
    if hit is not None:
        return hit
    with _key_lock(key):
        hit = _read_cached(path)
        if hit is not None:
            return hit
        data = produce()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.parent / f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp"
            tmp.write_bytes(data)
            os.replace(tmp, path)
            _evict_lru(path.parent)
        except OSError:
            # A cache that cannot be written is a slow share, not a broken one.
            pass
        return data


# ---------------------------------------------------------------- throttle


_miss_log: dict[tuple[str, str], list[float]] = {}
_gate_log: dict[str, list[float]] = {}
_throttle_lock = threading.Lock()


def client_ip(request: Request) -> str:
    """CF-Connecting-IP is a caller-supplied header, so it is only believed when the
    process is actually deployed behind the tunnel (BANDSTAND_BEHIND_CF=1, set in the PM2
    env). Anywhere else, including dev and the playtest harness, the header is ignored and
    a spoofed value cannot be used to dodge the throttle by rotating it."""
    if os.environ.get("BANDSTAND_BEHIND_CF") == "1":
        forwarded = request.headers.get("CF-Connecting-IP")
        if forwarded:
            return forwarded.strip()
    return request.client.host if request.client else "unknown"


def _allow(log: dict, key, limit: int) -> bool:
    """Fixed-window-ish limiter: keep the timestamps inside the window, refuse past the
    limit. Bounded by eviction so a flood of distinct keys cannot grow it without end."""
    now = time.monotonic()
    with _throttle_lock:
        hits = [t for t in log.get(key, ()) if now - t < _THROTTLE_WINDOW_S]
        if len(hits) >= limit:
            log[key] = hits
            return False
        hits.append(now)
        log[key] = hits
        if len(log) > _THROTTLE_MAX_KEYS:
            for stale in [
                k for k, v in log.items() if not v or now - v[-1] > _THROTTLE_WINDOW_S
            ]:
                log.pop(stale, None)
            # Still oversized means the window is genuinely full of live keys; drop the
            # oldest rather than let the table grow without bound.
            if len(log) > _THROTTLE_MAX_KEYS:
                for k in sorted(log, key=lambda k: log[k][-1])[: len(log) // 2]:
                    log.pop(k, None)
        return True


def allow_miss(ip: str, token: str) -> bool:
    return _allow(_miss_log, (ip, token), _THROTTLE_MAX_MISSES)


def allow_gate(ip: str) -> bool:
    return _allow(_gate_log, ip, _THROTTLE_MAX_GATE)


# ---------------------------------------------------------------- pages


def _attribution() -> str:
    """The credit line on every guest page. Operator-set (BANDSTAND_SHARE_ATTRIBUTION),
    so nothing personal is baked into the code. Read per request like the rest of the
    config; it is constant for the life of a process, which keeps the 404 page
    byte-identical across requests."""
    return config.load().share_attribution


def _attribution_text() -> str:
    # Element content: escape markup only. Quotes and apostrophes are legal there, and
    # leaving them alone keeps a name like "Rea's gig book" readable in view-source.
    return html.escape(_attribution(), quote=False)


def _footer() -> str:
    return f"<footer>{_attribution_text()}</footer>"


def _meta_line(row: sqlite3.Row) -> str:
    bits = [row["composer"], row["music_key"]]
    return " · ".join(html.escape(str(b)) for b in bits if b)


def setlist_landing(
    conn: sqlite3.Connection, share: sqlite3.Row, token: str, nonce: str
) -> str:
    setlist = conn.execute(
        "SELECT name, venue, date FROM setlists WHERE id = ?", (share["target_id"],)
    ).fetchone()
    if setlist is None:
        raise ShareNotFound()
    items = conn.execute(
        "SELECT si.kind AS item_kind, si.break_label, p.id AS piece_id, p.title, "
        "p.composer, p.music_key, p.kind AS piece_kind "
        "FROM setlist_items si "
        "LEFT JOIN pieces p ON p.id = si.piece_id AND p.deleted_at IS NULL "
        "WHERE si.setlist_id = ? ORDER BY si.ordinal",
        (share["target_id"],),
    ).fetchall()
    # One query for every member's files rather than one per row: a 40-tune set was 40
    # round trips to decide which rows are links.
    files_by_piece = _files_for_pieces(
        conn, [it["piece_id"] for it in items if it["piece_id"]]
    )

    rows: list[str] = []
    number = 0
    for it in items:
        if it["item_kind"] != "piece":
            label = it["break_label"] or "Break"
            rows.append(f"<li class=\"brk\">{html.escape(str(label))}</li>")
            continue
        if it["piece_id"] is None:
            continue  # deleted since the setlist was built
        number += 1
        title = html.escape(it["title"] or "Untitled")
        meta = _meta_line(it)
        renderable = it["piece_kind"] == "chart" or bool(
            _renderable_files(files_by_piece.get(it["piece_id"], []))
        )
        if renderable:
            rows.append(
                f"<li class=\"row\"><a href=\"/s/{html.escape(token)}/piece/"
                f"{html.escape(it['piece_id'])}\"><span class=\"n\">{number}</span>"
                f"<span class=\"t\">{title}</span><span class=\"m\">{meta}</span></a></li>"
            )
        else:
            rows.append(
                f"<li class=\"row\"><span class=\"dead\"><span class=\"n\">{number}</span>"
                f"<span class=\"t\">{title}</span>"
                f"<span class=\"m\">not supported in shared view</span></span></li>"
            )

    name = html.escape(setlist["name"] or "Setlist")
    sub_bits = [b for b in (setlist["venue"], setlist["date"]) if b]
    sub = html.escape(" · ".join(str(b) for b in sub_bits)) if sub_bits else (
        f"{number} pieces" if number != 1 else "1 piece"
    )
    body = (
        f"<div class=\"wrap\"><div class=\"mark\">Bandstand</div><h1>{name}</h1>"
        f"<p class=\"sub\">{sub}</p><ol class=\"list\">{''.join(rows)}</ol>"
        f"{_footer()}</div>"
    )
    return _page(setlist["name"] or "Setlist", body, nonce)


def _back_link(share: sqlite3.Row, token: str) -> str:
    """A way back to the set listing, but only when there is a listing to go back to."""
    if share["target_kind"] != "setlist":
        return ""
    return f"<a class=\"back\" href=\"/s/{html.escape(token)}\">Set</a>"


def _bar_end(share: sqlite3.Row, token: str) -> str:
    """The pager is full-screen, so its bottom bar carries what the scrolling pages put in
    a footer: the way back for a setlist share, the attribution for a standalone one."""
    return _back_link(share, token) or f"<span class=\"back\">{_attribution_text()}</span>"


def piece_page(
    conn: sqlite3.Connection, share: sqlite3.Row, token: str, piece_id: str, nonce: str
) -> str:
    piece = conn.execute(
        "SELECT id, title, composer, music_key, kind FROM pieces "
        "WHERE id = ? AND deleted_at IS NULL",
        (piece_id,),
    ).fetchone()
    if piece is None:
        raise ShareNotFound()
    if piece["kind"] == "chart":
        return chart_page(share, token, piece)

    # Raw values: these are embedded through _embed_json, which is the escaping boundary
    # for a script context. html.escape() here would be the wrong transform.
    pages: list[str] = []
    for f in _renderable_files(_live_files(conn, piece_id)):
        if f["kind"] == "pdf":
            pages.extend(
                f"/s/{token}/p/{f['id']}/{i}.png" for i in range(f["page_count"])
            )
        else:
            pages.append(f"/s/{token}/img/{f['id']}.png")
    if not pages:
        return unsupported_page(share, token, piece, nonce)

    title = html.escape(piece["title"] or "Untitled")
    body = (
        f"<div class=\"stage\" id=\"stage\"><img id=\"pg\" alt=\"Page 1\"></div>"
        f"<div class=\"bar\"><span class=\"who\">{title}</span>"
        f"<span class=\"count\"><span id=\"n\">1</span> / {len(pages)}</span>"
        f"{_bar_end(share, token)}</div>"
        f"<script nonce=\"{nonce}\">"
        f"{_PAGER_JS.replace('__PAGES__', _embed_json(pages))}</script>"
    )
    return _page(piece["title"] or "Untitled", body, nonce)


_PAGER_JS = """
(function(){
  var pages = __PAGES__, i = -1, pre = new Image();
  var img = document.getElementById('pg'), n = document.getElementById('n');
  var stage = document.getElementById('stage');
  function show(k){
    if (k < 0 || k >= pages.length || k === i) return;
    i = k; img.src = pages[i]; img.alt = 'Page ' + (i + 1);
    n.textContent = String(i + 1);
    if (i + 1 < pages.length) pre.src = pages[i + 1];
  }
  var px = 0, py = 0, pid = null;
  stage.addEventListener('pointerdown', function(e){ pid = e.pointerId; px = e.clientX; py = e.clientY; });
  stage.addEventListener('pointerup', function(e){
    if (e.pointerId !== pid) return;
    pid = null;
    var dx = e.clientX - px, dy = e.clientY - py;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) { show(dx < 0 ? i + 1 : i - 1); return; }
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
      var r = stage.getBoundingClientRect();
      show(e.clientX - r.left < r.width * 0.3 ? i - 1 : i + 1);
    }
  });
  document.addEventListener('keydown', function(e){
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') show(i + 1);
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') show(i - 1);
  });
  show(0);
})();
"""


def chart_page(share: sqlite3.Row, token: str, piece: sqlite3.Row) -> str:
    """Shell for the guest chart bundle.

    Deliberately bare, and NOT built on _page(): the bundle sets its own background,
    fills the viewport and owns everything inside #guest-root, so a wrapper, a footer or
    this module's CSS would only fight it. Asset filenames are contractual and unhashed;
    the script must stay type="module".

    data-attribution carries the spec's footer wording and data-setlist-url the way back
    to the set listing, both rendered by the bundle. The strings stay on this side so
    nothing personal is compiled into an open-source client bundle, the same reason the
    public base URL lives in env. data-setlist-url is emitted ONLY for a setlist share:
    on a piece share there is no listing to go back to, and pointing it at /s/{token}
    would just reload this same chart.
    """
    esc_token = html.escape(token)
    back = (
        f" data-setlist-url=\"/s/{esc_token}\""
        if share["target_kind"] == "setlist"
        else ""
    )
    return (
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        "<meta name=\"robots\" content=\"noindex, nofollow, noarchive\">"
        f"{_GUEST_ICONS}"
        f"<title>{html.escape(piece['title'] or 'Untitled')}</title>"
        "<link rel=\"stylesheet\" href=\"/guest/guest.css\"></head><body>"
        f"<div id=\"guest-root\" data-chart-url=\"/s/{esc_token}/chart/"
        f"{html.escape(piece['id'])}\" data-attribution=\"{html.escape(_attribution())}\""
        f"{back}></div>"
        "<script type=\"module\" src=\"/guest/guest.js\"></script></body></html>"
    )


def unsupported_page(
    share: sqlite3.Row, token: str, piece: sqlite3.Row, nonce: str
) -> str:
    title = html.escape(piece["title"] or "Untitled")
    body = (
        f"<div class=\"wrap\"><div class=\"mark\">Bandstand</div><h1>{title}</h1>"
        "<div class=\"note\">This piece is not supported in the shared view yet.</div>"
        f"{_back_link(share, token)}{_footer()}</div>"
    )
    return _page(piece["title"] or "Untitled", body, nonce)


# ---------------------------------------------------------------- chart DTO


def _pick(value: Any, keys: tuple[str, ...]) -> dict[str, Any]:
    return {k: value[k] for k in keys if k in value}


def _public_section(section: Any) -> dict[str, Any] | None:
    """One section, projected. Returns None for a section the renderer could not draw, so
    the caller drops it instead of shipping something that breaks the page."""
    if not isinstance(section, dict) or not isinstance(section.get("bars"), list):
        return None
    out = _pick(section, _PUBLIC_SECTION_KEYS)
    out["bars"] = [
        _pick(bar, _PUBLIC_BAR_KEYS) for bar in section["bars"] if isinstance(bar, dict)
    ]
    return out


def public_chart(chart: Any) -> dict[str, Any]:
    """Allowlist projection of pieces.chart_json, applied at EVERY level.

    Picked, never deleted: id, tags and the timestamps stay out because they are not in
    the lists, not because they were removed. Recursing matters as much as the top level
    does. chart_json is opaque to this server and grows upstream in SaltyCharts, so a new
    per-section or per-bar field (a private performance note, say) would otherwise ride
    out to strangers verbatim the day it is added.

    A chart with no usable `sections` fails as a 404, which the guest bundle renders as
    "no longer available", rather than reaching it as a payload it would draw blank.
    """
    if not isinstance(chart, dict):
        raise ShareNotFound()
    dto = _pick(chart, _PUBLIC_CHART_KEYS)
    if not isinstance(dto.get("sections"), list):
        raise ShareNotFound()
    dto["sections"] = [
        s for s in (_public_section(s) for s in dto["sections"]) if s is not None
    ]
    if isinstance(dto.get("arrangement"), list):
        dto["arrangement"] = [
            _pick(step, _PUBLIC_STEP_KEYS)
            for step in dto["arrangement"]
            if isinstance(step, dict)
        ]
    else:
        dto.pop("arrangement", None)
    if not isinstance(dto.get("settings"), dict):
        dto["settings"] = {}
    return dto


# ---------------------------------------------------------------- app


def _etag(content_hash: str, page: int) -> str:
    return f'"{content_hash}:{page}:{_SCALE_TAG}:{_RENDERER_VERSION}"'


def _matches(if_none_match: str | None, etag: str) -> bool:
    """Exact match only. The one client that matters is a browser echoing back the ETag we
    just handed it, so the RFC's list and weak-comparison syntax is unearned; `*` is left
    out deliberately, since it would hand a 304 to a client that never saw the ETag."""
    return if_none_match is not None and if_none_match.strip() == etag


def _not_modified(etag: str) -> Response:
    return Response(
        status_code=304, headers={"Cache-Control": "private, no-cache", "ETag": etag}
    )


def _png_response(data: bytes, etag: str) -> Response:
    return Response(
        content=data,
        media_type="image/png",
        headers={"Cache-Control": "private, no-cache", "ETag": etag},
    )


def _throttled() -> Response:
    return Response(
        content=b"Too many requests",
        status_code=429,
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "no-store", "Retry-After": "60"},
    )


def _serve_png(
    cfg: Config, request: Request, token: str, row: sqlite3.Row, index: int, render
) -> Response:
    """The shared tail of both image routes, reached only once the token gate and
    reachability have passed.

    Order is load-bearing: the source is resolved BEFORE the conditional request is
    considered, because a 304 claims the guest's cached copy is still good and that would
    be a lie for a file that has left the disk while its row lingered. Throttling counts
    render misses only, since a hit is just a file read.
    """
    path = library_path(cfg, row["filename"])
    etag = _etag(row["content_hash"], index)
    if _matches(request.headers.get("If-None-Match"), etag):
        return _not_modified(etag)
    key = f"{row['content_hash']}:{index}:{_SCALE_TAG}:{_RENDERER_VERSION}"
    if not cache_path(cfg, key).exists() and not allow_miss(client_ip(request), token):
        return _throttled()
    return _png_response(cached_render(cfg, key, lambda: render(path)), etag)


@asynccontextmanager
async def _lifespan(app: FastAPI):
    # Read the settings once at boot, so one nobody can understand (a typo in
    # BANDSTAND_EVENTS_KEY_IN_URL, say) stops this process from starting instead of
    # failing every stream open behind the member door. Nothing is kept: the public
    # app reads its config per request, as before.
    config.load()
    yield


def build_public_app() -> FastAPI:
    app = FastAPI(
        title="Bandstand share", docs_url=None, redoc_url=None, openapi_url=None,
        lifespan=_lifespan,
    )
    from server.api.member_access import router as member_router
    app.include_router(member_router)
    # Belt to the PM2 --no-access-log braces: every path on this app carries a bearer token,
    # so silence the access log from inside the process too. Otherwise a dev run, or the
    # playtest harness, writes live share tokens to disk.
    logging.getLogger("uvicorn.access").disabled = True

    @app.exception_handler(ShareNotFound)
    async def _share_not_found(request: Request, exc: ShareNotFound) -> Response:
        return not_found_response()

    @app.exception_handler(RenderBusy)
    async def _render_busy(request: Request, exc: RenderBusy) -> Response:
        return _throttled()

    @app.exception_handler(StarletteHTTPException)
    async def _http_exception(request: Request, exc: StarletteHTTPException) -> Response:
        # Unrouted paths and missing guest assets answer with the same page, so the shape
        # of the app is not readable from the outside either.
        if exc.status_code == 404:
            return not_found_response()
        return Response(
            content=str(exc.detail).encode("utf-8"),
            status_code=exc.status_code,
            media_type="text/plain; charset=utf-8",
            headers={"Cache-Control": "no-store"},
        )

    @app.middleware("http")
    async def _guest_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive"
        # Renders are decoded on this server, so a mislabelled file must never be sniffed
        # into something executable in the guest's browser.
        response.headers["X-Content-Type-Options"] = "nosniff"
        # HTML responses set their own policy carrying that response's nonce; everything
        # else (PNG, JSON, 304) gets the nonce-free base, which allows nothing at all.
        if request.url.path == '/app' or request.url.path.startswith('/app/'):
            response.headers.setdefault('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
        else:
            response.headers.setdefault("Content-Security-Policy", _CSP_STATIC)
        return response

    @app.get("/health")
    def health() -> Response:
        # For the container health probe. Says whether the library can be read and
        # nothing else: no name, no version, no counts. Strangers can reach this.
        ok = True
        try:
            conn = db.connect_ro(config.load().db_path)
            try:
                conn.execute("SELECT COUNT(*) FROM shares").fetchone()
            finally:
                conn.close()
        except (sqlite3.Error, OSError, ValueError):
            ok = False
        return Response(
            content=json.dumps({"ok": ok}).encode("utf-8"),
            status_code=200 if ok else 503,
            media_type="application/json",
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/s/{token}")
    def landing(token: str, request: Request) -> Response:
        cfg = config.load()
        nonce = _nonce()
        with share_gate(cfg, request, token) as (conn, share):
            if share["target_kind"] == "setlist":
                return _html_response(setlist_landing(conn, share, token, nonce), nonce)
            # A piece share has one destination, so skip the list and open it.
            return _html_response(
                piece_page(conn, share, token, share["target_id"], nonce), nonce
            )

    @app.get("/s/{token}/piece/{piece_id}")
    def piece(token: str, piece_id: str, request: Request) -> Response:
        cfg = config.load()
        nonce = _nonce()
        with share_gate(cfg, request, token) as (conn, share):
            if not piece_reachable(conn, share, piece_id):
                raise ShareNotFound()
            return _html_response(piece_page(conn, share, token, piece_id, nonce), nonce)

    @app.get("/s/{token}/chart/{piece_id}")
    def chart(token: str, piece_id: str, request: Request) -> Response:
        cfg = config.load()
        with share_gate(cfg, request, token) as (conn, share):
            if not piece_reachable(conn, share, piece_id):
                raise ShareNotFound()
            row = conn.execute(
                "SELECT chart_json FROM pieces WHERE id = ? AND kind = 'chart' "
                "AND deleted_at IS NULL",
                (piece_id,),
            ).fetchone()
            if row is None or not row["chart_json"]:
                raise ShareNotFound()
            try:
                chart_obj = json.loads(row["chart_json"])
            except ValueError:
                raise ShareNotFound() from None
            return Response(
                content=json.dumps(public_chart(chart_obj)).encode("utf-8"),
                media_type="application/json",
                headers={"Cache-Control": "no-store"},
            )

    @app.get("/s/{token}/p/{file_id}/{page}.png")
    def pdf_page(token: str, file_id: str, page: str, request: Request) -> Response:
        cfg = config.load()
        with share_gate(cfg, request, token) as (conn, share):
            # Parsed by hand rather than declared `page: int` so a non-numeric page is a
            # 404 like everything else, and so the token gate still runs first.
            if not _PAGE_RE.fullmatch(page):
                raise ShareNotFound()
            index = int(page)
            row = _reachable_file(conn, share, file_id, "pdf")
            if not 0 <= index < (row["page_count"] or 0):
                raise ShareNotFound()
            return _serve_png(
                cfg, request, token, row, index,
                lambda path: render_pdf_page(path, index),
            )

    @app.get("/s/{token}/img/{file_id}.png")
    def image_file(token: str, file_id: str, request: Request) -> Response:
        cfg = config.load()
        with share_gate(cfg, request, token) as (conn, share):
            row = _reachable_file(conn, share, file_id, "image")
            return _serve_png(cfg, request, token, row, 0, render_image)

    if _STATIC_GUEST.is_dir():
        # StaticFiles resolves and contains within the directory itself. Absent before the
        # guest bundle is first built, which is fine: the chart shell just 404s its assets.
        app.mount("/guest", StaticFiles(directory=_STATIC_GUEST), name="guest")

    return app


app = build_public_app()
