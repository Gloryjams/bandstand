from collections.abc import Callable
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse

from server import config, db, instance_lock, share_access
from server.backup import BackupScheduler
from server.body_limit import BodyLimitMiddleware
from server.api import (
    annotations, bookmarks, charts_sync, events, files, health, manifest, member_invites, my_notes, pieces, placeholders, rooms,
    section_links, setlists, shares, sync, transfer, upload, upload_chart, upload_setlist, whoami, workspaces,
)
from server.ingest.watcher import Watcher

_STATIC_APP = Path(__file__).parent / "static" / "app"
_STATIC_CHARTS = Path(__file__).parent / "static" / "charts"
_STATIC_ROOM = Path(__file__).parent / "static" / "room"


def chart_editor_installed() -> bool:
    """True when the optional chart editor bundle is built into this install.

    Checked per call, like the bundle mount itself, so an editor added or removed
    after startup is reported without a restart. /api/health carries the answer so
    the app can hide its "New chart" link instead of sending a director to the
    "not installed" page.
    """
    return (_STATIC_CHARTS / "index.html").is_file()


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = config.load()
    # One server per data folder, whichever way this app was started. Held until
    # the process ends; a second server on the same folder fails right here.
    lock = instance_lock.acquire(cfg.data_dir)
    try:
        db.bootstrap(cfg)
        watcher = Watcher(cfg)
        watcher.start()
        backups = BackupScheduler(cfg)
        backups.start()
        # Only when share pages are switched on: see server/share_access.py.
        sharing = share_access.ShareAccess(cfg) if share_access.enabled() else None
        if sharing:
            sharing.start()
        else:
            share_access.close_again(cfg)
        try:
            yield
        finally:
            watcher.stop()
            backups.stop()
            if sharing:
                sharing.stop()
    finally:
        instance_lock.release(lock)


# Shown at /charts when the optional chart editor was not built into this install.
# Self-contained on purpose (inline style, no assets): the bundle that would carry
# its own styling is exactly the thing that is missing.
_CHARTS_MISSING_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Chart editor not installed</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
background:#FFF5F9;color:#2C2233;line-height:1.5}
main{max-width:34rem;margin:0 auto;padding:12vh 1.25rem 3rem}
h1{font-size:1.5rem;line-height:1.25;margin:0 0 1rem}
p{margin:0 0 1rem}
code{background:#FFE0F0;border-radius:.3rem;padding:.1rem .35rem;font-size:.9em}
a{color:#B8325F;font-weight:700}
</style></head><body><main>
<h1>The chart editor is not installed on this server</h1>
<p>Bandstand itself is running normally. Your library, setlists and audio all work.</p>
<p>The chart editor, SaltyCharts, is a separate optional app. It was not included
when this server was built, so there is nothing to show at this address yet.</p>
<p>Whoever runs this server can add it by following
<code>docs/SELF-HOSTING.md</code>, section "Adding the chart editor".</p>
<p><a href="/app/">Back to Bandstand</a></p>
</main></body></html>
"""


# Shown at /room while rehearsal rooms are switched off (BANDSTAND_ROOMS unset).
# Written for the guest who scanned a QR code, not for the operator.
_ROOMS_OFF_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Rehearsal rooms are switched off</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
background:#FFF5F9;color:#2C2233;line-height:1.5}
main{max-width:34rem;margin:0 auto;padding:12vh 1.25rem 3rem}
h1{font-size:1.5rem;line-height:1.25;margin:0 0 1rem}
p{margin:0 0 1rem}
code{background:#FFE0F0;border-radius:.3rem;padding:.1rem .35rem;font-size:.9em}
</style></head><body><main>
<h1>Rehearsal rooms are switched off on this server</h1>
<p>This link would open a rehearsal room, but the person who runs this Bandstand
server has not switched rooms on.</p>
<p>If that is you: set <code>BANDSTAND_ROOMS=1</code> and start the server again.
<code>docs/SELF-HOSTING.md</code>, section "Rehearsal rooms", has the details.</p>
</main></body></html>
"""


def _serve_bundle(
    app: FastAPI,
    prefix: str,
    directory: Path,
    entrypoint: str = "index.html",
    missing_html: str | None = None,
    switched_off: Callable[[], str | None] | None = None,
) -> None:
    """Serve a built PWA bundle at {prefix}/* so devices load it same-origin.

    Real asset requests get the file; everything else falls back to index.html so
    client-side routes work on a hard refresh. HTML/JSON and the service worker
    revalidate (no-cache) so UI changes ship without a PWA reinstall; content-hashed
    assets stay cacheable. Routes register even when the bundle isn't built yet —
    the bundle is checked per-request, so a later client build shows up without a
    server restart; until then the prefix answers 404.

    `missing_html` is for an OPTIONAL bundle: while it is absent, page requests get
    that explanation (still a 404, so nothing caches or installs it) instead of a
    bare error. Asset requests keep the plain 404.

    `switched_off` is for a bundle behind a SETTING: called per request, it returns
    the page to show (as a 404) while the feature is off, or None when it is on.
    """

    root = directory.resolve()
    slug = prefix.strip("/")

    def off_page():  # type: ignore[no-untyped-def]
        html = switched_off() if switched_off else None
        if html is None:
            return None
        return HTMLResponse(html, status_code=404, headers={"Cache-Control": "no-store"})

    def index():  # type: ignore[no-untyped-def]
        if (off := off_page()) is not None:
            return off
        entry = root / entrypoint
        if not entry.exists():
            if missing_html is not None:
                return HTMLResponse(
                    missing_html, status_code=404, headers={"Cache-Control": "no-store"}
                )
            raise HTTPException(status_code=404, detail="Not Found")
        return FileResponse(entry, headers={"Cache-Control": "no-cache"})

    @app.get(prefix, name=f"bundle_{slug}_root")
    @app.get(prefix + "/", name=f"bundle_{slug}_slash")
    def bundle_root():  # type: ignore[no-untyped-def]
        return index()

    @app.get(prefix + "/{path:path}", name=f"bundle_{slug}_path")
    def bundle_path(path: str):  # type: ignore[no-untyped-def]
        # Nothing hidden is ever served: a bundle folder that was copied from a
        # working directory can carry a .git folder or a credentials file.
        if any(part.startswith(".") for part in path.split("/")):
            raise HTTPException(status_code=404, detail="Not Found")
        if switched_off and switched_off() is not None:
            # Off means off: no asset of the bundle is served either.
            return index()
        candidate = (root / path).resolve()
        if candidate.is_file() and root in candidate.parents:
            revalidate = candidate.suffix in {".html", ".json", ".webmanifest"} or candidate.name in {
                "sw.js",
                "registerSW.js",
            }
            headers = {"Cache-Control": "no-cache"} if revalidate else None
            return FileResponse(candidate, headers=headers)
        # Missing FILES (dotted last segment — e.g. a stale content-hashed
        # asset requested by an open tab after a rebuild) get a real 404;
        # serving index.html there hands HTML to a <script> parser. Only
        # extensionless paths are client-side routes that fall back.
        if "." in path.rsplit("/", 1)[-1]:
            raise HTTPException(status_code=404, detail="Not Found")
        return index()


def build_app() -> FastAPI:
    # Docs/schema surfaces stay off (matches public.py): the demo instance faces
    # the internet, and a keyless client has no business enumerating the API.
    app = FastAPI(
        title="Bandstand", version=health.VERSION, lifespan=lifespan,
        docs_url=None, redoc_url=None, openapi_url=None,
    )

    # Size ceilings and the key check for large uploads happen BEFORE a request body
    # is read. See server/body_limit.py. Added before CORS so that CORS wraps it and
    # a refusal still reaches a cross-origin caller as a readable response.
    app.add_middleware(BodyLimitMiddleware)
    # Saltycharts authors charts in a separate app and POSTs them cross-origin. Every
    # endpoint is key-authed (a custom header, not a cookie), and this is a single-user
    # LAN/Tailscale server, so a permissive CORS policy is safe: it only lets the browser
    # deliver the request; the key still gates the action. allow_credentials stays False
    # so the "*" origin is legal.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
        allow_credentials=False,
    )
    for r in (
        health.router, manifest.router, files.router, pieces.router,
        annotations.router, bookmarks.router, section_links.router,
        setlists.router, upload.router, upload_chart.router, upload_setlist.router,
        charts_sync.router, sync.router, events.router, shares.router, whoami.router,
        rooms.router, transfer.router, workspaces.router, member_invites.router, my_notes.router, placeholders.router,
    ):
        app.include_router(r)

    @app.get("/", include_in_schema=False)
    def root():  # type: ignore[no-untyped-def]
        # Somebody typed only the address and the port. Take them to the app.
        return RedirectResponse("/app/", status_code=307)

    _serve_bundle(app, "/app", _STATIC_APP)
    # Saltycharts, absorbed: the chart author ships same-origin so its
    # send-to-Bandstand POSTs need no absolute URL (and the https→http
    # mixed-content block a separately hosted https deploy hits doesn't apply here).
    # Built by `npm run build:bandstand` in apps/saltycharts.
    # Optional: it lives in its own repository, so an install may not have it.
    _serve_bundle(app, "/charts", _STATIC_CHARTS, missing_html=_CHARTS_MISSING_HTML)
    # Rehearsal QR guests get a tiny no-PWA bundle with no workspace credential.
    # Behind BANDSTAND_ROOMS, like every /room-api and /api/rooms route.
    _serve_bundle(
        app, "/room", _STATIC_ROOM, "room.html",
        switched_off=lambda: None if config.load().rooms_enabled else _ROOMS_OFF_HTML,
    )
    return app


app = build_app()
