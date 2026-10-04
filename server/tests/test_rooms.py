import hashlib
import secrets

import pytest
from fastapi.testclient import TestClient

from server import config, db, members
from server.api import rooms


@pytest.fixture(autouse=True)
def _rooms_switched_on(monkeypatch):
    """Rooms are off unless the operator says so. Everything in this file is about
    rooms that ARE on; the tests about the switch itself change the variable."""
    monkeypatch.setenv("BANDSTAND_ROOMS", "1")
    monkeypatch.delenv("BANDSTAND_ROOMS_MAX_OPEN", raising=False)
    monkeypatch.delenv("BANDSTAND_ROOMS_PROPOSALS_PER_MINUTE", raising=False)
    monkeypatch.delenv("BANDSTAND_ROOMS_MAX_GUESTS", raising=False)


def _guest_headers(room, person):
    return {
        "X-Bandstand-Room": room["join_token"],
        "X-Bandstand-Participant": person["participant_token"],
    }


def _propose(client, room, person, title):
    return client.post(
        f"/room-api/{room['id']}/proposals", json={"title": title},
        headers=_guest_headers(room, person),
    )


def _setup(tmp_data_dir):
    from server.main import build_app

    cfg = config.load()
    db.bootstrap(cfg)
    return TestClient(build_app()), cfg, cfg.key_path.read_text().strip()


def _create(client, key, title="Sunday rehearsal"):
    response = client.post(
        "/api/rooms", json={"title": title}, headers={"X-Bandstand-Key": key}
    )
    assert response.status_code == 200
    return response.json()


def _try_join(client, room, name, instrument, participant_id=None, participant_token=None):
    return client.post(
        f"/room-api/{room['id']}/join",
        json={
            "participant_id": participant_id or secrets.token_hex(13),
            "participant_token": participant_token or secrets.token_hex(32),
            "display_name": name,
            "instrument": instrument,
        },
        headers={"X-Bandstand-Room": room["join_token"]},
    )


def _join(client, room, name, instrument):
    response = _try_join(client, room, name, instrument)
    assert response.status_code == 200
    return response.json()


def test_room_token_is_hashed_and_director_can_read(tmp_data_dir):
    client, cfg, key = _setup(tmp_data_dir)
    room = _create(client, key)
    assert len(room["join_token"]) == 64

    conn = db.connect(cfg.db_path)
    row = conn.execute(
        "SELECT join_token_hash FROM rehearsal_rooms WHERE id = ?", (room["id"],)
    ).fetchone()
    conn.close()
    assert row["join_token_hash"] == hashlib.sha256(room["join_token"].encode()).hexdigest()
    assert row["join_token_hash"] != room["join_token"]

    state = client.get(
        f"/api/rooms/{room['id']}", headers={"X-Bandstand-Key": key}
    )
    assert state.status_code == 200
    assert state.json()["room"]["state"] == "open"


def test_guest_join_propose_vote_and_volunteer_are_public_in_room(tmp_data_dir):
    client, _, key = _setup(tmp_data_dir)
    room = _create(client, key)
    maya = _join(client, room, "Maya", "Vocals")
    sam = _join(client, room, "Sam", "Guitar")

    proposed = client.post(
        f"/room-api/{room['id']}/proposals",
        json={"title": "Cissy Strut", "music_key": "C"},
        headers={
            "X-Bandstand-Room": room["join_token"],
            "X-Bandstand-Participant": maya["participant_token"],
        },
    )
    assert proposed.status_code == 200
    proposal_id = proposed.json()["id"]

    for kind in ("play", "hear"):
        response = client.put(
            f"/room-api/{room['id']}/proposals/{proposal_id}/votes/{kind}",
            headers={
                "X-Bandstand-Room": room["join_token"],
                "X-Bandstand-Participant": sam["participant_token"],
            },
        )
        assert response.status_code == 200

    volunteered = client.put(
        f"/room-api/{room['id']}/proposals/{proposal_id}/volunteers/Guitar",
        headers={
            "X-Bandstand-Room": room["join_token"],
            "X-Bandstand-Participant": sam["participant_token"],
        },
    )
    assert volunteered.status_code == 200

    state = client.get(
        f"/room-api/{room['id']}", headers={"X-Bandstand-Room": room["join_token"]}
    ).json()
    assert {p["display_name"] for p in state["participants"]} == {"Maya", "Sam"}
    proposal = state["proposals"][0]
    assert proposal["play_votes"] == 1
    assert proposal["hear_votes"] == 1
    assert proposal["volunteers"] == [
        {"participant_id": sam["participant"]["id"], "display_name": "Sam", "instrument": "Guitar"}
    ]


def test_participant_credential_cannot_modify_another_room(tmp_data_dir):
    client, _, key = _setup(tmp_data_dir)
    first = _create(client, key, "First")
    participant = _join(client, first, "Maya", "Vocals")
    client.post(
        f"/api/rooms/{first['id']}/close", headers={"X-Bandstand-Key": key}
    )
    second = _create(client, key, "Second")

    response = client.post(
        f"/room-api/{second['id']}/proposals",
        json={"title": "Nope"},
        headers={
            "X-Bandstand-Room": second["join_token"],
            "X-Bandstand-Participant": participant["participant_token"],
        },
    )
    assert response.status_code == 401


def test_votes_and_volunteers_are_idempotent(tmp_data_dir):
    client, _, key = _setup(tmp_data_dir)
    room = _create(client, key)
    person = _join(client, room, "Rea", "Bass")
    headers = {
        "X-Bandstand-Room": room["join_token"],
        "X-Bandstand-Participant": person["participant_token"],
    }
    proposal = client.post(
        f"/room-api/{room['id']}/proposals", json={"title": "Chameleon"}, headers=headers
    ).json()
    for _ in range(2):
        assert client.put(
            f"/room-api/{room['id']}/proposals/{proposal['id']}/votes/play", headers=headers
        ).status_code == 200
        assert client.put(
            f"/room-api/{room['id']}/proposals/{proposal['id']}/volunteers/Bass", headers=headers
        ).status_code == 200
    state = client.get(
        f"/room-api/{room['id']}", headers={"X-Bandstand-Room": room["join_token"]}
    ).json()
    assert state["proposals"][0]["play_votes"] == 1
    assert len(state["proposals"][0]["volunteers"]) == 1


def test_host_controls_queue_and_stale_reorder_is_rejected(tmp_data_dir):
    client, _, key = _setup(tmp_data_dir)
    room = _create(client, key)
    person = _join(client, room, "Louis", "Drums")
    guest_headers = {
        "X-Bandstand-Room": room["join_token"],
        "X-Bandstand-Participant": person["participant_token"],
    }
    proposal = client.post(
        f"/room-api/{room['id']}/proposals", json={"title": "Superstition"}, headers=guest_headers
    ).json()

    assert client.post(
        f"/api/rooms/{room['id']}/queue",
        json={"proposal_id": proposal["id"]},
        headers={"X-Bandstand-Key": key},
    ).status_code == 200
    state = client.get(
        f"/api/rooms/{room['id']}", headers={"X-Bandstand-Key": key}
    ).json()
    entry = state["queue"][0]
    revision = state["room"]["revision"]

    current = client.post(
        f"/api/rooms/{room['id']}/queue/{entry['id']}/current",
        headers={"X-Bandstand-Key": key},
    )
    assert current.status_code == 200

    stale = client.put(
        f"/api/rooms/{room['id']}/queue/order",
        json={"entry_ids": [entry["id"]], "expected_revision": revision},
        headers={"X-Bandstand-Key": key},
    )
    assert stale.status_code == 409


def test_closed_room_refuses_join_and_guest_read(tmp_data_dir):
    client, _, key = _setup(tmp_data_dir)
    room = _create(client, key)
    closed = client.post(
        f"/api/rooms/{room['id']}/close", headers={"X-Bandstand-Key": key}
    )
    assert closed.status_code == 200
    headers = {"X-Bandstand-Room": room["join_token"]}
    assert client.get(f"/room-api/{room['id']}", headers=headers).status_code == 410
    assert client.post(
        f"/room-api/{room['id']}/join",
        json={"display_name": "Late", "instrument": "Keys"},
        headers=headers,
    ).status_code == 410


# ------------------------------------------------------------------ the switch


@pytest.mark.parametrize("value", [None, "", "0", "off", "no", "false"])
def test_rooms_are_off_unless_switched_on(tmp_data_dir, monkeypatch, value):
    # Off is the default: a fresh install has a QR-shaped public surface only when
    # the operator asked for one. Every rooms route answers 404, director or guest.
    if value is None:
        monkeypatch.delenv("BANDSTAND_ROOMS", raising=False)
    else:
        monkeypatch.setenv("BANDSTAND_ROOMS", value)
    client, _, key = _setup(tmp_data_dir)
    director = {"X-Bandstand-Key": key}

    assert not config.load().rooms_enabled
    created = client.post("/api/rooms", json={"title": "Nope"}, headers=director)
    assert created.status_code == 404
    assert created.json()["detail"] == rooms.ROOMS_OFF_MESSAGE
    assert client.get("/api/rooms/active", headers=director).status_code == 404
    assert client.get("/api/rooms/anything", headers=director).status_code == 404
    assert client.post("/api/rooms/anything/close", headers=director).status_code == 404
    guest = {"X-Bandstand-Room": "x" * 64}
    assert client.get("/room-api/anything", headers=guest).status_code == 404
    assert client.post(
        "/room-api/anything/join",
        json={"participant_id": "p", "participant_token": "t" * 32,
              "display_name": "Maya", "instrument": "Vocals"},
        headers=guest,
    ).status_code == 404
    assert client.post(
        "/room-api/anything/proposals", json={"title": "x"}, headers=guest
    ).status_code == 404


def test_switching_rooms_off_hides_a_room_that_was_open(tmp_data_dir, monkeypatch):
    # Config is read per request. A room opened while the switch was on stops
    # answering the moment it is off, and comes back, data intact, when it is on.
    client, _, key = _setup(tmp_data_dir)
    room = _create(client, key)
    person = _join(client, room, "Maya", "Vocals")
    assert _propose(client, room, person, "Cissy Strut").status_code == 200

    monkeypatch.setenv("BANDSTAND_ROOMS", "0")
    assert client.get(
        f"/room-api/{room['id']}", headers={"X-Bandstand-Room": room["join_token"]}
    ).status_code == 404
    assert _propose(client, room, person, "Chameleon").status_code == 404
    assert client.get(
        f"/api/rooms/{room['id']}", headers={"X-Bandstand-Key": key}
    ).status_code == 404

    monkeypatch.setenv("BANDSTAND_ROOMS", "yes")
    state = client.get(f"/api/rooms/{room['id']}", headers={"X-Bandstand-Key": key})
    assert state.status_code == 200
    assert [p["title"] for p in state.json()["proposals"]] == ["Cissy Strut"]


# --------------------------------------------------------------- open-room cap


def test_one_open_room_is_the_default_cap(tmp_data_dir):
    client, _, key = _setup(tmp_data_dir)
    assert config.load().rooms_max_open == 1
    first = _create(client, key, "First")
    second = client.post(
        "/api/rooms", json={"title": "Second"}, headers={"X-Bandstand-Key": key}
    )
    assert second.status_code == 409
    assert second.json()["detail"] == "Close the open room first"

    assert client.post(
        f"/api/rooms/{first['id']}/close", headers={"X-Bandstand-Key": key}
    ).status_code == 200
    assert _create(client, key, "Second")["state"] == "open"


def test_the_open_room_cap_is_a_setting(tmp_data_dir, monkeypatch):
    monkeypatch.setenv("BANDSTAND_ROOMS_MAX_OPEN", "2")
    client, cfg, key = _setup(tmp_data_dir)
    director = {"X-Bandstand-Key": key}
    a = _create(client, key, "A")
    b = _create(client, key, "B")
    third = client.post("/api/rooms", json={"title": "C"}, headers=director)
    assert third.status_code == 409
    assert third.json()["detail"] == "This server allows 2 open rooms. Close one first"

    conn = db.connect(cfg.db_path)
    open_rooms = conn.execute(
        "SELECT COUNT(*) FROM rehearsal_rooms WHERE state = 'open'"
    ).fetchone()[0]
    conn.close()
    assert open_rooms == 2
    # The newest open room is the one the app shows as active.
    assert client.get("/api/rooms/active", headers=director).json()["room"]["id"] == b["id"]

    # Closing either one makes space again.
    assert client.post(f"/api/rooms/{a['id']}/close", headers=director).status_code == 200
    assert client.post("/api/rooms", json={"title": "C"}, headers=director).status_code == 200


def test_a_closed_room_does_not_count_against_the_cap(tmp_data_dir):
    client, _, key = _setup(tmp_data_dir)
    director = {"X-Bandstand-Key": key}
    for title in ("Mon", "Tue", "Wed"):
        room = _create(client, key, title)
        assert client.post(f"/api/rooms/{room['id']}/close", headers=director).status_code == 200
    assert _create(client, key, "Thu")["state"] == "open"


@pytest.mark.parametrize("bad", ["0", "-1", "two"])
def test_an_unusable_open_room_cap_is_refused(tmp_data_dir, monkeypatch, bad):
    # Zero would be a second way of switching rooms off. There is one switch.
    monkeypatch.setenv("BANDSTAND_ROOMS_MAX_OPEN", bad)
    with pytest.raises(config.ConfigProblem, match="BANDSTAND_ROOMS_MAX_OPEN"):
        config.load()


# -------------------------------------------------------- proposals per minute


def test_a_guest_can_post_only_so_many_songs_a_minute(tmp_data_dir, monkeypatch):
    client, _, key = _setup(tmp_data_dir)
    limit = config.load().rooms_proposals_per_minute
    assert limit == config.DEFAULT_ROOMS_PROPOSALS_PER_MINUTE
    room = _create(client, key)
    maya = _join(client, room, "Maya", "Vocals")
    sam = _join(client, room, "Sam", "Guitar")

    for n in range(limit):
        assert _propose(client, room, maya, f"Song {n}").status_code == 200
    blocked = _propose(client, room, maya, "One more")
    assert blocked.status_code == 429
    assert blocked.json()["detail"] == f"You can post {limit} songs a minute. Try again in a moment"

    # The limit is per guest: Sam is not affected by Maya's burst.
    assert _propose(client, room, sam, "Chameleon").status_code == 200

    # A minute later Maya may post again.
    real_now = rooms._now()
    monkeypatch.setattr(rooms, "_now", lambda: real_now + 61 * 1000)
    assert _propose(client, room, maya, "Later").status_code == 200

    state = client.get(
        f"/room-api/{room['id']}", headers={"X-Bandstand-Room": room["join_token"]}
    ).json()
    assert len(state["proposals"]) == limit + 2


def test_the_per_minute_cap_is_a_setting_and_zero_means_no_limit(tmp_data_dir, monkeypatch):
    monkeypatch.setenv("BANDSTAND_ROOMS_PROPOSALS_PER_MINUTE", "2")
    client, _, key = _setup(tmp_data_dir)
    room = _create(client, key)
    maya = _join(client, room, "Maya", "Vocals")
    assert _propose(client, room, maya, "One").status_code == 200
    assert _propose(client, room, maya, "Two").status_code == 200
    assert _propose(client, room, maya, "Three").status_code == 429

    monkeypatch.setenv("BANDSTAND_ROOMS_PROPOSALS_PER_MINUTE", "0")
    for n in range(12):
        assert _propose(client, room, maya, f"Free {n}").status_code == 200


def test_a_removed_proposal_still_counts_toward_the_minute(tmp_data_dir, monkeypatch):
    # Otherwise "post, get removed, post again" is a way round the limit.
    monkeypatch.setenv("BANDSTAND_ROOMS_PROPOSALS_PER_MINUTE", "1")
    client, _, key = _setup(tmp_data_dir)
    room = _create(client, key)
    maya = _join(client, room, "Maya", "Vocals")
    first = _propose(client, room, maya, "Rude title")
    assert first.status_code == 200
    assert client.delete(
        f"/api/rooms/{room['id']}/proposals/{first.json()['id']}",
        headers={"X-Bandstand-Key": key},
    ).status_code == 200
    assert _propose(client, room, maya, "Again").status_code == 429


def test_a_negative_per_minute_cap_is_refused(tmp_data_dir, monkeypatch):
    monkeypatch.setenv("BANDSTAND_ROOMS_PROPOSALS_PER_MINUTE", "-3")
    with pytest.raises(config.ConfigProblem, match="BANDSTAND_ROOMS_PROPOSALS_PER_MINUTE"):
        config.load()


# ------------------------------------------------------------ guests per room


def test_a_room_takes_only_so_many_guests(tmp_data_dir, monkeypatch):
    # The per-minute song limit is per guest id, and a phone picks its own id, so
    # one phone re-joining under fresh ids would post without bound. Joins are
    # capped per room; the cap bounds the flood at guests x songs per minute.
    monkeypatch.setenv("BANDSTAND_ROOMS_MAX_GUESTS", "2")
    monkeypatch.setenv("BANDSTAND_ROOMS_PROPOSALS_PER_MINUTE", "1")
    client, _, key = _setup(tmp_data_dir)
    room = _create(client, key)
    maya = _join(client, room, "Maya", "Vocals")
    sam = _join(client, room, "Sam", "Guitar")
    full = _try_join(client, room, "Third", "Drums")
    assert full.status_code == 409
    assert full.json()["detail"] == "This room is full"

    # A guest already in the room may join again with the same id and token
    # (a page reload), which is not a new seat.
    again = _try_join(
        client, room, "Maya", "Vocals",
        participant_id=maya["participant"]["id"], participant_token=maya["participant_token"],
    )
    assert again.status_code == 200

    assert _propose(client, room, maya, "One").status_code == 200
    assert _propose(client, room, sam, "Two").status_code == 200
    assert _propose(client, room, maya, "Three").status_code == 429
    state = client.get(
        f"/room-api/{room['id']}", headers={"X-Bandstand-Room": room["join_token"]}
    ).json()
    assert len(state["proposals"]) == 2
    assert len(state["participants"]) == 2


def test_the_guest_cap_is_per_room(tmp_data_dir, monkeypatch):
    monkeypatch.setenv("BANDSTAND_ROOMS_MAX_GUESTS", "1")
    monkeypatch.setenv("BANDSTAND_ROOMS_MAX_OPEN", "2")
    client, _, key = _setup(tmp_data_dir)
    first = _create(client, key, "Monday")
    second = _create(client, key, "Tuesday")
    _join(client, first, "Maya", "Vocals")
    assert _try_join(client, first, "Sam", "Guitar").status_code == 409
    assert _try_join(client, second, "Sam", "Guitar").status_code == 200


def test_the_default_guest_cap_is_a_full_rehearsal_room(tmp_data_dir):
    assert config.load().rooms_max_guests == config.DEFAULT_ROOMS_MAX_GUESTS == 60


@pytest.mark.parametrize("bad", ["0", "-5", "lots"])
def test_an_unusable_guest_cap_is_refused(tmp_data_dir, monkeypatch, bad):
    monkeypatch.setenv("BANDSTAND_ROOMS_MAX_GUESTS", bad)
    with pytest.raises(config.ConfigProblem, match="BANDSTAND_ROOMS_MAX_GUESTS"):
        config.load()


# ------------------------------------------------------- director removes things


def test_director_can_remove_a_proposal_from_pool_and_queue(tmp_data_dir):
    client, cfg, key = _setup(tmp_data_dir)
    director = {"X-Bandstand-Key": key}
    room = _create(client, key)
    maya = _join(client, room, "Maya", "Vocals")
    sam = _join(client, room, "Sam", "Guitar")
    _propose(client, room, maya, "Keep me")
    rude = _propose(client, room, sam, "Remove me").json()
    queued = _propose(client, room, sam, "Queued then removed").json()
    assert client.put(
        f"/room-api/{room['id']}/proposals/{rude['id']}/votes/play",
        headers=_guest_headers(room, maya),
    ).status_code == 200
    assert client.post(
        f"/api/rooms/{room['id']}/queue", json={"proposal_id": queued["id"]}, headers=director
    ).status_code == 200
    before = client.get(f"/api/rooms/{room['id']}", headers=director).json()["room"]

    removed = client.delete(f"/api/rooms/{room['id']}/proposals/{rude['id']}", headers=director)
    assert removed.status_code == 200
    assert removed.json()["revision"] == before["revision"] + 1

    state = client.get(f"/api/rooms/{room['id']}", headers=director).json()
    assert [p["title"] for p in state["proposals"]] == ["Keep me", "Queued then removed"]
    assert state["room"]["queue_revision"] == before["queue_revision"]

    # A promoted song leaves the queue too, and the queue revision moves so a
    # host screen holding a stale order cannot reorder over it.
    assert client.delete(
        f"/api/rooms/{room['id']}/proposals/{queued['id']}", headers=director
    ).status_code == 200
    state = client.get(f"/api/rooms/{room['id']}", headers=director).json()
    assert [p["title"] for p in state["proposals"]] == ["Keep me"]
    assert state["queue"] == []
    assert state["room"]["queue_revision"] == before["queue_revision"] + 1

    # Guests see the same, and the row is kept as withdrawn, not deleted.
    guest = client.get(
        f"/room-api/{room['id']}", headers={"X-Bandstand-Room": room["join_token"]}
    ).json()
    assert [p["title"] for p in guest["proposals"]] == ["Keep me"]
    conn = db.connect(cfg.db_path)
    states = dict(conn.execute("SELECT title, state FROM room_proposals").fetchall())
    conn.close()
    assert states == {
        "Keep me": "open", "Remove me": "withdrawn", "Queued then removed": "withdrawn",
    }

    # Gone is gone: a second removal, and a vote from a guest, both find nothing.
    assert client.delete(
        f"/api/rooms/{room['id']}/proposals/{rude['id']}", headers=director
    ).status_code == 404
    assert client.put(
        f"/room-api/{room['id']}/proposals/{rude['id']}/votes/hear",
        headers=_guest_headers(room, maya),
    ).status_code == 404


def test_only_the_director_can_remove_a_proposal(tmp_data_dir):
    client, cfg, key = _setup(tmp_data_dir)
    room = _create(client, key)
    maya = _join(client, room, "Maya", "Vocals")
    proposal = _propose(client, room, maya, "Mine").json()
    path = f"/api/rooms/{room['id']}/proposals/{proposal['id']}"

    # No key, a guest's room credentials, and a member key all fail closed.
    assert client.delete(path).status_code == 401
    assert client.delete(path, headers=_guest_headers(room, maya)).status_code == 401
    conn = db.connect(cfg.db_path)
    _, member_key = members.add_member(conn, "Rea")
    conn.close()
    assert client.delete(path, headers={"X-Bandstand-Key": member_key}).status_code == 403
    assert client.delete(
        f"/api/rooms/{room['id']}/proposals/not-a-proposal", headers={"X-Bandstand-Key": key}
    ).status_code == 404

    state = client.get(f"/api/rooms/{room['id']}", headers={"X-Bandstand-Key": key}).json()
    assert [p["title"] for p in state["proposals"]] == ["Mine"]


def test_director_closing_a_room_ends_it_for_guests_at_once(tmp_data_dir):
    client, _, key = _setup(tmp_data_dir)
    room = _create(client, key)
    maya = _join(client, room, "Maya", "Vocals")
    assert client.post(
        f"/api/rooms/{room['id']}/close", headers={"X-Bandstand-Key": key}
    ).status_code == 200
    assert _propose(client, room, maya, "Too late").status_code == 410
    assert client.put(
        f"/room-api/{room['id']}/proposals/anything/votes/play",
        headers=_guest_headers(room, maya),
    ).status_code == 410
    assert client.get("/api/rooms/active", headers={"X-Bandstand-Key": key}).json() is None
