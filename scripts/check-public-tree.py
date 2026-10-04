#!/usr/bin/env python3
"""Check the tree that would be published.

    python3 scripts/check-public-tree.py

Looks at every tracked file that is NOT marked export-ignore in .gitattributes,
as it is in the working copy, and fails when:

1. a document or configuration file contains an em-dash or an en-dash (the rule
   for everything a person reads), or
2. any text file contains a word from scripts/private-patterns.txt (names and
   addresses of private infrastructure). That file is itself never exported, so
   in a public checkout this half of the check has nothing to look for and says so.

Standard library only.
"""
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PATTERNS = REPO / "scripts" / "private-patterns.txt"
DASHES = {"\u2014": "em-dash", "\u2013": "en-dash"}
# Where the dash rule applies: what a person reads, not source code. Shipped app
# copy is covered by client/scripts/check-copy.mjs, server messages by a test.
PROSE_SUFFIXES = {".md", ".yml", ".yaml", ".txt", ".sh", ".example", ".toml"}
PROSE_NAMES = {"Dockerfile", ".dockerignore", ".gitignore", ".gitattributes", ".env.example"}
BINARY_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".woff", ".woff2",
                   ".mp3", ".wav", ".zip", ".webp"}
# Generated, and full of other people's names.
SKIP_NAMES = {"package-lock.json", "requirements.lock", "requirements-dev.lock"}


def git(*args: str, stdin: str | None = None) -> str:
    done = subprocess.run(
        ["git", *args], cwd=REPO, input=stdin, capture_output=True, text=True, check=True
    )
    return done.stdout


def exported_files() -> list[Path]:
    tracked = [line for line in git("ls-files", "-z").split("\0") if line]
    report = git("check-attr", "-z", "--stdin", "export-ignore", stdin="\0".join(tracked))
    fields = report.split("\0")
    ignored = {fields[i] for i in range(0, len(fields) - 2, 3) if fields[i + 2] == "set"}
    return [REPO / name for name in tracked if name not in ignored]


def load_patterns() -> tuple[list[re.Pattern], dict[str, list[re.Pattern]]]:
    if not PATTERNS.exists():
        return [], {}
    forbidden: list[re.Pattern] = []
    allowed: dict[str, list[re.Pattern]] = {}
    for raw in PATTERNS.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("allow "):
            _, path, expression = line.split(None, 2)
            allowed.setdefault(path, []).append(re.compile(expression, re.I))
        else:
            forbidden.append(re.compile(line, re.I))
    return forbidden, allowed


def is_prose(path: Path) -> bool:
    return path.suffix in PROSE_SUFFIXES or path.name in PROSE_NAMES


def main() -> int:
    forbidden, allowed = load_patterns()
    problems: list[str] = []
    checked = 0
    for path in exported_files():
        if path.suffix.lower() in BINARY_SUFFIXES or path.name in SKIP_NAMES:
            continue
        if not path.is_file():
            continue  # deleted in the working copy, not yet committed
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        checked += 1
        rel = path.relative_to(REPO).as_posix()
        for number, line in enumerate(text.splitlines(), 1):
            if is_prose(path):
                for char, name in DASHES.items():
                    if char in line:
                        problems.append(f"{rel}:{number}: {name}")
            for pattern in forbidden:
                if pattern.search(line) and not any(
                    ok.pattern == pattern.pattern for ok in allowed.get(rel, [])
                ):
                    problems.append(f"{rel}:{number}: private word /{pattern.pattern}/")
    for problem in problems:
        print(problem)
    scope = "dashes and private words" if forbidden else "dashes only (no private word list here)"
    if problems:
        print(f"\n{len(problems)} problems in the public tree. Checked {checked} files for {scope}.")
        return 1
    print(f"Public tree clean: {checked} files checked for {scope}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
