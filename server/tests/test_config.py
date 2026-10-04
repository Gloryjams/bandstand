from pathlib import Path

import pytest


def test_default_data_dir_is_a_folder_in_the_home_directory(monkeypatch, tmp_path):
    # No host-specific path is baked in: an install with nothing configured keeps its
    # data in ~/Bandstand, whatever machine it is on.
    from server import config
    assert config.default_data_dir(os_name="posix", home=tmp_path) == tmp_path / "Bandstand"
    assert config.default_data_dir(
        os_name="nt", home=tmp_path, legacy_exists=False
    ) == tmp_path / "Bandstand"


def test_legacy_windows_folder_is_kept_only_where_it_already_exists(tmp_path):
    # The first install relied on the old built-in default. It keeps working there,
    # and only there: never off Windows, never when the folder is absent.
    from server import config
    assert config.default_data_dir(
        os_name="nt", home=tmp_path, legacy_exists=True
    ) == Path("D:/Bandstand")
    assert config.default_data_dir(
        os_name="posix", home=tmp_path, legacy_exists=True
    ) == tmp_path / "Bandstand"


def _fresh_default(monkeypatch, config, folder):
    monkeypatch.setattr(config, "_resolved_default", None)
    monkeypatch.setattr(config, "default_data_dir", lambda: folder)


def test_load_uses_the_default_when_unset(monkeypatch, tmp_path):
    from server import config
    _fresh_default(monkeypatch, config, tmp_path / "Bandstand")
    monkeypatch.delenv("BANDSTAND_DATA_DIR", raising=False)
    assert config.load().data_dir == tmp_path / "Bandstand"


@pytest.mark.parametrize("blank", ["", "  ", "\t"])
def test_a_blank_data_folder_is_refused_not_guessed(monkeypatch, tmp_path, blank):
    # It used to mean "the current directory", then "the home default". Both are a
    # guess about where a library and a key should go. On a machine that already
    # runs a band from the default folder, the second guess lands on live data.
    from server import config
    _fresh_default(monkeypatch, config, tmp_path / "Bandstand")
    monkeypatch.setenv("BANDSTAND_DATA_DIR", blank)
    with pytest.raises(config.ConfigProblem, match="BANDSTAND_DATA_DIR is set but empty"):
        config.load()
    assert not (tmp_path / "Bandstand").exists()


def test_the_default_is_decided_once_per_process(monkeypatch, tmp_path):
    # Config is loaded on every request. If the default were re-evaluated each time,
    # a folder that vanishes for a moment would move a RUNNING server elsewhere.
    from server import config
    answers = iter([tmp_path / "first", tmp_path / "second"])
    monkeypatch.setattr(config, "_resolved_default", None)
    monkeypatch.setattr(config, "default_data_dir", lambda: next(answers))
    monkeypatch.delenv("BANDSTAND_DATA_DIR", raising=False)
    assert config.load().data_dir == tmp_path / "first"
    assert config.load().data_dir == tmp_path / "first"


def test_an_explicit_folder_is_trimmed_and_always_wins(monkeypatch, tmp_path):
    from server import config
    _fresh_default(monkeypatch, config, tmp_path / "Bandstand")
    monkeypatch.setenv("BANDSTAND_DATA_DIR", f"  {tmp_path / 'mine'}  ")
    assert config.load().data_dir == tmp_path / "mine"


def test_every_documented_variable_is_read(monkeypatch, tmp_path):
    # The contract existing instances depend on: each variable still lands where it
    # always did.
    from server import config
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("BANDSTAND_PORT", "7831")
    monkeypatch.setenv("BANDSTAND_NAME", "The Lockups")
    monkeypatch.setenv("BANDSTAND_MAX_UPLOAD_MB", "20")
    monkeypatch.setenv("BANDSTAND_LIBRARY_QUOTA_MB", "500")
    monkeypatch.setenv("BANDSTAND_SHARE_ATTRIBUTION", "Shared from the band book")
    cfg = config.load()
    assert (cfg.data_dir, cfg.port, cfg.display_name) == (tmp_path, 7831, "The Lockups")
    assert (cfg.max_upload_mb, cfg.library_quota_mb) == (20, 500)
    assert cfg.share_attribution == "Shared from the band book"


def test_defaults_when_nothing_is_set(monkeypatch, tmp_path):
    from server import config
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path))
    for name in ("BANDSTAND_PORT", "BANDSTAND_NAME", "BANDSTAND_MAX_UPLOAD_MB",
                 "BANDSTAND_LIBRARY_QUOTA_MB", "BANDSTAND_SHARE_ATTRIBUTION"):
        monkeypatch.delenv(name, raising=False)
    cfg = config.load()
    assert (cfg.port, cfg.display_name) == (7800, "Bandstand")
    assert (cfg.max_upload_mb, cfg.library_quota_mb) == (50, 0)
    assert cfg.share_attribution == "Shared from a gig book"


def test_env_data_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path))
    from server import config
    cfg = config.load()
    assert cfg.data_dir == tmp_path


def test_paths_derived_from_data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path))
    from server import config
    cfg = config.load()
    assert cfg.library_dir == tmp_path / "library"
    assert cfg.thumbs_dir == tmp_path / "thumbs"
    assert cfg.db_path == tmp_path / "library.db"
    assert cfg.key_path == tmp_path / ".key"
    assert cfg.port == 7800


def test_blank_values_mean_unset(monkeypatch, tmp_path):
    # A compose file passes every variable through, set or not. Blank must behave
    # exactly like absent instead of crashing the boot or blanking the band name.
    from server import config
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path))
    for name in ("BANDSTAND_PORT", "BANDSTAND_NAME", "BANDSTAND_MAX_UPLOAD_MB",
                 "BANDSTAND_LIBRARY_QUOTA_MB", "BANDSTAND_SHARE_ATTRIBUTION"):
        monkeypatch.setenv(name, "")
    cfg = config.load()
    assert (cfg.port, cfg.display_name) == (7800, "Bandstand")
    assert (cfg.max_upload_mb, cfg.library_quota_mb) == (50, 0)
    assert cfg.share_attribution == "Shared from a gig book"


def test_a_non_numeric_value_is_still_a_clear_error(monkeypatch, tmp_path):
    from server import config
    monkeypatch.setenv("BANDSTAND_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("BANDSTAND_PORT", "seventy")
    with pytest.raises(ValueError, match="BANDSTAND_PORT"):
        config.load()


def test_public_base_blank_means_not_configured_and_set_value_wins(monkeypatch):
    from server.api import shares
    monkeypatch.setenv("BANDSTAND_PUBLIC_BASE", "")
    assert shares._public_base() is None
    monkeypatch.delenv("BANDSTAND_PUBLIC_BASE")
    assert shares._public_base() is None
    monkeypatch.setenv("BANDSTAND_PUBLIC_BASE", "https://share.example.com/")
    assert shares._public_base() == "https://share.example.com"
