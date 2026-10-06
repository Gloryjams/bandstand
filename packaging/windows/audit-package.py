"""Inspect every package file, including binaries and the included source archive."""
from __future__ import annotations

import io
import os
import re
import sqlite3
import sys
import zipfile
from contextlib import closing
from pathlib import Path, PurePosixPath

PRIVATE = [
    re.compile(rb"C:[\\/]+Projects[\\/]", re.I),
    re.compile(rb"C:[\\/]+Users[\\/]+simon[\\/]", re.I),
    re.compile(rb"/Users/Simon[s]Mac/"),
    re.compile(rb"192[.]168[.]4[.]39"),
    re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
]
SECRET = os.environ.get("BANDSTAND_AUDIT_FORBIDDEN_KEY", "").encode()
FORBIDDEN_NAMES = {".key", ".env", ".venv", "__pycache__", "node_modules"}


def inspect(name: str, content: bytes, problems: list[str], *, depth: int = 0) -> int:
    path = PurePosixPath(name.replace("\\", "/"))
    if any(part in FORBIDDEN_NAMES or part.startswith(".env.") and part != ".env.example"
           for part in path.parts):
        problems.append(f"{name}: forbidden file or directory")
    if any(pattern.search(content) for pattern in PRIVATE):
        problems.append(f"{name}: private machine reference or private key")
    if SECRET and SECRET in content:
        problems.append(f"{name}: build sign-in key was retained")
    count = 1
    if path.suffix == ".zip":
        if depth >= 2:
            problems.append(f"{name}: unexpected nested archive")
        else:
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                for entry in archive.infolist():
                    if not entry.is_dir():
                        count += inspect(f"{name}/{entry.filename}", archive.read(entry), problems, depth=depth + 1)
    return count


def main() -> int:
    root = Path(sys.argv[1])
    problems: list[str] = []
    count = 0
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        name = path.relative_to(root).as_posix()
        if path.suffix in {".db", ".sqlite3"} and name != "seed/library.db":
            problems.append(f"{name}: unexpected database")
        if path.name.endswith(("-wal", "-shm", ".log")):
            problems.append(f"{name}: runtime residue")
        count += inspect(name, path.read_bytes(), problems)
    required = ["LICENSE", "NOTICE", "TRADEMARKS.md", "THIRD-PARTY-NOTICES.md",
                "source/Bandstand-source.zip", "runtime/LICENSE.txt", "seed/library.db",
                "app/server/static/app/index.html", "app/server/static/charts/index.html"]
    for name in required:
        if not (root / name).is_file():
            problems.append(f"{name}: required package content is missing")
    database = root / "seed/library.db"
    if database.is_file():
        # The generated seed is checkpointed and closed before this audit.
        # A normal read-only WAL connection creates -wal and -shm files after
        # the file scan. Immutable reads leave this static package untouched.
        with closing(sqlite3.connect(f"{database.as_uri()}?mode=ro&immutable=1", uri=True)) as conn:
            if conn.execute("SELECT COUNT(*) FROM members").fetchone()[0] != 0:
                problems.append("seed/library.db: members found in practice book")
            if conn.execute("SELECT COUNT(*) FROM pieces WHERE deleted_at IS NULL").fetchone()[0] != 4:
                problems.append("seed/library.db: unexpected practice chart count")
    for problem in problems:
        print(problem)
    print(f"Package audit: {count} files inspected, {len(problems)} problems.")
    return bool(problems)


if __name__ == "__main__":
    raise SystemExit(main())
