import hmac

from fastapi import Header, HTTPException, status

from server import config, db
from server.members import ROOT, Identity, find_by_key


def identity_for(sent: str | None) -> Identity:
    """Resolve a presented key to an Identity, or raise 401.

    Precedence: the `.key` file (root director — compared first, no DB hit, exactly
    the pre-members fast path) then the members table (active rows only). Unknown or
    revoked keys are indistinguishable from wrong keys: plain 401.
    """
    cfg = config.load()
    if not cfg.key_path.exists():
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Server not initialized")
    expected = cfg.key_path.read_text().strip()
    # Refuse to run with a missing/truncated key rather than trust a weak one
    # (a partial write could otherwise become a guessable password).
    if len(expected) < 32:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Server key not initialized")
    if not sent:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or missing key")
    if hmac.compare_digest(sent, expected):
        return ROOT
    conn = db.connect(cfg.db_path)
    try:
        member = find_by_key(conn, sent)
    finally:
        conn.close()
    if member is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or missing key")
    return member


def require_identity(x_bandstand_key: str | None = Header(default=None)) -> Identity:
    """Any active identity (director or member). Use on READ routes members may hit."""
    return identity_for(x_bandstand_key)


def require_key(x_bandstand_key: str | None = Header(default=None)) -> Identity:
    """Director only. Every pre-members route used this dependency, so the whole
    write surface fails closed: a member key authenticates (it's a real identity)
    but is 403'd here; reads are then explicitly opened via require_identity."""
    ident = identity_for(x_bandstand_key)
    if not ident.is_director:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Director key required")
    return ident


# Alias so intent reads correctly at new call sites.
require_director = require_key
