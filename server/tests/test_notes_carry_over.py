"""Private notes survive a new sign-in link.

Notes are keyed by member id, and both `rotate` (CLI) and replace (API) mint a new
id. The rule under test: the person keeps their notes under the new id, the move
happens in the same transaction as the re-mint, nobody else gains sight of them,
and notes already left behind under an old id can be reattached by the director.
"""

import sys

import pytest
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


def _hdr(key):
    return {"X-Bandstand-Key": key}


def _put(ctx, headers, piece, content, base=0, mutation="m1"):
    body = {"content": content, "base_revision": base, "mutation_id": mutation}
    return ctx["client"].put(f"/api/my-notes/{piece}", json=body, headers=headers)


def _notes(ctx, headers):
    r = ctx["client"].get("/api/my-notes", headers=headers)
    assert r.status_code == 200, r.text
    return sorted(r.json()["notes"], key=lambda n: n["piece_id"])


def _rows(ctx):
    conn = db.connect(ctx["cfg"].db_path)
    try:
        return [dict(r) for r in conn.execute(
            "SELECT owner_id, piece_id, content, revision FROM personal_notes "
            "ORDER BY owner_id, piece_id"
        )]
    finally:
        conn.close()


def _seed_rea(ctx):
    assert _put(ctx, ctx["rea"], PIECE, "watch the bridge").status_code == 200
    assert _put(ctx, ctx["rea"], PIECE, "watch the bridge, breathe", base=1, mutation="m2").status_code == 200
    assert _put(ctx, ctx["rea"], OTHER_PIECE, "brushes").status_code == 200
    assert _put(ctx, ctx["liam"], PIECE, "liam secret").status_code == 200


def _assert_notes_followed_rea(ctx, new_id, new_key):
    # The new key reads the same notes, revisions intact, so a device that kept
    # editing offline still writes against the right base revision.
    mine = _notes(ctx, _hdr(new_key))
    assert [(n["piece_id"], n["content"], n["revision"]) for n in mine] == [
        (PIECE, "watch the bridge, breathe", 2),
        (OTHER_PIECE, "brushes", 1),
    ]
    r = _put(ctx, _hdr(new_key), PIECE, "watch the bridge, breathe, smile", base=2, mutation="m3")
    assert r.status_code == 200, r.text
    assert r.json()["revision"] == 3
    # Nothing is left under the old id; nobody else sees a thing.
    assert [row["owner_id"] for row in _rows(ctx) if row["owner_id"] == ctx["rea_id"]] == []
    assert [n["content"] for n in _notes(ctx, ctx["liam"])] == ["liam secret"]
    assert _notes(ctx, ctx["director"]) == []
    for text in ("watch the bridge", "brushes"):
        assert text not in ctx["client"].get("/api/my-notes", headers=ctx["liam"]).text
        assert text not in ctx["client"].get("/api/my-notes", headers=ctx["director"]).text
    # The old key is dead, so the old id cannot be used to read anything either.
    assert ctx["client"].get("/api/my-notes", headers=ctx["rea"]).status_code == 401
    assert new_id != ctx["rea_id"]


# ---------- rotate (CLI path) ----------

def test_rotate_carries_notes_to_the_new_id(tmp_data_dir):
    ctx = _setup(tmp_data_dir)
    _seed_rea(ctx)
    conn = db.connect(ctx["cfg"].db_path)
    try:
        result = members.rotate_member(conn, ctx["rea_id"])
    finally:
        conn.close()
    assert result is not None
    new_ident, new_key = result
    _assert_notes_followed_rea(ctx, new_ident.id, new_key)


def test_rotate_is_one_transaction(tmp_data_dir, monkeypatch):
    # If the carry-over fails, the rotation must not half-happen: the old key still
    # works, no new member exists, and the notes are where they were.
    ctx = _setup(tmp_data_dir)
    _seed_rea(ctx)
    before = _rows(ctx)

    def boom(conn, from_id, to_id):
        raise RuntimeError("disk full")

    monkeypatch.setattr(members, "carry_notes", boom)
    conn = db.connect(ctx["cfg"].db_path)
    try:
        with pytest.raises(RuntimeError):
            members.rotate_member(conn, ctx["rea_id"])
        assert not conn.in_transaction
        names = [dict(r) for r in conn.execute(
            "SELECT id, revoked_at FROM members WHERE name = 'Rea'")]
    finally:
        conn.close()
    assert names == [{"id": ctx["rea_id"], "revoked_at": None}]
    assert _rows(ctx) == before
    assert [n["content"] for n in _notes(ctx, ctx["rea"])] == [
        "watch the bridge, breathe", "brushes"]


def test_rotate_cli_says_the_notes_moved(tmp_data_dir, monkeypatch, capsys):
    ctx = _setup(tmp_data_dir)
    _seed_rea(ctx)
    monkeypatch.setattr(sys, "argv", ["members", "rotate", ctx["rea_id"]])
    assert members._main() == 0
    captured = capsys.readouterr()
    out = captured.out
    new_id = next(line.split()[-1] for line in out.splitlines() if line.startswith("new id:"))
    new_key = next(line.split()[-1] for line in out.splitlines() if line.startswith("new key:"))
    # Standard output keeps its two lines for scripts; the note goes to stderr.
    assert [line.split(":")[0] for line in out.splitlines()] == ["new id", "new key"]
    assert "private notes moved" in captured.err
    _assert_notes_followed_rea(ctx, new_id, new_key)


# ---------- replace (API path) ----------

def test_replace_link_carries_notes_to_the_new_id(tmp_data_dir):
    ctx = _setup(tmp_data_dir)
    _seed_rea(ctx)
    r = ctx["client"].post(f"/api/member-invites/{ctx['rea_id']}/replace", headers=ctx["director"])
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["name"] == "Rea"
    _assert_notes_followed_rea(ctx, body["id"], body["key"])


def test_replace_is_one_transaction(tmp_data_dir, monkeypatch):
    ctx = _setup(tmp_data_dir)
    _seed_rea(ctx)
    before = _rows(ctx)

    def boom(conn, from_id, to_id):
        raise RuntimeError("disk full")

    monkeypatch.setattr(members, "carry_notes", boom)
    with pytest.raises(RuntimeError):
        ctx["client"].post(f"/api/member-invites/{ctx['rea_id']}/replace", headers=ctx["director"])
    assert _rows(ctx) == before
    assert [n["content"] for n in _notes(ctx, ctx["rea"])] == [
        "watch the bridge, breathe", "brushes"]
    listed = ctx["client"].get("/api/member-invites", headers=ctx["director"]).json()["members"]
    assert [m["id"] for m in listed if m["name"] == "Rea"] == [ctx["rea_id"]]


def test_a_member_cannot_replace_a_link(tmp_data_dir):
    ctx = _setup(tmp_data_dir)
    _seed_rea(ctx)
    r = ctx["client"].post(f"/api/member-invites/{ctx['rea_id']}/replace", headers=ctx["liam"])
    assert r.status_code == 403
    assert [n["content"] for n in _notes(ctx, ctx["rea"])] == [
        "watch the bridge, breathe", "brushes"]


# ---------- reattach (repair for notes orphaned before this fix) ----------

def _orphan_rea(ctx):
    """Reproduce the old behaviour: revoke Rea and mint her again without a carry-over."""
    conn = db.connect(ctx["cfg"].db_path)
    try:
        assert members.revoke_member(conn, ctx["rea_id"])
        new_ident, new_key = members.add_member(conn, "Rea", "member")
    finally:
        conn.close()
    assert _notes(ctx, _hdr(new_key)) == []
    return new_ident, new_key


def _cli(monkeypatch, *args):
    monkeypatch.setattr(sys, "argv", ["members", *args])
    return members._main()


def test_reattach_notes_moves_orphaned_notes_to_the_new_id(tmp_data_dir, monkeypatch, capsys):
    ctx = _setup(tmp_data_dir)
    _seed_rea(ctx)
    new_ident, new_key = _orphan_rea(ctx)
    assert _cli(monkeypatch, "reattach-notes", ctx["rea_id"], new_ident.id) == 0
    assert capsys.readouterr().out == "moved: 2\n"
    _assert_notes_followed_rea(ctx, new_ident.id, new_key)


def test_reattach_notes_keeps_what_the_new_id_already_wrote(tmp_data_dir, monkeypatch, capsys):
    ctx = _setup(tmp_data_dir)
    _seed_rea(ctx)
    new_ident, new_key = _orphan_rea(ctx)
    assert _put(ctx, _hdr(new_key), PIECE, "fresh start").status_code == 200
    assert _cli(monkeypatch, "reattach-notes", ctx["rea_id"], new_ident.id) == 0
    out = capsys.readouterr().out
    assert out.startswith("moved: 1\nkept:  1")
    mine = _notes(ctx, _hdr(new_key))
    assert [(n["piece_id"], n["content"], n["revision"]) for n in mine] == [
        (PIECE, "fresh start", 1),
        (OTHER_PIECE, "brushes", 1),
    ]
    # The old note on that song is left where it was: unreadable, but not destroyed.
    old = [r for r in _rows(ctx) if r["owner_id"] == ctx["rea_id"]]
    assert [(r["piece_id"], r["content"]) for r in old] == [(PIECE, "watch the bridge, breathe")]
    assert [n["content"] for n in _notes(ctx, ctx["liam"])] == ["liam secret"]


def test_reattach_notes_refuses_a_different_person(tmp_data_dir, monkeypatch, capsys):
    ctx = _setup(tmp_data_dir)
    _seed_rea(ctx)
    _orphan_rea(ctx)
    before = _rows(ctx)
    # Rea's old notes must not land in Liam's account by a slip of the id.
    assert _cli(monkeypatch, "reattach-notes", ctx["rea_id"], ctx["liam_id"]) == 1
    err = capsys.readouterr().err
    assert "Rea" in err and "Liam" in err and "--allow-different-name" in err
    assert _rows(ctx) == before
    assert [n["content"] for n in _notes(ctx, ctx["liam"])] == ["liam secret"]
    # With the override the director takes responsibility, and the move happens.
    assert _cli(monkeypatch, "reattach-notes", ctx["rea_id"], ctx["liam_id"], "--allow-different-name") == 0
    assert [n["content"] for n in _notes(ctx, ctx["liam"])] == [
        "liam secret", "brushes"]


def test_reattach_notes_refuses_bad_ids(tmp_data_dir, monkeypatch, capsys):
    ctx = _setup(tmp_data_dir)
    _seed_rea(ctx)
    new_ident, _ = _orphan_rea(ctx)
    before = _rows(ctx)
    # Old id nobody ever had; new id that is revoked; the same id twice.
    assert _cli(monkeypatch, "reattach-notes", "01HNOBODYNOBODYNOBODYNOBODY", new_ident.id) == 1
    assert "No member has ever had" in capsys.readouterr().err
    assert _cli(monkeypatch, "reattach-notes", new_ident.id, ctx["rea_id"]) == 1
    assert "not a member who can sign in" in capsys.readouterr().err
    assert _cli(monkeypatch, "reattach-notes", new_ident.id, new_ident.id) == 1
    assert "the same" in capsys.readouterr().err
    assert _rows(ctx) == before


def test_reattach_notes_refuses_to_drain_a_working_id(tmp_data_dir, monkeypatch, capsys):
    """Two active members can share a name (the CLI add has no clash check). A slip
    that names the working one as the old id must not empty their account."""
    ctx = _setup(tmp_data_dir)
    _seed_rea(ctx)
    conn = db.connect(ctx["cfg"].db_path)
    try:
        twin, _ = members.add_member(conn, "Rea", "member")
    finally:
        conn.close()
    before = _rows(ctx)
    assert _cli(monkeypatch, "reattach-notes", ctx["rea_id"], twin.id) == 1
    assert "still a working id" in capsys.readouterr().err
    assert _rows(ctx) == before
    assert [n["content"] for n in _notes(ctx, ctx["rea"])] == [
        "watch the bridge, breathe", "brushes"]


def test_reattach_notes_never_widens_who_can_read(tmp_data_dir, monkeypatch, capsys):
    ctx = _setup(tmp_data_dir)
    _seed_rea(ctx)
    new_ident, new_key = _orphan_rea(ctx)
    assert _cli(monkeypatch, "reattach-notes", ctx["rea_id"], new_ident.id) == 0
    capsys.readouterr()
    marker_texts = ("watch the bridge", "brushes")
    for who in ("liam", "director"):
        r = ctx["client"].get("/api/my-notes", headers=ctx[who])
        assert r.status_code == 200
        for text in marker_texts:
            assert text not in r.text, who
        m = ctx["client"].get("/api/manifest", headers=ctx[who])
        for text in marker_texts:
            assert text not in m.text, who
    assert ctx["client"].get("/api/my-notes", headers=ctx["rea"]).status_code == 401
