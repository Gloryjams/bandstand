"""Band members: identity resolution, role gating, and the management CLI.

The load-bearing test here is the parametrized write-route sweep: every mutating
/api route must 403 a member key. It walks the app's real route table, so a future
write route added without a director gate fails the suite instead of shipping open.
"""

import sqlite3

from fastapi.testclient import TestClient

from server import config, db, members


def _setup(tmp_data_dir):
    from server.main import build_app

    cfg = config.load()
    db.bootstrap(cfg)
    app = build_app()
    director_key = cfg.key_path.read_text().strip()
    conn = db.connect(cfg.db_path)
    ident, member_key = members.add_member(conn, "Rea", "member")
    conn.close()
    return TestClient(app), cfg, director_key, member_key, ident


# ---------- CLI / model ----------

def test_add_member_stores_hash_not_key(conn):
    ident, key = members.add_member(conn, "Rea")
    row = conn.execute("SELECT * FROM members WHERE id = ?", (ident.id,)).fetchone()
    assert row["key_hash"] == members.key_hash(key)
    assert key not in dict(row).values()
    assert row["role"] == "member"
    assert len(key) == 64


def test_find_by_key_roundtrip_and_revoke(conn):
    ident, key = members.add_member(conn, "Liam")
    assert members.find_by_key(conn, key) == ident
    assert members.revoke_member(conn, ident.id) is True
    assert members.find_by_key(conn, key) is None
    # Revoking twice is a no-op, not an error.
    assert members.revoke_member(conn, ident.id) is False


def test_rotate_revokes_old_key_and_mints_new(conn):
    ident, old_key = members.add_member(conn, "Louis")
    result = members.rotate_member(conn, ident.id)
    assert result is not None
    new_ident, new_key = result
    assert new_key != old_key
    assert members.find_by_key(conn, old_key) is None
    found = members.find_by_key(conn, new_key)
    assert found is not None and found.name == "Louis" and found.role == "member"
    assert members.rotate_member(conn, "nonexistent") is None


def test_duplicate_key_hash_rejected(conn):
    # UNIQUE(key_hash) is the collision backstop; astronomically unlikely, but the
    # constraint must actually be there.
    ident, key = members.add_member(conn, "Anya")
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "INSERT INTO members (id, name, role, key_hash, created_at) "
            "VALUES ('x', 'Evil', 'member', ?, 0)",
            (members.key_hash(key),),
        )
        conn.execute("COMMIT")
        raise AssertionError("duplicate key_hash accepted")
    except sqlite3.IntegrityError:
        conn.execute("ROLLBACK")


# ---------- identity resolution / whoami ----------

def test_whoami_director(tmp_data_dir):
    client, _, director_key, _, _ = _setup(tmp_data_dir)
    r = client.get("/api/whoami", headers={"X-Bandstand-Key": director_key})
    assert r.status_code == 200
    assert r.json() == {"id": "root", "name": "Director", "role": "director"}


def test_whoami_member(tmp_data_dir):
    client, _, _, member_key, ident = _setup(tmp_data_dir)
    r = client.get("/api/whoami", headers={"X-Bandstand-Key": member_key})
    assert r.status_code == 200
    assert r.json() == {"id": ident.id, "name": "Rea", "role": "member"}


def test_whoami_unknown_key_401(tmp_data_dir):
    client, _, _, _, _ = _setup(tmp_data_dir)
    assert client.get("/api/whoami").status_code == 401
    assert client.get(
        "/api/whoami", headers={"X-Bandstand-Key": "f" * 64}
    ).status_code == 401


def test_revoked_member_key_is_401_everywhere(tmp_data_dir):
    client, cfg, _, member_key, ident = _setup(tmp_data_dir)
    conn = db.connect(cfg.db_path)
    members.revoke_member(conn, ident.id)
    conn.close()
    for path in ("/api/whoami", "/api/manifest"):
        assert client.get(path, headers={"X-Bandstand-Key": member_key}).status_code == 401


def test_truncated_key_file_still_refuses_members(tmp_data_dir):
    # The weak-.key refusal must hold even when the presented key is a valid member
    # key: a corrupt root credential means the instance is not trustworthy.
    client, cfg, _, member_key, _ = _setup(tmp_data_dir)
    cfg.key_path.write_text("abc")
    r = client.get("/api/manifest", headers={"X-Bandstand-Key": member_key})
    assert r.status_code == 401


# ---------- member read access ----------

def test_member_can_read_manifest_and_events_auth(tmp_data_dir):
    client, _, _, member_key, _ = _setup(tmp_data_dir)
    r = client.get("/api/manifest", headers={"X-Bandstand-Key": member_key})
    assert r.status_code == 200
    assert r.json()["pieces"] == []
    # SSE: assert the auth layer accepts the member key (401 for garbage). Reading
    # the infinite stream itself is covered by the events tests / playtest driver.
    from server.api.events import events  # noqa: F401 — route exists
    from server import auth
    ident = auth.identity_for(member_key)
    assert ident.role == "member"


def test_member_can_fetch_file_blobs(tmp_data_dir):
    # 404 (row not found) not 401/403: the auth dependency admitted the member.
    client, _, _, member_key, _ = _setup(tmp_data_dir)
    ulid = "0" * 26
    for path in (f"/api/file/{ulid}/{ulid}", f"/api/audio/{ulid}/{ulid}",
                 f"/api/thumb/{ulid}"):
        r = client.get(path, headers={"X-Bandstand-Key": member_key})
        assert r.status_code == 404, path


# ---------- the write-surface sweep ----------

_MEMBER_READABLE = {
    ("GET", "/api/manifest"),
    ("GET", "/api/whoami"),
    ("GET", "/api/health"),
    ("GET", "/api/events"),
    # A POST, but it writes nothing: it hands out the one-minute ticket that opens
    # the stream above, and members subscribe to that stream (test_stream_ticket.py).
    ("POST", "/api/events/ticket"),
    ("GET", "/api/file/{piece_id}/{file_id}"),
    ("GET", "/api/audio/{piece_id}/{track_id}"),
    ("GET", "/api/thumb/{piece_id}"),
    ("GET", "/api/rooms/active"),
    ("GET", "/api/rooms/{room_id}"),
    # Private notes are a member feature (migration 0007). The route returns only
    # the caller's own rows; isolation is proven in test_api_my_notes.py.
    ("GET", "/api/my-notes"),
}

# The ONLY writes a member may make. Every entry here must resolve its owner from
# the authenticated identity and never from anything the client sends. Adding a
# route to this set without an isolation test in test_api_my_notes.py (or a sibling)
# is a review failure.
_MEMBER_OWN_WRITES = {
    ("PUT", "/api/my-notes/{piece_id}"),
}


def _api_routes(app):
    # This FastAPI version wraps include_router() targets in nested router objects,
    # so walk the tree generically instead of assuming a flat list of APIRoute.
    from fastapi.routing import APIRoute

    def walk(routes):
        for route in routes:
            if isinstance(route, APIRoute):
                if route.path.startswith("/api/"):
                    for method in route.methods - {"HEAD", "OPTIONS"}:
                        yield method, route.path
            elif hasattr(route, "routes"):
                yield from walk(route.routes)
            elif hasattr(route, "original_router"):
                yield from walk(route.original_router.routes)

    yield from walk(app.routes)


def test_every_other_api_route_403s_a_member(tmp_data_dir, monkeypatch):
    # Rooms on, so that the rooms routes reach their key check. With rooms off
    # (the default) every rooms route is a 404 before any key is looked at; that is
    # covered in test_rooms.py.
    monkeypatch.setenv("BANDSTAND_ROOMS", "1")
    client, _, _, member_key, _ = _setup(tmp_data_dir)
    from server.main import build_app  # routes already built in _setup's client

    swept = []
    for method, path in _api_routes(client.app):
        if (method, path) in _MEMBER_READABLE or (method, path) in _MEMBER_OWN_WRITES:
            continue
        concrete = (
            path.replace("{piece_id}", "0" * 26)
            .replace("{file_id}", "0" * 26)
            .replace("{track_id}", "0" * 26)
            .replace("{bookmark_id}", "b1")
            .replace("{link_id}", "l1")
            .replace("{setlist_id}", "s1")
            .replace("{share_id}", "sh1")
            .replace("{source_id}", "src1")
            .replace("{room_id}", "r1")
            .replace("{entry_id}", "e1")
            .replace("{proposal_id}", "p1")
        )
        r = client.request(method, concrete, headers={"X-Bandstand-Key": member_key})
        # Dependencies run before body validation, so 403 must win even with no body.
        assert r.status_code == 403, f"{method} {path} -> {r.status_code}"
        swept.append((method, path))
    # The sweep must actually cover the write surface — if the route table shrinks
    # to nothing (import failure, prefix change) this test must not pass vacuously.
    assert len(swept) >= 15, swept


def test_member_allowlists_name_real_routes(tmp_data_dir):
    # A stale allowlist entry is a hole waiting for a route to reuse the path:
    # every exemption must correspond to a route that exists today.
    client, _, _, _, _ = _setup(tmp_data_dir)
    real = set(_api_routes(client.app))
    assert _MEMBER_READABLE <= real, _MEMBER_READABLE - real
    assert _MEMBER_OWN_WRITES <= real, _MEMBER_OWN_WRITES - real


def test_director_still_passes_where_members_are_403d(tmp_data_dir):
    client, _, director_key, _, _ = _setup(tmp_data_dir)
    # Spot-check the highest-traffic write: /api/sync applies an empty batch fine.
    r = client.post(
        "/api/sync", json={"ops": []}, headers={"X-Bandstand-Key": director_key}
    )
    assert r.status_code == 200
    assert r.json()["applied"] == 0
