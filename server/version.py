"""The version, read from one place: `server/pyproject.toml`.

Nothing else in the repository states the version. The health endpoint, the
FastAPI app metadata, the container label and the release tag check all read it
from here, so bumping a release is a one-line change.
"""
import tomllib
from importlib import metadata
from pathlib import Path

_PYPROJECT = Path(__file__).parent / "pyproject.toml"
_DISTRIBUTION = "bandstand-server"
UNKNOWN = "0.0.0+unknown"


def read_version(pyproject: Path = _PYPROJECT) -> str:
    try:
        with pyproject.open("rb") as f:
            return str(tomllib.load(f)["project"]["version"])
    except (OSError, KeyError, TypeError, tomllib.TOMLDecodeError):
        pass
    # Installed as a wheel with the source tree gone: the packaging metadata was
    # generated from the same pyproject.toml, so it is still the same answer.
    try:
        return metadata.version(_DISTRIBUTION)
    except metadata.PackageNotFoundError:
        return UNKNOWN


VERSION = read_version()

if __name__ == "__main__":
    print(VERSION)
