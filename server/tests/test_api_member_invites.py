"""The People page's add-a-player flow: POST /api/member-invites with a name.

The page types a name and expects the key back once, so the invite must land in the
members table under that exact name, and the key must sign in as that person.
"""

from fastapi.testclient import TestClient

from server import config, db, members


def _setup(tmp_data_dir):
    from server.main import build_app

    cfg = config.load()
    db.bootstrap(cfg)
    app = build_app()
    director_key = cfg.key_path.read_text().strip()
    return TestClient(app), cfg, {"X-Bandstand-Key": director_key}


def test_invite_lands_with_the_typed_name(tmp_data_dir):
    client, cfg, director = _setup(tmp_data_dir)

    r = client.post("/api/member-invites", json={"name": "Rea"}, headers=director)
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "Rea"
    assert body["role"] == "member"
    assert len(body["key"]) == 64
    assert r.headers["cache-control"] == "no-store"

    # It is in the table under that name, hash only, and the key signs in as Rea.
    conn = db.connect(cfg.db_path)
    try:
        row = conn.execute("SELECT * FROM members WHERE id = ?", (body["id"],)).fetchone()
        assert row["name"] == "Rea"
        assert row["role"] == "member"
        assert row["revoked_at"] is None
        assert row["key_hash"] == members.key_hash(body["key"])
        assert body["key"] not in dict(row).values()
    finally:
        conn.close()
    who = client.get("/api/whoami", headers={"X-Bandstand-Key": body["key"]})
    assert who.status_code == 200
    assert who.json() == {"id": body["id"], "name": "Rea", "role": "member"}

    # The list the People page shows carries the new row by name.
    listed = client.get("/api/member-invites", headers=director).json()["members"]
    assert [m["name"] for m in listed if m["role"] == "member"] == ["Rea"]
    assert all("key" not in m and "key_hash" not in m for m in listed)


def test_invite_name_is_trimmed_and_must_be_present(tmp_data_dir):
    client, _, director = _setup(tmp_data_dir)
    r = client.post("/api/member-invites", json={"name": "  Liam  "}, headers=director)
    assert r.status_code == 201 and r.json()["name"] == "Liam"
    for bad in ({}, {"name": ""}, {"name": "   "}, {"name": 7}, {"name": "x" * 101}, {"name": "a\nb"}):
        assert client.post("/api/member-invites", json=bad, headers=director).status_code == 422, bad


def test_invite_refuses_a_second_link_for_the_same_name(tmp_data_dir):
    client, _, director = _setup(tmp_data_dir)
    assert client.post("/api/member-invites", json={"name": "Anya"}, headers=director).status_code == 201
    r = client.post("/api/member-invites", json={"name": "anya"}, headers=director)
    assert r.status_code == 409


def test_replace_keeps_the_name_and_retires_the_old_key(tmp_data_dir):
    client, _, director = _setup(tmp_data_dir)
    first = client.post("/api/member-invites", json={"name": "Louis"}, headers=director).json()
    r = client.post(f"/api/member-invites/{first['id']}/replace", headers=director)
    assert r.status_code == 201
    second = r.json()
    assert second["name"] == "Louis" and second["id"] != first["id"] and second["key"] != first["key"]
    assert client.get("/api/whoami", headers={"X-Bandstand-Key": first["key"]}).status_code == 401
    assert client.get("/api/whoami", headers={"X-Bandstand-Key": second["key"]}).json()["name"] == "Louis"
    # Replacing an unknown or already-replaced member is a 404, not a fresh key.
    assert client.post(f"/api/member-invites/{first['id']}/replace", headers=director).status_code == 404


def test_invites_are_director_only(tmp_data_dir):
    client, _, director = _setup(tmp_data_dir)
    member_key = client.post("/api/member-invites", json={"name": "Rea"}, headers=director).json()["key"]
    member = {"X-Bandstand-Key": member_key}
    assert client.get("/api/member-invites", headers=member).status_code == 403
    assert client.post("/api/member-invites", json={"name": "Mallory"}, headers=member).status_code == 403
    assert client.post("/api/member-invites", json={"name": "Mallory"}).status_code == 401
