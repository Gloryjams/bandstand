from dataclasses import dataclass
from pathlib import Path
import os

DEFAULT_SHARE_ATTRIBUTION = "Shared from a gig book"
DEFAULT_ROOMS_PROPOSALS_PER_MINUTE = 5
DEFAULT_ROOMS_PARTICIPATION_PER_MINUTE = 30
DEFAULT_ROOMS_MAX_GUESTS = 60


@dataclass(frozen=True)
class Config:
    data_dir: Path
    library_dir: Path
    thumbs_dir: Path
    db_path: Path
    key_path: Path
    port: int
    # Band display name (shown in the client header + band switcher). The band-instance
    # factory sets BANDSTAND_NAME; a plain personal instance keeps the default.
    display_name: str
    # Upload/abuse ceilings (added for the internet-exposed demo instance; the
    # LAN instance keeps generous defaults). 0 quota = unlimited.
    max_upload_mb: int
    library_quota_mb: int
    # Footer line on public share pages. Defaulted (not required) so any code that
    # builds a Config by hand keeps working.
    share_attribution: str = DEFAULT_SHARE_ATTRIBUTION
    # Rehearsal rooms: a QR code on a wall lets anyone who can see it join. They are
    # OFF unless the operator switches them on, and then bounded. See server/api/rooms.py.
    rooms_enabled: bool = False
    # How many rooms may be open at once. 1 is what the app is built around.
    rooms_max_open: int = 1
    # How many songs one guest may post per minute. 0 means no limit.
    rooms_proposals_per_minute: int = DEFAULT_ROOMS_PROPOSALS_PER_MINUTE
    # How many new votes and volunteer choices one guest may make per minute,
    # counted together. 0 means no limit.
    rooms_participation_per_minute: int = DEFAULT_ROOMS_PARTICIPATION_PER_MINUTE
    # How many guests one room takes. A guest id is chosen by the phone, so without
    # this a single phone could join again and again and post without bound.
    rooms_max_guests: int = DEFAULT_ROOMS_MAX_GUESTS
    # May the live update stream still take the key in the address (`?key=`)? True
    # or False when BANDSTAND_EVENTS_KEY_IN_URL is set; None (unset) means the answer
    # recorded in the data folder decides. See server/stream_ticket.py. Parsed here so
    # that a value nobody can read stops the server at boot, not on every stream open.
    events_key_in_url: bool | None = None


# The original install kept its library on a Windows D: drive and relied on that
# being the built-in default. It is honoured ONLY on Windows and ONLY when the folder
# already exists, so that one machine keeps working and nobody else ever sees it.
_LEGACY_WINDOWS_DATA_DIR = Path("D:/Bandstand")


def default_data_dir(
    *, os_name: str | None = None, home: Path | None = None, legacy_exists: bool | None = None
) -> Path:
    """Where data lives when BANDSTAND_DATA_DIR is not set: a Bandstand folder in the
    user's home directory. The keyword arguments are test seams."""
    os_name = os.name if os_name is None else os_name
    home = Path.home() if home is None else home
    if os_name == "nt":
        if legacy_exists is None:
            legacy_exists = _LEGACY_WINDOWS_DATA_DIR.is_dir()
        if legacy_exists:
            return _LEGACY_WINDOWS_DATA_DIR
    return home / "Bandstand"


class ConfigProblem(ValueError):
    """A setting that cannot be used. The message is written for the operator."""


# The default is decided ONCE per process. Config is loaded on every request, and a
# default that is re-evaluated each time can change under a running server: on the
# original Windows install, a D: drive that drops out for a moment would switch a
# live server to an empty library in the home folder.
_resolved_default: Path | None = None


def process_default_data_dir() -> Path:
    global _resolved_default
    if _resolved_default is None:
        _resolved_default = default_data_dir()
        if os.name == "nt" and _resolved_default != _LEGACY_WINDOWS_DATA_DIR:
            print(
                "BANDSTAND_DATA_DIR is not set. Using the data folder "
                f"{_resolved_default}",
                flush=True,
            )
    return _resolved_default


def _data_dir_from_env() -> Path:
    raw = os.environ.get("BANDSTAND_DATA_DIR")
    if raw is None:
        return process_default_data_dir()
    if not raw.strip():
        # Every other setting treats blank as unset. Not this one: a blank value is
        # nearly always a mistake in a script or a service file, and guessing sends
        # a server to a folder nobody chose, possibly one that is in use.
        raise ConfigProblem(
            "BANDSTAND_DATA_DIR is set but empty. Give it the folder that holds this "
            "band's data, or remove the setting to use the default folder "
            f"({process_default_data_dir()})."
        )
    return Path(raw.strip())


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:  # unset or blank: a passed-through empty variable is not an error
        return default
    try:
        return int(raw)
    except ValueError as e:
        raise ConfigProblem(f"{name} must be a whole number, got {raw!r}") from e


def _flag_env(name: str) -> bool:
    """A switch. Same spelling as BANDSTAND_SHARE_PAGES: 1, true, yes or on."""
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _optional_flag_env(name: str) -> bool | None:
    """A switch that may also be left unset. 1, true, yes or on; 0, false, no or off;
    blank or absent means None. Anything else is a setting nobody can read."""
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return None
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    raise ConfigProblem(f"{name} must be 1 or 0, got {raw!r}")


def events_key_in_url_from_env() -> bool | None:
    """The BANDSTAND_EVENTS_KEY_IN_URL switch on its own, for a door that has no
    Config of its own to read it from (the public member door)."""
    return _optional_flag_env("BANDSTAND_EVENTS_KEY_IN_URL")


def _at_least(name: str, value: int, floor: int) -> int:
    if value < floor:
        raise ConfigProblem(f"{name} must be {floor} or more, got {value}")
    return value


def load() -> Config:
    # Resolved once here: upload and ingest compare resolved file paths against the
    # library folder, so a data folder behind a symlink (macOS /var) must be too.
    data_dir = _data_dir_from_env().resolve()
    port = _int_env("BANDSTAND_PORT", 7800)
    return Config(
        data_dir=data_dir,
        library_dir=data_dir / "library",
        thumbs_dir=data_dir / "thumbs",
        db_path=data_dir / "library.db",
        key_path=data_dir / ".key",
        port=port,
        display_name=os.environ.get("BANDSTAND_NAME", "").strip() or "Bandstand",
        max_upload_mb=_int_env("BANDSTAND_MAX_UPLOAD_MB", 50),
        library_quota_mb=_int_env("BANDSTAND_LIBRARY_QUOTA_MB", 0),
        share_attribution=(
            os.environ.get("BANDSTAND_SHARE_ATTRIBUTION", "").strip()
            or DEFAULT_SHARE_ATTRIBUTION
        ),
        rooms_enabled=_flag_env("BANDSTAND_ROOMS"),
        rooms_max_open=_at_least(
            "BANDSTAND_ROOMS_MAX_OPEN", _int_env("BANDSTAND_ROOMS_MAX_OPEN", 1), 1
        ),
        rooms_proposals_per_minute=_at_least(
            "BANDSTAND_ROOMS_PROPOSALS_PER_MINUTE",
            _int_env("BANDSTAND_ROOMS_PROPOSALS_PER_MINUTE", DEFAULT_ROOMS_PROPOSALS_PER_MINUTE),
            0,
        ),
        rooms_participation_per_minute=_at_least(
            "BANDSTAND_ROOMS_PARTICIPATION_PER_MINUTE",
            _int_env("BANDSTAND_ROOMS_PARTICIPATION_PER_MINUTE", DEFAULT_ROOMS_PARTICIPATION_PER_MINUTE),
            0,
        ),
        rooms_max_guests=_at_least(
            "BANDSTAND_ROOMS_MAX_GUESTS",
            _int_env("BANDSTAND_ROOMS_MAX_GUESTS", DEFAULT_ROOMS_MAX_GUESTS),
            1,
        ),
        events_key_in_url=events_key_in_url_from_env(),
    )
