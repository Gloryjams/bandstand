"""The public share surface. Most of these are security tests: what a stranger holding
one token can and cannot reach."""
import json
import re
import shutil
import sqlite3
import threading
import time
from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from server import config, db
from server.ingest import pipeline
from server.ulid import new_ulid

FIXTURES = Path(__file__).parent / "fixtures"

# Headers that legitimately differ between two responses to the same request.
_VOLATILE = {"date", "server"}


def _setup(tmp_data_dir):
    from server.public import build_public_app
    cfg = config.load()
    db.bootstrap(cfg)
    for name, src in (
        ("Take Five.pdf", "three_page_titled.pdf"),
        ("Misty.pdf", "five_page.pdf"),
    ):
        target = cfg.library_dir / name
        shutil.copy(FIXTURES / src, target)
        pipeline.ingest_path(cfg, target)
    return TestClient(build_public_app(), raise_server_exceptions=False), cfg


def _pieces(cfg) -> dict[str, str]:
    conn = db.connect(cfg.db_path)
    try:
        return {r["title"]: r["id"] for r in conn.execute("SELECT id, title FROM pieces")}
    finally:
        conn.close()


def _file_of(cfg, piece_id: str):
    conn = db.connect(cfg.db_path)
    try:
        return conn.execute(
            "SELECT id, page_count, content_hash FROM files WHERE piece_id = ?",
            (piece_id,),
        ).fetchone()
    finally:
        conn.close()


def _share(cfg, kind, target_id, token, expires_at=None, revoked_at=None) -> str:
    conn = db.connect(cfg.db_path)
    try:
        share_id = new_ulid()
        conn.execute(
            "INSERT INTO shares "
            "(id, token, target_kind, target_id, label, created_at, expires_at, revoked_at) "
            "VALUES (?, ?, ?, ?, 'L', ?, ?, ?)",
            (share_id, token, kind, target_id, int(time.time() * 1000), expires_at, revoked_at),
        )
        return share_id
    finally:
        conn.close()


def _revoke(cfg, token: str) -> None:
    conn = db.connect(cfg.db_path)
    try:
        conn.execute(
            "UPDATE shares SET revoked_at = ? WHERE token = ?",
            (int(time.time() * 1000), token),
        )
    finally:
        conn.close()


def _setlist(cfg, items, setlist_id="SL1", name="Friday at the Blue Room") -> str:
    """items: list of (kind, piece_id_or_None, break_label_or_None)."""
    now = int(time.time() * 1000)
    conn = db.connect(cfg.db_path)
    try:
        conn.execute(
            "INSERT INTO setlists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (setlist_id, name, now, now),
        )
        for i, (kind, piece_id, label) in enumerate(items):
            conn.execute(
                "INSERT INTO setlist_items "
                "(id, setlist_id, kind, piece_id, break_label, ordinal) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (f"{setlist_id}-{i}", setlist_id, kind, piece_id, label, i),
            )
        return setlist_id
    finally:
        conn.close()


def _add_file_row(cfg, piece_id: str, filename: str, kind="pdf", page_count=1) -> str:
    file_id = new_ulid()
    conn = db.connect(cfg.db_path)
    try:
        conn.execute(
            "INSERT INTO files "
            "(id, piece_id, kind, filename, page_count, ordinal, content_hash, bytes, added_at) "
            "VALUES (?, ?, ?, ?, ?, 99, ?, 1, 1)",
            (file_id, piece_id, kind, filename, page_count, f"hash-{file_id}"),
        )
        return file_id
    finally:
        conn.close()


def _chart_piece(cfg, chart: dict, piece_id="CHARTPIECE") -> str:
    now = int(time.time() * 1000)
    conn = db.connect(cfg.db_path)
    try:
        conn.execute(
            "INSERT INTO pieces (id, title, page_count, added_at, updated_at, kind, chart_json) "
            "VALUES (?, ?, 0, ?, ?, 'chart', ?)",
            (piece_id, chart.get("title", "Chart"), now, now, json.dumps(chart)),
        )
        return piece_id
    finally:
        conn.close()


# The CSP nonce is per-response by design, so it is masked before comparing. It is a fixed
# 22 characters, so masking it cannot hide a length difference: Content-Length is compared
# unmasked, and a body that differed for any other reason would still show up.
_BODY_NONCE = re.compile(rb'nonce="[A-Za-z0-9_-]{22}"')
_HEADER_NONCE = re.compile(r"'nonce-[A-Za-z0-9_-]{22}'")


def _fingerprint(r):
    return (
        r.status_code,
        _BODY_NONCE.sub(b'nonce="MASKED"', r.content),
        tuple(sorted(
            (k.lower(), _HEADER_NONCE.sub("'nonce-MASKED'", v))
            for k, v in r.headers.items() if k.lower() not in _VOLATILE
        )),
    )


# ---------------------------------------------------------------- landing


def test_piece_share_landing_opens_the_pager(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    r = client.get("/s/tokenpiece000001")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["referrer-policy"] == "no-referrer"
    assert r.headers["x-robots-tag"] == "noindex, nofollow, noarchive"
    file_row = _file_of(cfg, piece_id)
    assert f"/s/tokenpiece000001/p/{file_row['id']}/0.png" in r.text
    assert f"/s/tokenpiece000001/p/{file_row['id']}/2.png" in r.text
    assert "</span> / 3</span>" in r.text  # page counter total
    assert "Shared from a gig book" in r.text


def test_setlist_landing_lists_members_and_breaks(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    pieces = _pieces(cfg)
    setlist_id = _setlist(cfg, [
        ("piece", pieces["Take Five"], None),
        ("break", None, "Set break"),
        ("piece", pieces["Misty"], None),
    ])
    _share(cfg, "setlist", setlist_id, "tokenset00000001")
    r = client.get("/s/tokenset00000001")
    assert r.status_code == 200
    assert f"/s/tokenset00000001/piece/{pieces['Take Five']}" in r.text
    assert f"/s/tokenset00000001/piece/{pieces['Misty']}" in r.text
    assert "Set break" in r.text
    assert "Friday at the Blue Room" in r.text


def test_setlist_landing_skips_deleted_members(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    pieces = _pieces(cfg)
    setlist_id = _setlist(cfg, [
        ("piece", pieces["Take Five"], None),
        ("piece", pieces["Misty"], None),
    ])
    _share(cfg, "setlist", setlist_id, "tokenset00000001")
    conn = db.connect(cfg.db_path)
    try:
        conn.execute("UPDATE pieces SET deleted_at = 1 WHERE id = ?", (pieces["Misty"],))
    finally:
        conn.close()
    r = client.get("/s/tokenset00000001")
    assert f"/s/tokenset00000001/piece/{pieces['Take Five']}" in r.text
    assert pieces["Misty"] not in r.text


def test_chordpro_only_piece_shows_the_placeholder(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    now = int(time.time() * 1000)
    conn = db.connect(cfg.db_path)
    try:
        conn.execute(
            "INSERT INTO pieces (id, title, page_count, added_at, updated_at) "
            "VALUES ('CHORDPIECE', 'Autumn Leaves', 1, ?, ?)",
            (now, now),
        )
    finally:
        conn.close()
    _add_file_row(cfg, "CHORDPIECE", "leaves.cho", kind="chordpro")
    setlist_id = _setlist(cfg, [("piece", "CHORDPIECE", None)])
    _share(cfg, "setlist", setlist_id, "tokenset00000001")

    landing = client.get("/s/tokenset00000001")
    assert "not supported in shared view" in landing.text
    assert "/s/tokenset00000001/piece/CHORDPIECE" not in landing.text

    page = client.get("/s/tokenset00000001/piece/CHORDPIECE")
    assert page.status_code == 200
    assert "not supported in the shared view" in page.text


# ---------------------------------------------------------------- 404 parity


def test_every_failure_returns_the_identical_404(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    pieces = _pieces(cfg)
    shared, other = pieces["Take Five"], pieces["Misty"]
    _share(cfg, "piece", shared, "tokengood0000001")
    _share(cfg, "piece", shared, "tokenexpired0001", expires_at=1)
    _share(cfg, "piece", shared, "tokenrevoked0001", revoked_at=1)
    other_file = _file_of(cfg, other)

    responses = [
        client.get("/s/not a token!"),                       # malformed
        client.get("/s/" + "z" * 32),                        # unknown
        client.get("/s/tokenexpired0001"),                        # expired
        client.get("/s/tokenrevoked0001"),                        # revoked
        client.get(f"/s/tokengood0000001/piece/{other}"),            # out of reach
        client.get(f"/s/tokengood0000001/p/{other_file['id']}/0.png"),  # out of reach, render
        client.get("/s/tokengood0000001/chart/" + other),            # out of reach, chart
    ]
    first = _fingerprint(responses[0])
    assert first[0] == 404
    for r in responses[1:]:
        assert _fingerprint(r) == first


def test_unrouted_paths_share_the_same_404(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    _share(cfg, "piece", _pieces(cfg)["Take Five"], "tokengood0000001")
    assert _fingerprint(client.get("/anything")) == _fingerprint(client.get("/s/" + "z" * 32))
    # A guest asset that does not exist leaves by the same door as everything else.
    assert _fingerprint(client.get("/guest/nope.js")) == _fingerprint(client.get("/anything"))


def test_guest_mount_is_contained(tmp_data_dir):
    from server import public
    client, _ = _setup(tmp_data_dir)
    if not public._STATIC_GUEST.is_dir():
        pytest.skip("guest bundle not built in this tree")
    assert client.get("/guest/guest.js").status_code == 200
    for escape in ("/guest/../../db.py", "/guest/..%2f..%2fdb.py", "/guest/....//db.py"):
        # Whatever the status, server source must never come back down the guest mount.
        assert b"connect_ro" not in client.get(escape).content


def test_expiry_is_evaluated_per_request(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    _share(cfg, "piece", piece_id, "tokensoon0000001", expires_at=int(time.time() * 1000) + 60_000)
    assert client.get("/s/tokensoon0000001").status_code == 200
    conn = db.connect(cfg.db_path)
    try:
        conn.execute("UPDATE shares SET expires_at = 1 WHERE token = 'tokensoon0000001'")
    finally:
        conn.close()
    assert client.get("/s/tokensoon0000001").status_code == 404


# ---------------------------------------------------------------- reachability


def test_piece_token_cannot_reach_another_piece(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    pieces = _pieces(cfg)
    _share(cfg, "piece", pieces["Take Five"], "tokenpiece000001")
    mine = _file_of(cfg, pieces["Take Five"])
    theirs = _file_of(cfg, pieces["Misty"])
    assert client.get(f"/s/tokenpiece000001/p/{mine['id']}/0.png").status_code == 200
    assert client.get(f"/s/tokenpiece000001/p/{theirs['id']}/0.png").status_code == 404
    assert client.get(f"/s/tokenpiece000001/piece/{pieces['Misty']}").status_code == 404


def test_setlist_token_reaches_members_only(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    pieces = _pieces(cfg)
    setlist_id = _setlist(cfg, [("piece", pieces["Take Five"], None)])
    _share(cfg, "setlist", setlist_id, "tokenset00000001")
    member = _file_of(cfg, pieces["Take Five"])
    outsider = _file_of(cfg, pieces["Misty"])
    assert client.get(f"/s/tokenset00000001/piece/{pieces['Take Five']}").status_code == 200
    assert client.get(f"/s/tokenset00000001/p/{member['id']}/0.png").status_code == 200
    assert client.get(f"/s/tokenset00000001/piece/{pieces['Misty']}").status_code == 404
    assert client.get(f"/s/tokenset00000001/p/{outsider['id']}/0.png").status_code == 404


def test_removing_a_piece_from_the_setlist_revokes_it_immediately(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    pieces = _pieces(cfg)
    setlist_id = _setlist(cfg, [("piece", pieces["Take Five"], None)])
    _share(cfg, "setlist", setlist_id, "tokenset00000001")
    assert client.get(f"/s/tokenset00000001/piece/{pieces['Take Five']}").status_code == 200
    conn = db.connect(cfg.db_path)
    try:
        conn.execute("DELETE FROM setlist_items WHERE setlist_id = ?", (setlist_id,))
    finally:
        conn.close()
    assert client.get(f"/s/tokenset00000001/piece/{pieces['Take Five']}").status_code == 404


def test_a_break_row_never_resolves_as_a_piece(tmp_data_dir):
    # A break row carrying a piece_id (corruption, or a client bug) must not become a
    # readable piece: reachability requires kind = 'piece'.
    client, cfg = _setup(tmp_data_dir)
    pieces = _pieces(cfg)
    setlist_id = _setlist(cfg, [("break", pieces["Misty"], "Set break")])
    _share(cfg, "setlist", setlist_id, "tokenset00000001")
    assert client.get(f"/s/tokenset00000001/piece/{pieces['Misty']}").status_code == 404
    landing = client.get("/s/tokenset00000001")
    assert "Set break" in landing.text
    assert f"/s/tokenset00000001/piece/{pieces['Misty']}" not in landing.text


def test_a_hard_deleted_setlist_takes_its_share_with_it(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    setlist_id = _setlist(cfg, [("piece", _pieces(cfg)["Take Five"], None)])
    _share(cfg, "setlist", setlist_id, "tokenset00000001")
    assert client.get("/s/tokenset00000001").status_code == 200
    conn = db.connect(cfg.db_path)
    try:
        conn.execute("DELETE FROM setlists WHERE id = ?", (setlist_id,))
    finally:
        conn.close()
    assert client.get("/s/tokenset00000001").status_code == 404


# ---------------------------------------------------------------- path containment


@pytest.mark.parametrize("hostile", ["../../evil.pdf", "..\\..\\evil.pdf", "sub/../../evil.pdf"])
def test_traversing_filename_cannot_escape_the_library(tmp_data_dir, hostile):
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    shutil.copy(FIXTURES / "three_page_titled.pdf", cfg.data_dir.parent / "evil.pdf")
    file_id = _add_file_row(cfg, piece_id, hostile)
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    assert client.get(f"/s/tokenpiece000001/p/{file_id}/0.png").status_code == 404


def test_absolute_filename_cannot_escape_the_library(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    outside = cfg.data_dir.parent / "outside.pdf"
    shutil.copy(FIXTURES / "three_page_titled.pdf", outside)
    file_id = _add_file_row(cfg, piece_id, str(outside))
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    assert outside.is_file()
    assert client.get(f"/s/tokenpiece000001/p/{file_id}/0.png").status_code == 404


def test_missing_file_on_disk_is_a_404(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    file_id = _add_file_row(cfg, piece_id, "not-there.pdf")
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    assert client.get(f"/s/tokenpiece000001/p/{file_id}/0.png").status_code == 404


# ---------------------------------------------------------------- render bounds


def test_render_page_bounds(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    file_row = _file_of(cfg, piece_id)
    assert file_row["page_count"] == 3
    assert client.get(f"/s/tokenpiece000001/p/{file_row['id']}/2.png").status_code == 200
    assert client.get(f"/s/tokenpiece000001/p/{file_row['id']}/3.png").status_code == 404
    assert client.get(f"/s/tokenpiece000001/p/{file_row['id']}/-1.png").status_code == 404
    assert client.get(f"/s/tokenpiece000001/p/{file_row['id']}/abc.png").status_code == 404


@pytest.mark.parametrize(
    "page",
    [
        "9" * 5000,   # past CPython's int-string conversion limit: int() would raise
        "٢",     # Arabic-Indic 2: str.isdigit() says yes, int() says no
        "²",     # superscript 2: same trap
        "1_0",        # int() accepts underscores, a URL should not
        "0x10",
        "",
    ],
)
def test_a_malformed_page_number_is_a_404_not_a_500(tmp_data_dir, page):
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    file_row = _file_of(cfg, piece_id)
    r = client.get(f"/s/tokenpiece000001/p/{file_row['id']}/{page}.png")
    assert r.status_code == 404


def test_page_index_is_local_to_the_file(tmp_data_dir):
    # A two-file piece: the second file's pages are addressed 0..n-1 under its own id,
    # not continued from the first file's count.
    client, cfg = _setup(tmp_data_dir)
    pieces = _pieces(cfg)
    conn = db.connect(cfg.db_path)
    try:
        conn.execute(
            "UPDATE files SET piece_id = ?, ordinal = 2 WHERE piece_id = ?",
            (pieces["Take Five"], pieces["Misty"]),
        )
    finally:
        conn.close()
    _share(cfg, "piece", pieces["Take Five"], "tokenpiece000001")
    r = client.get("/s/tokenpiece000001")
    assert "</span> / 8</span>" in r.text  # 3 pages + 5 pages, one flat manifest
    conn = db.connect(cfg.db_path)
    try:
        second = conn.execute(
            "SELECT id FROM files WHERE piece_id = ? AND ordinal = 2", (pieces["Take Five"],)
        ).fetchone()["id"]
    finally:
        conn.close()
    assert f"/s/tokenpiece000001/p/{second}/4.png" in r.text
    assert client.get(f"/s/tokenpiece000001/p/{second}/4.png").status_code == 200


def test_oversize_source_file_is_refused(tmp_data_dir, monkeypatch):
    from server import public
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    file_row = _file_of(cfg, piece_id)
    monkeypatch.setattr(public, "_MAX_SOURCE_BYTES", 10)
    assert client.get(f"/s/tokenpiece000001/p/{file_row['id']}/0.png").status_code == 404


def test_too_many_pages_is_refused(tmp_data_dir, monkeypatch):
    from server import public
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    file_row = _file_of(cfg, piece_id)
    monkeypatch.setattr(public, "_MAX_PDF_PAGES", 2)  # the fixture has 3
    assert client.get(f"/s/tokenpiece000001/p/{file_row['id']}/0.png").status_code == 404


def test_a_pathological_pdf_is_a_404_not_a_500(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    (cfg.library_dir / "broken.pdf").write_bytes(b"%PDF-1.4 this is not a pdf")
    file_id = _add_file_row(cfg, piece_id, "broken.pdf")
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    r = client.get(f"/s/tokenpiece000001/p/{file_id}/0.png")
    assert r.status_code == 404
    assert _fingerprint(r) == _fingerprint(client.get("/s/" + "z" * 32))


def test_rendered_page_is_a_png_within_the_pixel_cap(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    file_row = _file_of(cfg, piece_id)
    r = client.get(f"/s/tokenpiece000001/p/{file_row['id']}/0.png")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"
    w, h = Image.open(BytesIO(r.content)).size
    assert w * h <= 4_000_000
    assert w >= 1000  # rendered well above 1x, not a thumbnail


def test_image_file_is_decoded_and_re_encoded(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    source = cfg.library_dir / "Cover art.png"
    Image.new("RGB", (120, 80), (10, 20, 30)).save(source)
    pipeline.ingest_path(cfg, source)
    pieces = _pieces(cfg)
    piece_id = pieces["Cover art"]
    _share(cfg, "piece", piece_id, "tokenimg00000001")
    file_row = _file_of(cfg, piece_id)
    landing = client.get("/s/tokenimg00000001")
    assert f"/s/tokenimg00000001/img/{file_row['id']}.png" in landing.text
    # Trailing bytes after the PNG stream: a raw file read would hand them to the guest,
    # a decode-and-re-encode cannot.
    with open(source, "ab") as f:
        f.write(b"TRAILING-SECRET-BYTES")
    r = client.get(f"/s/tokenimg00000001/img/{file_row['id']}.png")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert b"TRAILING-SECRET-BYTES" not in r.content
    assert Image.open(BytesIO(r.content)).size == (120, 80)


def test_image_route_rejects_a_pdf_file_id(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    file_row = _file_of(cfg, piece_id)
    assert client.get(f"/s/tokenpiece000001/img/{file_row['id']}.png").status_code == 404


# ---------------------------------------------------------------- caching


def test_png_cache_headers_and_conditional_request(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    file_row = _file_of(cfg, piece_id)
    url = f"/s/tokenpiece000001/p/{file_row['id']}/0.png"

    first = client.get(url)
    assert first.headers["cache-control"] == "private, no-cache"
    etag = first.headers["etag"]
    assert etag.startswith(f'"{file_row["content_hash"]}:0:')

    again = client.get(url, headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert again.content == b""

    stale = client.get(url, headers={"If-None-Match": '"something-else"'})
    assert stale.status_code == 200


def test_conditional_request_404s_when_the_file_left_the_disk(tmp_data_dir):
    # A 304 asserts the guest's cached copy is still valid. If the file is gone but its row
    # lingers, the unconditional request 404s, so the conditional one must agree rather
    # than keep serving a page that no longer exists.
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    file_row = _file_of(cfg, piece_id)
    url = f"/s/tokenpiece000001/p/{file_row['id']}/0.png"
    etag = client.get(url).headers["etag"]

    (cfg.library_dir / "Take Five.pdf").unlink()  # row left behind on purpose

    assert client.get(url).status_code == 404
    conditional = client.get(url, headers={"If-None-Match": etag})
    assert conditional.status_code == 404
    assert _fingerprint(conditional) == _fingerprint(client.get("/s/" + "z" * 32))


def test_conditional_image_request_404s_when_the_file_left_the_disk(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    source = cfg.library_dir / "Cover art.png"
    Image.new("RGB", (60, 40), (10, 20, 30)).save(source)
    pipeline.ingest_path(cfg, source)
    piece_id = _pieces(cfg)["Cover art"]
    _share(cfg, "piece", piece_id, "tokenimg00000001")
    file_row = _file_of(cfg, piece_id)
    url = f"/s/tokenimg00000001/img/{file_row['id']}.png"
    etag = client.get(url).headers["etag"]

    source.unlink()

    assert client.get(url).status_code == 404
    assert client.get(url, headers={"If-None-Match": etag}).status_code == 404


def test_revoked_share_404s_a_conditional_request_instead_of_304(tmp_data_dir):
    # The 304 shortcut must live behind the token gate, or a revoked link keeps working
    # for anyone whose browser already has the ETag.
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    file_row = _file_of(cfg, piece_id)
    url = f"/s/tokenpiece000001/p/{file_row['id']}/0.png"
    etag = client.get(url).headers["etag"]
    _revoke(cfg, "tokenpiece000001")
    after = client.get(url, headers={"If-None-Match": etag})
    assert after.status_code == 404
    assert _fingerprint(after) == _fingerprint(client.get("/s/" + "z" * 32))


def test_html_and_chart_are_never_stored(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    piece_id = _chart_piece(cfg, {"id": "c1", "title": "Blue Bossa", "sections": []})
    _share(cfg, "piece", piece_id, "tokenchart000001")
    assert client.get("/s/tokenchart000001").headers["cache-control"] == "no-store"
    assert client.get(f"/s/tokenchart000001/chart/{piece_id}").headers["cache-control"] == "no-store"


def test_render_cache_produces_once(tmp_data_dir):
    from server import public
    cfg = config.load()
    db.bootstrap(cfg)
    calls = []

    def produce():
        calls.append(1)
        return b"png-bytes"

    assert public.cached_render(cfg, "k1", produce) == b"png-bytes"
    assert public.cached_render(cfg, "k1", produce) == b"png-bytes"
    assert len(calls) == 1
    assert public.cache_path(cfg, "k1").is_file()
    assert public.cache_dir(cfg) == cfg.data_dir / ".share-cache"


def test_cache_eviction_trims_to_the_cap(tmp_data_dir, monkeypatch):
    from server import public
    cfg = config.load()
    db.bootstrap(cfg)
    monkeypatch.setattr(public, "_CACHE_CAP_BYTES", 3000)
    for i in range(10):
        public.cached_render(cfg, f"key{i}", lambda: b"x" * 1000)
    remaining = list(public.cache_dir(cfg).glob("*.png"))
    assert 0 < len(remaining) <= 3
    assert not list(public.cache_dir(cfg).glob("*.tmp"))


# ---------------------------------------------------------------- chart DTO


def _full_chart() -> dict:
    return {
        "id": "chart-abc-123",
        "title": "Blue Bossa",
        "artist": "Kenny Dorham",
        "key": "Cm",
        "time": "4/4",
        "bpm": "150",
        "style": "Bossa",
        "capo": "",
        "tags": ["private", "do not share"],
        "createdAt": 1700000000,
        "updatedAt": 1800000000,
        "notes": "The director's private performance note",
        "sections": [{"id": "s1", "label": "Head", "bars": [{"chords": "Cm7"}]}],
        "arrangement": [{"id": "a1", "sectionId": "s1", "repeats": 2}],
        "settings": {"barsPerLine": 4},
    }


def test_chart_dto_is_an_allowlist(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    piece_id = _chart_piece(cfg, _full_chart())
    _share(cfg, "piece", piece_id, "tokenchart000001")
    body = client.get(f"/s/tokenchart000001/chart/{piece_id}").json()
    for private in ("id", "tags", "createdAt", "updatedAt", "notes"):
        assert private not in body
    assert body["title"] == "Blue Bossa"
    assert body["artist"] == "Kenny Dorham"
    assert set(body) == {
        "title", "artist", "key", "time", "bpm", "style", "capo",
        "sections", "arrangement", "settings",
    }
    # sections/arrangement pass through verbatim, ids included: the renderer needs them.
    assert body["sections"] == _full_chart()["sections"]
    assert body["arrangement"] == _full_chart()["arrangement"]


def test_unknown_chart_key_is_dropped(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    chart = _full_chart() | {"privateFieldAddedLater": "leak"}
    piece_id = _chart_piece(cfg, chart)
    _share(cfg, "piece", piece_id, "tokenchart000001")
    assert "privateFieldAddedLater" not in client.get(f"/s/tokenchart000001/chart/{piece_id}").text


def test_settings_is_always_present(tmp_data_dir):
    # The guest renderer expects a settings object even from a chart that never had one.
    client, cfg = _setup(tmp_data_dir)
    chart = _full_chart()
    del chart["settings"]
    piece_id = _chart_piece(cfg, chart)
    _share(cfg, "piece", piece_id, "tokenchart000001")
    body = client.get(f"/s/tokenchart000001/chart/{piece_id}").json()
    assert body["settings"] == {}


@pytest.mark.parametrize("broken", [{"sections": "not a list"}, {}])
def test_a_chart_without_usable_sections_is_a_404(tmp_data_dir, broken):
    # The bundle renders a 404 as "no longer available"; a DTO with no usable sections
    # would instead render as a blank chart, so it fails here.
    client, cfg = _setup(tmp_data_dir)
    chart = {k: v for k, v in _full_chart().items() if k != "sections"} | broken
    piece_id = _chart_piece(cfg, chart)
    _share(cfg, "piece", piece_id, "tokenchart000001")
    assert client.get(f"/s/tokenchart000001/chart/{piece_id}").status_code == 404


def test_chart_share_landing_is_a_bare_bundle_shell(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    piece_id = _chart_piece(cfg, _full_chart())
    _share(cfg, "piece", piece_id, "tokenchart000001")
    r = client.get("/s/tokenchart000001")
    assert r.status_code == 200
    assert '<link rel="stylesheet" href="/guest/guest.css">' in r.text
    assert '<script type="module" src="/guest/guest.js"></script>' in r.text
    assert f'data-chart-url="/s/tokenchart000001/chart/{piece_id}"' in r.text
    # The bundle fills the viewport and owns its own chrome, so the body carries nothing
    # but #guest-root and the script tag: no wrapper, no footer, none of this app's CSS.
    # The attribution rides as a data attribute; the bundle renders it.
    body = r.text.split("<body>", 1)[1]
    assert body == (
        f'<div id="guest-root" data-chart-url="/s/tokenchart000001/chart/{piece_id}"'
        ' data-attribution="Shared from a gig book"></div>'
        '<script type="module" src="/guest/guest.js"></script></body></html>'
    )
    assert "<style>" not in r.text


def test_setlist_share_chart_shell_carries_a_way_back(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    chart_id = _chart_piece(cfg, _full_chart())
    setlist_id = _setlist(cfg, [("piece", chart_id, None)])
    _share(cfg, "setlist", setlist_id, "tokenset00000001")
    r = client.get(f"/s/tokenset00000001/piece/{chart_id}")
    assert r.status_code == 200
    assert 'data-setlist-url="/s/tokenset00000001"' in r.text


def test_piece_share_chart_shell_has_no_setlist_url(tmp_data_dir):
    # There is no listing behind a piece share, and pointing back at /s/{token} would just
    # reload this same chart, so the attribute must be absent rather than self-referential.
    client, cfg = _setup(tmp_data_dir)
    chart_id = _chart_piece(cfg, _full_chart())
    _share(cfg, "piece", chart_id, "tokenchart000001")
    r = client.get("/s/tokenchart000001")
    assert r.status_code == 200
    assert "data-setlist-url" not in r.text
    assert "data-attribution" in r.text  # the other hook is still there


def test_nested_chart_fields_are_dropped(tmp_data_dir):
    # The allowlist recurses. chart_json is opaque to this server and grows upstream, so a
    # new per-section or per-bar field would otherwise ship to strangers the day it lands.
    client, cfg = _setup(tmp_data_dir)
    chart = _full_chart()
    chart["sections"][0]["ownerNotes"] = "he always rushes the turnaround"
    chart["sections"][0]["bars"][0]["privateFingering"] = "thumb on the E"
    chart["arrangement"][0]["internalCue"] = "watch the drummer"
    piece_id = _chart_piece(cfg, chart)
    _share(cfg, "piece", piece_id, "tokenchart000001")
    body = client.get(f"/s/tokenchart000001/chart/{piece_id}").json()

    raw = json.dumps(body)
    for leaked in ("ownerNotes", "rushes the turnaround", "privateFingering",
                   "thumb on the E", "internalCue", "watch the drummer"):
        assert leaked not in raw
    # Known fields at every level survive, ids included: the renderer needs them.
    section = body["sections"][0]
    assert section["id"] == "s1" and section["label"] == "Head"
    assert section["bars"][0]["chords"] == "Cm7"
    assert body["arrangement"][0]["sectionId"] == "s1"
    assert body["arrangement"][0]["repeats"] == 2


def test_a_section_with_unusable_bars_is_dropped(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    chart = _full_chart()
    chart["sections"] = [
        {"id": "bad", "label": "Broken", "bars": "nope"},
        {"id": "good", "label": "Head", "bars": [{"chords": "Cm7"}]},
    ]
    piece_id = _chart_piece(cfg, chart)
    _share(cfg, "piece", piece_id, "tokenchart000001")
    body = client.get(f"/s/tokenchart000001/chart/{piece_id}").json()
    assert [s["id"] for s in body["sections"]] == ["good"]


def test_chart_route_rejects_a_pdf_piece(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    assert client.get(f"/s/tokenpiece000001/chart/{piece_id}").status_code == 404


# ---------------------------------------------------------------- throttle


def test_throttle_counts_misses_per_ip_and_token(monkeypatch):
    # Keyed on the pair, so one share cannot spend another share's budget. At a gig every
    # guest is behind one venue NAT address, which is exactly when a bare-IP key bites.
    from server import public
    monkeypatch.setattr(public, "_THROTTLE_MAX_MISSES", 2)
    monkeypatch.setattr(public, "_miss_log", {})
    assert public.allow_miss("1.2.3.4", "tok-a")
    assert public.allow_miss("1.2.3.4", "tok-a")
    assert not public.allow_miss("1.2.3.4", "tok-a")
    assert public.allow_miss("1.2.3.4", "tok-b")  # same NAT, different share
    assert public.allow_miss("5.6.7.8", "tok-a")  # different guest, same share


def test_the_gate_is_throttled_too(monkeypatch):
    from server import public
    monkeypatch.setattr(public, "_THROTTLE_MAX_GATE", 2)
    monkeypatch.setattr(public, "_gate_log", {})
    assert public.allow_gate("1.2.3.4")
    assert public.allow_gate("1.2.3.4")
    assert not public.allow_gate("1.2.3.4")
    assert public.allow_gate("5.6.7.8")


def test_the_throttle_table_stays_bounded(monkeypatch):
    from server import public
    monkeypatch.setattr(public, "_THROTTLE_MAX_KEYS", 16)
    monkeypatch.setattr(public, "_gate_log", {})
    for i in range(400):
        public.allow_gate(f"10.0.0.{i}")
    assert len(public._gate_log) <= 16


def test_the_tunnel_header_is_only_trusted_behind_the_tunnel(monkeypatch):
    # CF-Connecting-IP is caller-supplied. Believing it off-tunnel would let a client
    # rotate the header for a fresh throttle budget on every request.
    from server.public import client_ip

    class _Req:
        def __init__(self, headers):
            self.headers = headers
            self.client = type("C", (), {"host": "127.0.0.1"})()

    monkeypatch.delenv("BANDSTAND_BEHIND_CF", raising=False)
    assert client_ip(_Req({"CF-Connecting-IP": "9.9.9.9"})) == "127.0.0.1"

    monkeypatch.setenv("BANDSTAND_BEHIND_CF", "1")
    assert client_ip(_Req({"CF-Connecting-IP": " 9.9.9.9 "})) == "9.9.9.9"
    assert client_ip(_Req({})) == "127.0.0.1"


def test_throttled_render_does_not_leak_the_share(tmp_data_dir, monkeypatch):
    from server import public
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    file_row = _file_of(cfg, piece_id)
    monkeypatch.setattr(public, "_THROTTLE_MAX_MISSES", 1)
    monkeypatch.setattr(public, "_miss_log", {})
    assert client.get(f"/s/tokenpiece000001/p/{file_row['id']}/0.png").status_code == 200
    # Second page is a fresh miss, and the budget is spent.
    assert client.get(f"/s/tokenpiece000001/p/{file_row['id']}/1.png").status_code == 429
    # A cache hit is still served: throttling is about render cost, not access.
    assert client.get(f"/s/tokenpiece000001/p/{file_row['id']}/0.png").status_code == 200


# ---------------------------------------------------------------- headers


def test_security_headers_on_every_response(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    file_row = _file_of(cfg, piece_id)
    for url in (
        "/s/tokenpiece000001",
        f"/s/tokenpiece000001/p/{file_row['id']}/0.png",
        "/s/" + "z" * 32,
    ):
        r = client.get(url)
        assert r.headers["x-content-type-options"] == "nosniff"
        assert r.headers["referrer-policy"] == "no-referrer"
        csp = r.headers["content-security-policy"]
        for directive in (
            "default-src 'none'", "img-src 'self' data:", "base-uri 'none'",
            "form-action 'none'", "frame-ancestors 'none'",
        ):
            assert directive in csp, url


def test_the_pager_script_and_style_carry_the_response_nonce(tmp_data_dir):
    # The inline pager only runs if its nonce matches the one in the header, so a mismatch
    # would be a blank screen in a real browser rather than a test failure here.
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    r = client.get("/s/tokenpiece000001")
    nonces = set(re.findall(r'nonce="([A-Za-z0-9_-]{22})"', r.text))
    assert len(nonces) == 1, nonces
    nonce = nonces.pop()
    assert f"<script nonce=\"{nonce}\">" in r.text
    assert f"<style nonce=\"{nonce}\">" in r.text
    csp = r.headers["content-security-policy"]
    assert f"script-src 'self' 'nonce-{nonce}'" in csp
    assert f"style-src 'self' 'nonce-{nonce}'" in csp


def test_the_nonce_is_per_response_and_fixed_width(tmp_data_dir):
    # Per-response, or it is not a nonce. Fixed width, or the 404s would differ in length
    # and the parity guarantee would leak through Content-Length.
    client, cfg = _setup(tmp_data_dir)
    _share(cfg, "piece", _pieces(cfg)["Take Five"], "tokenpiece000001")
    first, second = client.get("/s/tokenpiece000001"), client.get("/s/tokenpiece000001")
    a = re.search(r'nonce="([A-Za-z0-9_-]{22})"', first.text).group(1)
    b = re.search(r'nonce="([A-Za-z0-9_-]{22})"', second.text).group(1)
    assert a != b
    assert len(first.content) == len(second.content)

    misses = [client.get("/s/" + "z" * 32) for _ in range(4)]
    assert len({len(m.content) for m in misses}) == 1
    assert len({m.headers["content-length"] for m in misses}) == 1


# ---------------------------------------------------------------- load shedding


def test_a_render_that_cannot_get_a_slot_sheds_load(tmp_data_dir, monkeypatch):
    # Waiting forever would pin a threadpool thread; a handful of those takes the app down.
    from server import public
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    file_row = _file_of(cfg, piece_id)
    monkeypatch.setattr(public, "_RENDER_SLOTS", threading.Semaphore(0))
    monkeypatch.setattr(public, "_RENDER_WAIT_S", 0.05)
    r = client.get(f"/s/tokenpiece000001/p/{file_row['id']}/0.png")
    assert r.status_code == 429


def test_a_pdf_past_the_page_ceiling_is_listed_as_unsupported(tmp_data_dir, monkeypatch):
    # It used to build a manifest of 300 pages whose every request 404s: a page counter
    # over a black screen. It must read as unsupported instead.
    from server import public
    client, cfg = _setup(tmp_data_dir)
    monkeypatch.setattr(public, "_MAX_PDF_PAGES", 2)  # the fixture has 3
    piece_id = _pieces(cfg)["Take Five"]
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    r = client.get("/s/tokenpiece000001")
    assert r.status_code == 200
    assert "not supported in the shared view" in r.text
    assert "/p/" not in r.text

    setlist_id = _setlist(cfg, [("piece", piece_id, None)])
    _share(cfg, "setlist", setlist_id, "tokenset00000001")
    landing = client.get("/s/tokenset00000001")
    assert "not supported in shared view" in landing.text


# ---------------------------------------------------------------- no write path


# Every opcode that would modify the database. An authorizer sees these at statement
# PREPARE time, so an attempted write is caught even if it would never have executed.
_WRITE_ACTIONS = {
    sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE,
    sqlite3.SQLITE_CREATE_TABLE, sqlite3.SQLITE_CREATE_INDEX, sqlite3.SQLITE_CREATE_TRIGGER,
    sqlite3.SQLITE_CREATE_VIEW, sqlite3.SQLITE_DROP_TABLE, sqlite3.SQLITE_DROP_INDEX,
    sqlite3.SQLITE_DROP_TRIGGER, sqlite3.SQLITE_DROP_VIEW, sqlite3.SQLITE_ALTER_TABLE,
    sqlite3.SQLITE_REINDEX,
}


def _watch_for_writes(conn, seen: list):
    def authorizer(action, *_rest):
        if action in _WRITE_ACTIONS:
            seen.append(action)
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK

    conn.set_authorizer(authorizer)
    return conn


def test_the_write_detector_can_actually_detect_a_write(tmp_data_dir):
    # Guards the test below. Its previous version compared library.db mtimes, which under
    # WAL proves nothing (commits land in the -wal file), so it could never have failed.
    # This one shows the detector fires on a real write before we trust its silence.
    cfg = config.load()
    db.bootstrap(cfg)
    seen: list = []
    conn = _watch_for_writes(db.connect(cfg.db_path), seen)
    try:
        with pytest.raises(sqlite3.DatabaseError):
            conn.execute(
                "INSERT INTO shares (id, token, target_kind, target_id, label, created_at) "
                "VALUES ('x', 'y', 'piece', 'z', 'L', 1)"
            )
    finally:
        conn.set_authorizer(None)
        conn.close()
    assert seen == [sqlite3.SQLITE_INSERT]


def test_the_public_app_never_writes_to_the_database(tmp_data_dir, monkeypatch):
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    chart_id = _chart_piece(cfg, _full_chart())
    setlist_id = _setlist(cfg, [("piece", piece_id, None), ("piece", chart_id, None)])
    _share(cfg, "setlist", setlist_id, "tokenset00000001")
    file_row = _file_of(cfg, piece_id)

    # Patch AFTER the fixtures are written: everything from here is the public app's own
    # traffic, on the connections it opens for itself.
    seen: list = []
    real_connect_ro = db.connect_ro
    monkeypatch.setattr(
        db, "connect_ro", lambda path: _watch_for_writes(real_connect_ro(path), seen)
    )

    for url in (
        "/s/tokenset00000001",
        f"/s/tokenset00000001/piece/{piece_id}",
        f"/s/tokenset00000001/piece/{chart_id}",
        f"/s/tokenset00000001/chart/{chart_id}",
        f"/s/tokenset00000001/p/{file_row['id']}/0.png",
        f"/s/tokenset00000001/p/{file_row['id']}/0.png",  # again, now a cache hit
        f"/s/tokenset00000001/img/{file_row['id']}.png",  # wrong kind, 404 path
        "/s/" + "z" * 32,
        "/s/not a token!",
    ):
        client.get(url)
    assert seen == []


# ---------------------------------------------------------------- attribution


def test_attribution_is_operator_configurable(tmp_data_dir, monkeypatch):
    # An instance that wants the line it has always shown sets the variable and gets
    # that exact text back, apostrophe and all, in the footer and the pager bar.
    monkeypatch.setenv("BANDSTAND_SHARE_ATTRIBUTION", "Shared from Rea's gig book")
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    r = client.get("/s/tokenpiece000001")
    assert r.status_code == 200
    assert "Shared from Rea's gig book" in r.text
    assert "Shared from a gig book" not in r.text
    missing = client.get("/s/tokenmissing00001")
    assert missing.status_code == 404
    assert "<footer>Shared from Rea's gig book</footer>" in missing.text


def test_attribution_is_escaped_on_every_surface(tmp_data_dir, monkeypatch):
    # The value is operator-supplied text, never markup: a stray angle bracket or
    # quote must not be able to break out of the footer or the data attribute.
    monkeypatch.setenv("BANDSTAND_SHARE_ATTRIBUTION", '<b>Band</b> & "friends"')
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    chart_id = _chart_piece(cfg, _full_chart())
    _share(cfg, "piece", chart_id, "tokenchart000001")
    pages = [
        client.get("/s/tokenpiece000001"),
        client.get("/s/tokenchart000001"),
        client.get("/s/tokenmissing00001"),
    ]
    for r in pages:
        assert "<b>Band</b>" not in r.text
        assert "&lt;b&gt;Band&lt;/b&gt; &amp; " in r.text
    assert 'data-attribution="&lt;b&gt;Band&lt;/b&gt; &amp; &quot;friends&quot;"' in pages[1].text


def test_blank_attribution_falls_back_to_the_default(tmp_data_dir, monkeypatch):
    monkeypatch.setenv("BANDSTAND_SHARE_ATTRIBUTION", "   ")
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    assert "Shared from a gig book" in client.get("/s/tokenpiece000001").text


def test_no_personal_name_is_baked_into_the_share_pages(tmp_data_dir):
    client, cfg = _setup(tmp_data_dir)
    piece_id = _pieces(cfg)["Take Five"]
    _share(cfg, "piece", piece_id, "tokenpiece000001")
    for r in (client.get("/s/tokenpiece000001"), client.get("/s/tokenmissing00001")):
        assert "Simon" not in r.text
