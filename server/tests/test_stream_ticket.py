"""The live update stream opens with a short-lived, single-use ticket instead of the
key in the address. The old address stays for one release behind a setting that is
on for an install that already had data and off for a new one."""
import json
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

from server import config, db, members, stream_ticket
from server.api import events, workspaces
from server.members import ROOT

MIGRATIONS = Path(__file__).parent.parent / "migrations"


def _setup(tmp_data_dir):
    from server.main import build_app

    cfg = config.load()
    db.bootstrap(cfg)
    key = cfg.key_path.read_text().strip()
    conn = db.connect(cfg.db_path)
    _, member_key = members.add_member(conn, "Rea", "member")
    conn.close()
    return TestClient(build_app()), cfg, key, member_key


def _existing_install(tmp_data_dir):
    """A data folder from before this release: a key and a migrated database, and
    no record of when it met a server with tickets."""
    cfg = config.load()
    cfg.key_path.write_text("e" * 64)
    conn = db.connect(cfg.db_path)
    db.run_migrations(conn, MIGRATIONS)
    conn.close()
    return cfg


def _stream_request(query: str, headers: dict | None = None) -> Request:
    raw_headers = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    return Request({
        "type": "http", "method": "GET", "path": "/api/events", "headers": raw_headers,
        "query_string": query.encode(), "path_params": {},
    })


def _auth(key):
    return {"X-Bandstand-Key": key}


# ---------------------------------------------------------------- the store


def test_a_ticket_opens_once():
    store = stream_ticket.TicketStore()
    ticket = store.issue(ROOT)
    assert store.redeem(ticket) is ROOT
    assert store.redeem(ticket) is None, "a ticket is spent when it opens a stream"


def test_a_ticket_expires():
    now = [1000.0]
    store = stream_ticket.TicketStore(ttl=60, clock=lambda: now[0])
    ticket = store.issue(ROOT)
    now[0] += 59
    assert store.redeem(store.issue(ROOT)) is ROOT, "a younger ticket still works"
    now[0] += 2  # 61 seconds after the first one was issued
    assert store.redeem(ticket) is None


def test_unknown_and_empty_tickets_are_refused():
    store = stream_ticket.TicketStore()
    assert store.redeem("not-a-ticket") is None
    assert store.redeem("") is None
    assert store.redeem(None) is None


def test_a_ticket_is_tied_to_its_scope():
    store = stream_ticket.TicketStore()
    ticket = store.issue(ROOT, scope="lockups")
    assert store.redeem(ticket, scope="trio") is None
    assert store.redeem(ticket, scope="lockups") is None, "the wrong scope spent it"
    assert store.redeem(store.issue(ROOT, scope="lockups"), scope="lockups") is ROOT
    assert store.redeem(store.issue(ROOT), scope="lockups") is None


def test_the_store_only_keeps_a_hash_and_prunes_the_expired():
    now = [0.0]
    store = stream_ticket.TicketStore(ttl=60, clock=lambda: now[0])
    ticket = store.issue(ROOT)
    assert ticket not in json.dumps(list(store._entries))
    now[0] += 61
    store.issue(ROOT)
    assert store.outstanding() == 1


def test_unused_tickets_are_capped(monkeypatch):
    monkeypatch.setattr(stream_ticket, "MAX_OUTSTANDING", 5)
    store = stream_ticket.TicketStore()
    first = store.issue(ROOT)
    for _ in range(5):
        store.issue(ROOT)
    assert store.outstanding() == 5
    assert store.redeem(first) is None, "the oldest goes first"


# ---------------------------------------------------------------- the routes


def test_the_app_gets_a_ticket_with_its_header_key(tmp_data_dir):
    client, _, key, member_key = _setup(tmp_data_dir)
    for who in (key, member_key):
        r = client.post("/api/events/ticket", headers=_auth(who))
        assert r.status_code == 200, who
        body = r.json()
        assert body["expires_in"] == stream_ticket.TTL_SECONDS
        assert len(body["ticket"]) >= 32
        assert r.headers["cache-control"] == "no-store"
    assert client.post("/api/events/ticket").status_code == 401
    assert client.post("/api/events/ticket", headers=_auth("wrong")).status_code == 401


def test_a_ticket_opens_the_stream_once(tmp_data_dir):
    client, _, key, _ = _setup(tmp_data_dir)
    ticket = client.post("/api/events/ticket", headers=_auth(key)).json()["ticket"]
    # The stream itself never ends, so the check that guards it is called directly.
    ident = events.authenticate_stream(_stream_request(f"ticket={ticket}"), None, ticket)
    assert ident.is_director
    r = client.get(f"/api/events?ticket={ticket}")
    assert r.status_code == 401
    assert "ticket" in r.json()["detail"].lower()


def test_a_member_ticket_carries_the_member(tmp_data_dir):
    client, _, _, member_key = _setup(tmp_data_dir)
    ticket = client.post("/api/events/ticket", headers=_auth(member_key)).json()["ticket"]
    ident = events.authenticate_stream(_stream_request(""), None, ticket)
    assert ident.role == "member"


def test_the_header_still_opens_the_stream(tmp_data_dir):
    _, _, key, _ = _setup(tmp_data_dir)
    ident = events.authenticate_stream(_stream_request("", _auth(key)), None, None)
    assert ident is ROOT


def test_a_stream_with_nothing_is_refused(tmp_data_dir):
    client, _, _, _ = _setup(tmp_data_dir)
    assert client.get("/api/events").status_code == 401


# ---------------------------------------------------------------- the old address


def test_a_new_install_refuses_the_key_in_the_address(tmp_data_dir):
    client, cfg, key, _ = _setup(tmp_data_dir)
    assert stream_ticket.key_in_url_allowed(cfg) is False
    r = client.get(f"/api/events?key={key}")
    assert r.status_code == 401
    assert "ticket" in r.json()["detail"]


def test_an_existing_install_keeps_the_key_in_the_address(tmp_data_dir):
    cfg = _existing_install(tmp_data_dir)
    db.bootstrap_schema(cfg)  # the upgrade
    assert stream_ticket.key_in_url_allowed(cfg) is True
    key = cfg.key_path.read_text().strip()
    ident = events.authenticate_stream(_stream_request(f"key={key}"), key, None)
    assert ident is ROOT
    # A wrong key is still a wrong key.
    with pytest.raises(HTTPException) as refused:
        events.authenticate_stream(_stream_request("key=nope"), "nope", None)
    assert refused.value.status_code == 401


def test_the_answer_is_recorded_once_and_survives_later_boots(tmp_data_dir):
    cfg = _existing_install(tmp_data_dir)
    db.bootstrap_schema(cfg)
    db.bootstrap_schema(cfg)  # a second boot: now the key exists AND the row exists
    assert stream_ticket.key_in_url_allowed(cfg) is True
    conn = db.connect(cfg.db_path)
    rows = conn.execute(
        "SELECT value FROM settings WHERE device_id = 'server' AND key = 'events_key_in_url'"
    ).fetchall()
    conn.close()
    assert [r[0] for r in rows] == ["1"]


def test_a_fresh_install_stays_new_after_a_restart(tmp_data_dir):
    cfg = config.load()
    db.bootstrap_schema(cfg)
    db.bootstrap_schema(cfg)
    assert stream_ticket.key_in_url_allowed(cfg) is False


def test_the_setting_wins_over_the_record(tmp_data_dir, monkeypatch):
    cfg = _existing_install(tmp_data_dir)
    db.bootstrap_schema(cfg)
    monkeypatch.setenv("BANDSTAND_EVENTS_KEY_IN_URL", "0")
    assert stream_ticket.key_in_url_allowed(cfg) is False
    monkeypatch.setenv("BANDSTAND_EVENTS_KEY_IN_URL", "1")
    assert stream_ticket.key_in_url_allowed(cfg) is True
    monkeypatch.setenv("BANDSTAND_EVENTS_KEY_IN_URL", "")
    assert stream_ticket.key_in_url_allowed(cfg) is True, "blank means unset"


def test_the_setting_switches_the_old_address_on_for_a_new_install(tmp_data_dir, monkeypatch):
    client, cfg, key, _ = _setup(tmp_data_dir)
    monkeypatch.setenv("BANDSTAND_EVENTS_KEY_IN_URL", "1")
    ident = events.authenticate_stream(_stream_request(f"key={key}"), key, None)
    assert ident is ROOT
    monkeypatch.setenv("BANDSTAND_EVENTS_KEY_IN_URL", "yes")
    assert stream_ticket.key_in_url_allowed(cfg) is True
    monkeypatch.setenv("BANDSTAND_EVENTS_KEY_IN_URL", "off")
    assert client.get(f"/api/events?key={key}").status_code == 401


def test_a_setting_that_is_not_yes_or_no_is_refused(monkeypatch):
    monkeypatch.setenv("BANDSTAND_EVENTS_KEY_IN_URL", "maybe")
    with pytest.raises(config.ConfigProblem):
        stream_ticket.key_in_url_allowed()


def test_a_setting_nobody_can_read_stops_the_boot_not_every_stream_open(
    tmp_data_dir, monkeypatch, capsys
):
    # Every process that opens the stream reads its settings at boot, so a typo in
    # the switch is one clear line at start-up at all three doors, never a 500 per
    # stream open while the server otherwise looks healthy.
    from server import serve
    from server.public import build_public_app

    monkeypatch.setenv("BANDSTAND_EVENTS_KEY_IN_URL", "maybe")
    with pytest.raises(config.ConfigProblem, match="BANDSTAND_EVENTS_KEY_IN_URL"):
        config.load()
    assert serve.main() == 1
    err = capsys.readouterr().err
    assert "Cannot start" in err and "BANDSTAND_EVENTS_KEY_IN_URL" in err
    with pytest.raises(config.ConfigProblem):
        with TestClient(build_public_app()):
            pass
    monkeypatch.setenv("BANDSTAND_EVENTS_KEY_IN_URL", "0")
    assert config.load().events_key_in_url is False
    with TestClient(build_public_app()):
        pass
    monkeypatch.delenv("BANDSTAND_EVENTS_KEY_IN_URL")
    assert config.load().events_key_in_url is None


def test_no_database_means_no_old_address(tmp_data_dir):
    assert stream_ticket.key_in_url_allowed(config.load()) is False


# ---------------------------------------------------------------- the front door


def _door(tmp_data_dir, tmp_path):
    """An HQ with one band behind it. The band's key file is what the door reads."""
    client, cfg, key, _ = _setup(tmp_data_dir)
    band_key = tmp_path / "lockups.key"
    band_key.write_text("b" * 64)
    (cfg.data_dir / "workspaces.json").write_text(json.dumps({"workspaces": [
        {"id": "lockups", "port": 7830, "label": "Lockups", "key_file": str(band_key)},
    ]}))
    return client, key


def test_the_door_issues_its_own_ticket_and_spends_it_there(tmp_data_dir, tmp_path, monkeypatch):
    import httpx

    client, key = _door(tmp_data_dir, tmp_path)
    seen = []

    def handler(request: httpx.Request):
        seen.append(request)
        return httpx.Response(200, content=b"event: hello\n\n", headers={"content-type": "text/event-stream"})

    monkeypatch.setattr(workspaces, "_transport", lambda: httpx.MockTransport(handler))
    r = client.post("/bands/lockups/api/events/ticket", headers=_auth(key))
    assert r.status_code == 200
    ticket = r.json()["ticket"]
    assert seen == [], "the door answers this one itself"

    r = client.get(f"/bands/lockups/api/events?ticket={ticket}&client=abc")
    assert r.status_code == 200
    forwarded = seen[-1]
    assert forwarded.headers["X-Bandstand-Key"] == "b" * 64
    assert "ticket" not in str(forwarded.url)
    assert forwarded.url.params["client"] == "abc"

    assert client.get(f"/bands/lockups/api/events?ticket={ticket}").status_code == 401


def test_a_door_ticket_is_for_one_band(tmp_data_dir, tmp_path):
    client, key = _door(tmp_data_dir, tmp_path)
    ticket = client.post("/bands/lockups/api/events/ticket", headers=_auth(key)).json()["ticket"]
    assert client.get(f"/bands/trio/api/events?ticket={ticket}").status_code == 401
    # And a ticket from the band's own store does not open the door.
    own = client.post("/api/events/ticket", headers=_auth(key)).json()["ticket"]
    assert client.get(f"/bands/lockups/api/events?ticket={own}").status_code == 401


def test_the_door_refuses_a_ticket_for_an_unknown_band(tmp_data_dir, tmp_path):
    client, key = _door(tmp_data_dir, tmp_path)
    assert client.post("/bands/trio/api/events/ticket", headers=_auth(key)).status_code == 404


def test_the_door_follows_the_same_rule_for_the_key_in_the_address(tmp_data_dir, tmp_path, monkeypatch):
    client, key = _door(tmp_data_dir, tmp_path)
    r = client.get(f"/bands/lockups/api/events?key={key}")
    assert r.status_code == 401, "a new install"
    monkeypatch.setenv("BANDSTAND_EVENTS_KEY_IN_URL", "1")
    import httpx

    monkeypatch.setattr(workspaces, "_transport", lambda: httpx.MockTransport(
        lambda request: httpx.Response(200, content=b"", headers={"content-type": "text/event-stream"})
    ))
    assert client.get(f"/bands/lockups/api/events?key={key}").status_code == 200


# ---------------------------------------------------------------- the member door


def _member_door(tmp_data_dir, tmp_path, *, existing=False):
    """The public process with one band members may reach. The band's data folder
    is the test folder itself, so its membership and its install record are real."""
    from server.public import build_public_app

    if existing:
        cfg = _existing_install(tmp_data_dir)
        db.bootstrap_schema(cfg)  # the upgrade: records "old address allowed"
    else:
        cfg = config.load()
        db.bootstrap(cfg)
    key = cfg.key_path.read_text().strip()
    conn = db.connect(cfg.db_path)
    _, member_key = members.add_member(conn, "Rea", "member")
    conn.close()
    (cfg.data_dir / "workspaces.json").write_text(json.dumps({"workspaces": [
        {"id": "lockups", "port": 7830, "label": "Lockups", "key_file": str(cfg.key_path),
         "member_url": "https://members.test/bands/lockups"},
        {"id": "trio", "port": 7831, "label": "Trio", "key_file": str(tmp_path / "trio.key")},
    ]}))
    return TestClient(build_public_app(), raise_server_exceptions=False), key, member_key


def _band_behind(monkeypatch, seen: list):
    """A stand-in for the band's own server: records what reached it."""
    import httpx

    def handler(request: httpx.Request):
        seen.append(request)
        if request.url.path.endswith("/events/ticket"):
            return httpx.Response(200, json={"ticket": "from-the-band", "expires_in": 60},
                                  headers={"cache-control": "no-store"})
        return httpx.Response(200, content=b"event: hello\n\n", headers={"content-type": "text/event-stream"})

    monkeypatch.setattr(workspaces, "_transport", lambda: httpx.MockTransport(handler))


def test_the_member_door_passes_the_ticket_request_on_with_the_member_key(tmp_data_dir, tmp_path, monkeypatch):
    client, key, member_key = _member_door(tmp_data_dir, tmp_path)
    seen: list = []
    _band_behind(monkeypatch, seen)

    r = client.post("/bands/lockups/api/events/ticket", headers=_auth(member_key))
    assert r.status_code == 200
    assert r.json()["ticket"] == "from-the-band", "the band's own ticket, not one from the door"
    assert r.headers["cache-control"] == "no-store"
    assert len(seen) == 1
    assert seen[0].method == "POST"
    assert seen[0].url.path == "/api/events/ticket"
    assert seen[0].headers["X-Bandstand-Key"] == member_key

    # Only a member: nothing, garbage and the director key are refused before the band.
    assert client.post("/bands/lockups/api/events/ticket").status_code == 401
    assert client.post("/bands/lockups/api/events/ticket", headers=_auth("wrong")).status_code == 403
    assert client.post("/bands/lockups/api/events/ticket", headers=_auth(key)).status_code == 403
    # And only for a band that lets members in.
    assert client.post("/bands/trio/api/events/ticket", headers=_auth(member_key)).status_code == 404
    assert len(seen) == 1


def test_the_member_door_forwards_a_ticket_with_no_credential(tmp_data_dir, tmp_path, monkeypatch):
    client, _, member_key = _member_door(tmp_data_dir, tmp_path)
    seen: list = []
    _band_behind(monkeypatch, seen)

    r = client.get("/bands/lockups/api/events?ticket=from-the-band&client=abc&key=stripped")
    assert r.status_code == 200
    forwarded = seen[-1]
    assert forwarded.url.path == "/api/events"
    assert "X-Bandstand-Key" not in forwarded.headers, "the band redeems the ticket; the door vouches for nothing"
    assert forwarded.url.params["ticket"] == "from-the-band"
    assert forwarded.url.params["client"] == "abc"
    assert "key" not in forwarded.url.params

    # A header still wins, and a ticket beside it is dropped like a key would be.
    r = client.get("/bands/lockups/api/events?ticket=from-the-band", headers=_auth(member_key))
    assert r.status_code == 200
    assert seen[-1].headers["X-Bandstand-Key"] == member_key
    assert "ticket" not in seen[-1].url.params


def test_the_member_door_refuses_an_empty_or_absurd_ticket_itself(tmp_data_dir, tmp_path, monkeypatch):
    client, _, _ = _member_door(tmp_data_dir, tmp_path)
    seen: list = []
    _band_behind(monkeypatch, seen)
    for ticket in ("", "x" * 257):
        r = client.get(f"/bands/lockups/api/events?ticket={ticket}")
        assert r.status_code == 401
        assert "ticket" in r.text.lower()
    assert seen == []


def test_a_ticket_opens_only_the_stream_at_the_member_door(tmp_data_dir, tmp_path, monkeypatch):
    client, _, _ = _member_door(tmp_data_dir, tmp_path)
    seen: list = []
    _band_behind(monkeypatch, seen)
    # No other read takes a ticket in place of the key, and no write is opened by one.
    assert client.get("/bands/lockups/api/manifest?ticket=from-the-band").status_code == 401
    assert client.put("/bands/lockups/api/my-notes/abc?ticket=from-the-band", content=b"{}").status_code == 401
    assert client.post("/bands/lockups/api/pieces?ticket=from-the-band").status_code == 404
    assert seen == []


def test_the_member_door_refuses_the_key_in_the_address_for_a_new_install(tmp_data_dir, tmp_path, monkeypatch):
    client, _, member_key = _member_door(tmp_data_dir, tmp_path)
    seen: list = []
    _band_behind(monkeypatch, seen)
    r = client.get(f"/bands/lockups/api/events?key={member_key}")
    assert r.status_code == 401
    assert "ticket" in r.text
    assert seen == []
    # Every other read still wants the header, as before.
    assert client.get(f"/bands/lockups/api/manifest?key={member_key}").status_code == 401


def test_the_member_door_keeps_the_key_in_the_address_for_an_existing_install(tmp_data_dir, tmp_path, monkeypatch):
    client, _, member_key = _member_door(tmp_data_dir, tmp_path, existing=True)
    seen: list = []
    _band_behind(monkeypatch, seen)
    r = client.get(f"/bands/lockups/api/events?key={member_key}")
    assert r.status_code == 200
    # The key goes on in the header, as it always did from this door, never in the address.
    assert seen[-1].headers["X-Bandstand-Key"] == member_key
    assert "key" not in seen[-1].url.params
    # Still a member's key, or nothing.
    assert client.get("/bands/lockups/api/events?key=wrong").status_code == 403


def test_the_setting_rules_the_member_door_too(tmp_data_dir, tmp_path, monkeypatch):
    client, _, member_key = _member_door(tmp_data_dir, tmp_path, existing=True)
    seen: list = []
    _band_behind(monkeypatch, seen)
    monkeypatch.setenv("BANDSTAND_EVENTS_KEY_IN_URL", "0")
    assert client.get(f"/bands/lockups/api/events?key={member_key}").status_code == 401
    assert seen == []
    monkeypatch.setenv("BANDSTAND_EVENTS_KEY_IN_URL", "1")
    assert client.get(f"/bands/lockups/api/events?key={member_key}").status_code == 200
    assert len(seen) == 1


def test_the_member_door_reads_the_record_without_writing(tmp_data_dir, tmp_path, monkeypatch):
    # The public process only ever opens a band's database read-only, so the record
    # is read that way too: the writable opener is never touched.
    cfg = _existing_install(tmp_data_dir)
    db.bootstrap_schema(cfg)

    def never(_path):
        raise AssertionError("the member door must not open a band's database for writing")

    monkeypatch.setattr(db, "connect", never)
    assert stream_ticket.key_in_url_allowed(band_db=cfg.db_path) is True
    assert stream_ticket.key_in_url_allowed(band_db=tmp_path / "missing.db") is False
