from pathlib import Path

from server.ingest import audio_meta

FIXTURES = Path(__file__).parent / "fixtures"


def test_duration_ms_around_one_second():
    info = audio_meta.read(FIXTURES / "silent.mp3")
    assert 800 <= info.duration_ms <= 1200


def test_unsupported_returns_none_duration(tmp_path):
    bogus = tmp_path / "x.mp3"
    bogus.write_bytes(b"not audio")
    info = audio_meta.read(bogus)
    assert info.duration_ms is None
