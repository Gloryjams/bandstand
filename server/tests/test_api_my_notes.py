"""Private notes: a member feature, scoped to the calling identity.

The rule under test: the owner of a note is whoever the presented key resolves to,
and nothing a client sends (body field, query parameter, path) can change that. A
member must never read or write another member's notes, and neither may the
director through this API.
"""

import json

from fastapi.testclient import TestClient

from server import config, db, members

PIECE = "01HZZZZZZZZZZZZZZZZZZZZZZA"
OTHER_PIECE = "01HZZZZZZZZZZZZZZZZZZZZZZB"


def _setup(tmp_data_dir):
    from server.main import build_app

    cfg = config.load()
    db.bootstrap(cfg)
    conn = db.connect(cfg.db_path)
    for pid, title in ((PIECE, "Take Five"), (OTHER_PIECE, "So What")):
        conn.execute(
            "INSERT INTO pieces (id, title, page_count, added_at, updated_at) "
            "VALUES (?, ?, 1, 1, 1)",
            (pid, title),
        )
    rea, rea_key = members.add_member(conn, "Rea", "member")
    liam, liam_key = members.add_member(conn, "Liam", "member")
    conn.close()
    return {
        "client": TestClient(build_app()),
        "cfg": cfg,
        "director": {"X-Bandstand-Key": cfg.key_path.read_text().strip()},
        "rea": {"X-Bandstand-Key": rea_key},
        "liam": {"X-Bandstand-Key": liam_key},
        "rea_id": rea.id,
        "liam_id": liam.id,
    }


def _put(ctx, who, piece, content, base=0, mutation="m1", **extra):
    body = {"content": content, "base_revision": base, "mutation_id": mutation, **extra}
    return ctx["client"].put(f"/api/my-notes/{piece}", json=body, headers=ctx[who])


def _notes(ctx, who, **params):
    r = ctx["client"].get("/api/my-notes", headers=ctx[who], params=params)
    assert r.status_code == 200, r.text
    return r.json()["notes"]


def _rows(ctx):
    conn = db.connect(ctx["cfg"].db_path)
    try:
        return [dict(r) for r in conn.execute(
            "SELECT owner_id, piece_id, content, revision FROM personal_notes "
            "ORDER BY owner_id, piece_id"
        )]
    finally:
        conn.close()


def test_member_writes_and_reads_own_note(tmp_data_dir):
    ctx = _setup(tmp_data_dir)
    r = _put(ctx, "rea", PIECE, "watch the bridge")
    assert r.status_code == 200, r.text
    assert r.json()["revision"] == 1
    assert r.headers["cache-control"] == "no-store"
    notes = _notes(ctx, "rea")
    assert [(n["piece_id"], n["content"]) for n in notes] == [(PIECE, "watch the bridge")]
    # The stored owner is the authenticated member, nothing else.
    assert _rows(ctx) == [
        {"owner_id": ctx["rea_id"], "piece_id": PIECE, "content": "watch the bridge", "revision": 1}
    ]


def test_member_cannot_read_another_members_notes(tmp_data_dir):
    ctx = _setup(tmp_data_dir)
    assert _put(ctx, "rea", PIECE, "rea secret").status_code == 200
    assert _notes(ctx, "liam") == []
    assert "rea secret" not in json.dumps(_notes(ctx, "liam"))


def test_director_cannot_read_member_notes_and_members_cannot_read_directors(tmp_data_dir):
    ctx = _setup(tmp_data_dir)
    assert _put(ctx, "rea", PIECE, "rea secret").status_code == 200
    assert _put(ctx, "director", PIECE, "director secret").status_code == 200
    assert [n["content"] for n in _notes(ctx, "director")] == ["director secret"]
    assert [n["content"] for n in _notes(ctx, "rea")] == ["rea secret"]
    assert _notes(ctx, "liam") == []


def test_same_piece_holds_one_independent_note_per_owner(tmp_data_dir):
    ctx = _setup(tmp_data_dir)
    assert _put(ctx, "rea", PIECE, "rea v1").status_code == 200
    # Liam starts from revision 0 on the same piece: that must create HIS note,
    # not collide with (or overwrite) Rea's revision 1.
    r = _put(ctx, "liam", PIECE, "liam v1")
    assert r.status_code == 200, r.text
    assert r.json()["revision"] == 1
    assert _put(ctx, "liam", PIECE, "liam v2", base=1, mutation="m2").status_code == 200
    assert [n["content"] for n in _notes(ctx, "rea")] == ["rea v1"]
    assert [n["content"] for n in _notes(ctx, "liam")] == ["liam v2"]
    assert _rows(ctx) == sorted([
        {"owner_id": ctx["rea_id"], "piece_id": PIECE, "content": "rea v1", "revision": 1},
        {"owner_id": ctx["liam_id"], "piece_id": PIECE, "content": "liam v2", "revision": 2},
    ], key=lambda r: (r["owner_id"], r["piece_id"]))


def test_client_supplied_owner_is_refused_in_the_body(tmp_data_dir):
    ctx = _setup(tmp_data_dir)
    assert _put(ctx, "rea", PIECE, "rea v1").status_code == 200
    for field in ("owner_id", "member_id", "owner", "identity"):
        r = _put(ctx, "liam", PIECE, "overwritten", **{field: ctx["rea_id"]})
        assert r.status_code == 422, (field, r.status_code)
    assert [n["content"] for n in _notes(ctx, "rea")] == ["rea v1"]
    assert _notes(ctx, "liam") == []


def test_client_supplied_owner_is_ignored_in_the_query(tmp_data_dir):
    ctx = _setup(tmp_data_dir)
    assert _put(ctx, "rea", PIECE, "rea secret").status_code == 200
    # Reading: asking for somebody else's notes by id returns only your own.
    for param in ("owner_id", "member_id", "owner"):
        assert _notes(ctx, "liam", **{param: ctx["rea_id"]}) == []
    # Writing: the query string cannot redirect the write to another owner.
    r = ctx["client"].put(
        f"/api/my-notes/{PIECE}",
        params={"owner_id": ctx["rea_id"]},
        json={"content": "liam note", "base_revision": 0, "mutation_id": "m9"},
        headers=ctx["liam"],
    )
    assert r.status_code == 200, r.text
    assert [n["content"] for n in _notes(ctx, "rea")] == ["rea secret"]
    assert [n["content"] for n in _notes(ctx, "liam")] == ["liam note"]


def test_conflict_response_only_ever_shows_the_callers_own_note(tmp_data_dir):
    ctx = _setup(tmp_data_dir)
    assert _put(ctx, "rea", PIECE, "rea secret").status_code == 200
    assert _put(ctx, "liam", PIECE, "liam v1").status_code == 200
    # Liam writes with a stale base: the 409 echoes the current note. It must be
    # his own, never the other note that exists on this piece.
    r = _put(ctx, "liam", PIECE, "liam v2", base=0, mutation="m2")
    assert r.status_code == 409
    assert r.json()["current"]["content"] == "liam v1"
    assert "rea secret" not in r.text
    assert r.headers["cache-control"] == "no-store"


def test_notes_require_a_valid_key(tmp_data_dir):
    ctx = _setup(tmp_data_dir)
    client = ctx["client"]
    body = {"content": "x", "base_revision": 0, "mutation_id": "m1"}
    assert client.get("/api/my-notes").status_code == 401
    assert client.put(f"/api/my-notes/{PIECE}", json=body).status_code == 401
    bad = {"X-Bandstand-Key": "f" * 64}
    assert client.get("/api/my-notes", headers=bad).status_code == 401
    assert client.put(f"/api/my-notes/{PIECE}", json=body, headers=bad).status_code == 401
    assert _rows(ctx) == []


def test_revoked_member_loses_access_to_notes(tmp_data_dir):
    ctx = _setup(tmp_data_dir)
    assert _put(ctx, "rea", PIECE, "rea secret").status_code == 200
    conn = db.connect(ctx["cfg"].db_path)
    members.revoke_member(conn, ctx["rea_id"])
    conn.close()
    assert ctx["client"].get("/api/my-notes", headers=ctx["rea"]).status_code == 401
    assert _put(ctx, "rea", PIECE, "again", base=1, mutation="m2").status_code == 401


def test_note_on_a_missing_or_deleted_piece_is_404(tmp_data_dir):
    ctx = _setup(tmp_data_dir)
    assert _put(ctx, "rea", "01HZZZZZZZZZZZZZZZZZZZZZZX", "x").status_code == 404
    conn = db.connect(ctx["cfg"].db_path)
    conn.execute("UPDATE pieces SET deleted_at = 5 WHERE id = ?", (OTHER_PIECE,))
    conn.close()
    assert _put(ctx, "rea", OTHER_PIECE, "x").status_code == 404
    assert _rows(ctx) == []


def test_retry_with_the_same_mutation_is_idempotent(tmp_data_dir):
    ctx = _setup(tmp_data_dir)
    first = _put(ctx, "rea", PIECE, "rea v1")
    again = _put(ctx, "rea", PIECE, "rea v1")
    assert first.status_code == again.status_code == 200
    assert again.json()["revision"] == 1
    assert len(_rows(ctx)) == 1


def test_note_content_never_appears_in_the_manifest(tmp_data_dir):
    # The manifest is mirrored to every paired device, members included. A note
    # leaking into it would hand every member everybody's private notes.
    ctx = _setup(tmp_data_dir)
    marker = "PRIVATE-NOTE-MARKER-8f3a"
    assert _put(ctx, "rea", PIECE, marker).status_code == 200
    for who in ("director", "rea", "liam"):
        r = ctx["client"].get("/api/manifest", headers=ctx[who])
        assert r.status_code == 200
        assert marker not in r.text, who
        assert "personal_notes" not in r.json(), who
