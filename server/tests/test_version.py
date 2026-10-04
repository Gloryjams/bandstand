"""One version, one place: server/pyproject.toml."""
import re
import tomllib
from pathlib import Path

from server import version

SERVER = Path(__file__).parent.parent


def _declared() -> str:
    with (SERVER / "pyproject.toml").open("rb") as f:
        return tomllib.load(f)["project"]["version"]


def test_version_comes_from_pyproject():
    assert version.VERSION == _declared()


def test_version_is_a_plain_release_number():
    # The release workflow compares the git tag "vX.Y.Z" against this string.
    assert re.fullmatch(r"\d+\.\d+\.\d+", version.VERSION), version.VERSION


def test_app_metadata_uses_the_same_version(tmp_data_dir):
    from server.api import health
    from server.main import build_app
    assert health.VERSION == _declared()
    assert build_app().version == _declared()


def test_no_second_copy_of_the_version_in_the_server_source():
    # A hardcoded copy is how two places end up disagreeing after a release.
    declared = _declared()
    offenders = []
    for path in SERVER.rglob("*.py"):
        parts = path.relative_to(SERVER).parts
        if parts[0] in {".venv", "tests", "build"} or "__pycache__" in parts:
            continue
        if re.search(rf"""["']{re.escape(declared)}["']""", path.read_text(encoding="utf-8")):
            offenders.append(str(path.relative_to(SERVER)))
    assert offenders == []


def test_unreadable_pyproject_falls_back_without_crashing(tmp_path):
    got = version.read_version(tmp_path / "missing.toml")
    # Either the installed distribution answers, or the explicit unknown marker does.
    assert got == version.UNKNOWN or re.match(r"\d+\.\d+", got)


def test_server_messages_carry_no_em_dash_or_en_dash():
    # Anything the server can print or return is copy somebody reads. Comments and
    # docstrings are exempt (they are for maintainers), string literals are not.
    import ast
    offenders = []
    for path in SERVER.rglob("*.py"):
        parts = path.relative_to(SERVER).parts
        if parts[0] in {".venv", "tests", "build"} or "__pycache__" in parts:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        docstrings = set()
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                body = node.body
                if (body and isinstance(body[0], ast.Expr)
                        and isinstance(body[0].value, ast.Constant)
                        and isinstance(body[0].value.value, str)):
                    docstrings.add(id(body[0].value))
        for node in ast.walk(tree):
            if (isinstance(node, ast.Constant) and isinstance(node.value, str)
                    and id(node) not in docstrings
                    and any(ch in node.value for ch in "—–")):
                offenders.append(f"{path.relative_to(SERVER)}:{node.lineno}")
    assert offenders == []
