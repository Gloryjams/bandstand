import shutil
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server import config, db
from server.ingest import pipeline

FIXTURES = Path(__file__).parent / "fixtures"


def _setup(tmp_data_dir):
    from server.main import build_app
    cfg = config.load()
    db.bootstrap(cfg)
    target = cfg.library_dir / "Take Five.pdf"
    shutil.copy(FIXTURES / "three_page_titled.pdf", target)
    pipeline.ingest_path(cfg, target)
    key = cfg.key_path.read_text().strip()
    return TestClient(build_app()), key, cfg


def _piece_id(cfg) -> str:
    conn = db.connect(cfg.db_path)
    try:
        return conn.execute("SELECT id FROM pieces").fetchone()["id"]
    finally:
        conn.close()


def _make_setlist(cfg, piece_id: str, setlist_id: str = "SL1") -> str:
    now = int(time.time() * 1000)
    conn = db.connect(cfg.db_path)
    try:
        conn.execute(
            "INSERT INTO setlists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (setlist_id, "Friday at the Blue Room", now, now),
        )
        conn.execute(
            "INSERT INTO setlist_items (id, setlist_id, kind, piece_id, ordinal) "
            "VALUES (?, ?, 'piece', ?, 0)",
            (f"{setlist_id}-i0", setlist_id, piece_id),
        )
    finally:
        conn.close()
    return setlist_id


def _auth(key):
    return {"X-Bandstand-Key": key}


def test_create_share_for_piece(tmp_data_dir, monkeypatch):
    monkeypatch.setenv("BANDSTAND_PUBLIC_BASE", "https://share.example/")
    client, key, cfg = _setup(tmp_data_dir)
    r = client.post(
        "/api/shares",
        json={"target_kind": "piece", "target_id": _piece_id(cfg), "ttl_hours": 24},
        headers=_auth(key),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["url"] == f"https://share.example/s/{body['token']}"
    assert len(body["token"]) >= 30
    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute("SELECT * FROM shares WHERE id = ?", (body["id"],)).fetchone()
    finally:
        conn.close()
    assert row["label"] == "Take Five"
    assert row["expires_at"] > row["created_at"]


@pytest.mark.parametrize("value", [None, "", "   "])
def test_no_link_is_made_when_share_pages_are_not_set_up(tmp_data_dir, monkeypatch, value):
    # The old default was this computer's own loopback address. The app handed the
    # director a link and a QR code that no guest could open, and said nothing.
    if value is None:
        monkeypatch.delenv("BANDSTAND_PUBLIC_BASE", raising=False)
    else:
        monkeypatch.setenv("BANDSTAND_PUBLIC_BASE", value)
    client, key, cfg = _setup(tmp_data_dir)
    r = client.post(
        "/api/shares",
        json={"target_kind": "piece", "target_id": _piece_id(cfg), "ttl_hours": None},
        headers=_auth(key),
    )
    assert r.status_code == 503
    assert "Share pages are not set up on this server" in r.json()["detail"]
    assert "127.0.0.1" not in r.text
    conn = db.connect(cfg.db_path)
    try:
        assert conn.execute("SELECT COUNT(*) FROM shares").fetchone()[0] == 0
    finally:
        conn.close()
    # Listing and revoking what already exists keep working.
    assert client.get("/api/shares", headers=_auth(key)).status_code == 200


def test_not_set_up_is_still_director_only(tmp_data_dir, monkeypatch):
    monkeypatch.delenv("BANDSTAND_PUBLIC_BASE", raising=False)
    client, _key, cfg = _setup(tmp_data_dir)
    r = client.post(
        "/api/shares",
        json={"target_kind": "piece", "target_id": _piece_id(cfg), "ttl_hours": None},
    )
    assert r.status_code == 401


def test_create_share_without_ttl_never_expires(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    r = client.post(
        "/api/shares",
        json={"target_kind": "piece", "target_id": _piece_id(cfg), "ttl_hours": None},
        headers=_auth(key),
    )
    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute(
            "SELECT expires_at FROM shares WHERE id = ?", (r.json()["id"],)
        ).fetchone()
    finally:
        conn.close()
    assert row["expires_at"] is None


def test_create_share_for_setlist_uses_its_name(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    setlist_id = _make_setlist(cfg, _piece_id(cfg))
    r = client.post(
        "/api/shares",
        json={"target_kind": "setlist", "target_id": setlist_id, "ttl_hours": 1},
        headers=_auth(key),
    )
    assert r.status_code == 200
    conn = db.connect(cfg.db_path)
    try:
        label = conn.execute(
            "SELECT label FROM shares WHERE id = ?", (r.json()["id"],)
        ).fetchone()["label"]
    finally:
        conn.close()
    assert label == "Friday at the Blue Room"


def test_create_share_rejects_unknown_target(tmp_data_dir):
    client, key, _ = _setup(tmp_data_dir)
    r = client.post(
        "/api/shares",
        json={"target_kind": "piece", "target_id": "NOPE", "ttl_hours": 1},
        headers=_auth(key),
    )
    assert r.status_code == 404


def test_create_share_rejects_soft_deleted_piece(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    piece_id = _piece_id(cfg)
    conn = db.connect(cfg.db_path)
    try:
        conn.execute("UPDATE pieces SET deleted_at = 1 WHERE id = ?", (piece_id,))
    finally:
        conn.close()
    r = client.post(
        "/api/shares",
        json={"target_kind": "piece", "target_id": piece_id, "ttl_hours": 1},
        headers=_auth(key),
    )
    assert r.status_code == 404


def test_create_share_rejects_bad_kind_and_ttl(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    piece_id = _piece_id(cfg)
    assert client.post(
        "/api/shares",
        json={"target_kind": "album", "target_id": piece_id},
        headers=_auth(key),
    ).status_code == 400
    assert client.post(
        "/api/shares",
        json={"target_kind": "piece", "target_id": ""},
        headers=_auth(key),
    ).status_code == 422
    assert client.post(
        "/api/shares",
        json={"target_kind": "piece", "target_id": piece_id, "ttl_hours": 0},
        headers=_auth(key),
    ).status_code == 400
    assert client.post(
        "/api/shares",
        json={"target_kind": "piece", "target_id": piece_id, "ttl_hours": "forever"},
        headers=_auth(key),
    ).status_code == 400


@pytest.mark.parametrize(
    "ttl_literal",
    [
        "1e309",                             # parses to inf; int(inf * ...) would raise
        "1" + "0" * 30,                      # enormous int, rejected before any arithmetic
        "87601",                             # one hour past the ten-year ceiling
        "1e308",                             # finite, but overflows SQLite's INTEGER
    ],
)
def test_an_unreasonable_ttl_is_a_400_not_a_500(tmp_data_dir, ttl_literal):
    # Posted as a raw body: httpx refuses to serialize inf, so json={...} would fail in the
    # client and never exercise the server at all.
    client, key, cfg = _setup(tmp_data_dir)
    body = (
        '{"target_kind": "piece", "target_id": "%s", "ttl_hours": %s}'
        % (_piece_id(cfg), ttl_literal)
    )
    r = client.post(
        "/api/shares",
        content=body,
        headers={**_auth(key), "Content-Type": "application/json"},
    )
    assert r.status_code == 400
    conn = db.connect(cfg.db_path)
    try:
        assert conn.execute("SELECT COUNT(*) FROM shares").fetchone()[0] == 0
    finally:
        conn.close()


def test_nan_ttl_is_rejected():
    # NaN loses every comparison, so the positivity and ceiling checks both pass it
    # through; only the isfinite guard stops it before int() raises. JSON cannot carry NaN,
    # so this goes at the validator directly.
    from fastapi import HTTPException

    from server.api.shares import _ttl_to_expiry
    with pytest.raises(HTTPException) as excinfo:
        _ttl_to_expiry(float("nan"), 0)
    assert excinfo.value.status_code == 400


def test_the_longest_allowed_ttl_still_works(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    r = client.post(
        "/api/shares",
        json={"target_kind": "piece", "target_id": _piece_id(cfg), "ttl_hours": 87600},
        headers=_auth(key),
    )
    assert r.status_code == 200
    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute(
            "SELECT expires_at FROM shares WHERE id = ?", (r.json()["id"],)
        ).fetchone()
    finally:
        conn.close()
    assert row["expires_at"] > int(time.time() * 1000)


def test_failed_create_leaves_no_row(tmp_data_dir):
    # The validation and the insert share one transaction, so a rejected target must not
    # leave a half-written share behind.
    client, key, cfg = _setup(tmp_data_dir)
    client.post(
        "/api/shares",
        json={"target_kind": "setlist", "target_id": "GONE", "ttl_hours": 1},
        headers=_auth(key),
    )
    conn = db.connect(cfg.db_path)
    try:
        assert conn.execute("SELECT COUNT(*) FROM shares").fetchone()[0] == 0
    finally:
        conn.close()


def test_create_retries_once_on_token_collision(tmp_data_dir, monkeypatch):
    client, key, cfg = _setup(tmp_data_dir)
    piece_id = _piece_id(cfg)
    conn = db.connect(cfg.db_path)
    try:
        conn.execute(
            "INSERT INTO shares (id, token, target_kind, target_id, label, created_at) "
            "VALUES ('sitting', 'collide', 'piece', ?, 'L', 1)",
            (piece_id,),
        )
    finally:
        conn.close()

    from server.api import shares
    tokens = iter(["collide", "fresh-token-value"])
    monkeypatch.setattr(shares.secrets, "token_urlsafe", lambda n: next(tokens))
    r = client.post(
        "/api/shares",
        json={"target_kind": "piece", "target_id": piece_id, "ttl_hours": 1},
        headers=_auth(key),
    )
    assert r.status_code == 200
    assert r.json()["token"] == "fresh-token-value"


def test_create_gives_up_after_the_second_collision(tmp_data_dir, monkeypatch):
    client, key, cfg = _setup(tmp_data_dir)
    piece_id = _piece_id(cfg)
    conn = db.connect(cfg.db_path)
    try:
        conn.execute(
            "INSERT INTO shares (id, token, target_kind, target_id, label, created_at) "
            "VALUES ('sitting', 'collide', 'piece', ?, 'L', 1)",
            (piece_id,),
        )
    finally:
        conn.close()

    from server.api import shares
    monkeypatch.setattr(shares.secrets, "token_urlsafe", lambda n: "collide")
    # raise_server_exceptions=False so this asserts ONE outcome (a 5xx) rather than
    # branching on whether the client re-raises.
    from server.main import build_app
    lenient = TestClient(build_app(), raise_server_exceptions=False)
    r = lenient.post(
        "/api/shares",
        json={"target_kind": "piece", "target_id": piece_id, "ttl_hours": 1},
        headers=_auth(key),
    )
    assert r.status_code >= 500
    conn = db.connect(cfg.db_path)
    try:
        assert conn.execute("SELECT COUNT(*) FROM shares").fetchone()[0] == 1
    finally:
        conn.close()


def test_list_shares_states_and_order(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    piece_id = _piece_id(cfg)
    now = int(time.time() * 1000)
    conn = db.connect(cfg.db_path)
    try:
        rows = [
            ("old", "t-old", now - 3000, None, None),
            ("expired", "t-exp", now - 2000, now - 1, None),
            ("revoked", "t-rev", now - 1000, None, now - 5),
        ]
        for share_id, token, created, expires, revoked in rows:
            conn.execute(
                "INSERT INTO shares "
                "(id, token, target_kind, target_id, label, created_at, expires_at, revoked_at) "
                "VALUES (?, ?, 'piece', ?, 'L', ?, ?, ?)",
                (share_id, token, piece_id, created, expires, revoked),
            )
    finally:
        conn.close()
    body = client.get("/api/shares", headers=_auth(key)).json()
    assert [s["id"] for s in body] == ["revoked", "expired", "old"]
    assert [s["state"] for s in body] == ["revoked", "expired", "active"]
    # No token, and no url built from one: this response is fetched on every Settings
    # open, and a live bearer credential has no business riding along in a list.
    for row in body:
        assert "token" not in row
        assert "url" not in row
    assert set(body[0]) == {
        "id", "target_kind", "target_id", "label",
        "created_at", "expires_at", "revoked_at", "state",
    }


def test_revoke_sets_revoked_at_and_is_idempotent(tmp_data_dir):
    client, key, cfg = _setup(tmp_data_dir)
    created = client.post(
        "/api/shares",
        json={"target_kind": "piece", "target_id": _piece_id(cfg), "ttl_hours": 24},
        headers=_auth(key),
    ).json()
    revoke_url = f"/api/shares/{created['id']}/revoke"
    assert client.post(revoke_url, headers=_auth(key)).status_code == 200
    first = client.get("/api/shares", headers=_auth(key)).json()[0]
    assert first["state"] == "revoked"
    assert first["revoked_at"] is not None

    # Revoking twice is the same outcome, and must not move the timestamp. Asserted
    # through the list rather than a response body the client never reads.
    assert client.post(revoke_url, headers=_auth(key)).status_code == 200
    again = client.get("/api/shares", headers=_auth(key)).json()[0]
    assert again["state"] == "revoked"
    assert again["revoked_at"] == first["revoked_at"]


def test_revoke_unknown_share_is_404(tmp_data_dir):
    client, key, _ = _setup(tmp_data_dir)
    assert client.post("/api/shares/NOPE/revoke", headers=_auth(key)).status_code == 404


def test_share_routes_require_auth(tmp_data_dir):
    client, _, cfg = _setup(tmp_data_dir)
    assert client.get("/api/shares").status_code == 401
    assert client.post(
        "/api/shares", json={"target_kind": "piece", "target_id": _piece_id(cfg)}
    ).status_code == 401
    assert client.post("/api/shares/x/revoke").status_code == 401
