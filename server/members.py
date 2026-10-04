"""Band members: identity model + management CLI.

A member's key IS their account — no passwords. The server stores only sha256(key);
the plaintext is printed exactly once at mint time and travels to the member inside
their personal pair link. The `.key` file remains the root director credential and
never appears in the members table.

CLI (runs against BANDSTAND_DATA_DIR, safe while the server is up):
    python -m server.members add "Rea" [--role member]
    python -m server.members list
    python -m server.members revoke <id>
    python -m server.members rotate <id>
    python -m server.members reattach-notes <old-id> <new-id>

Every command first says, on stderr, which data folder it is working on. Standard
output is unchanged, because scripts read it. `--data-dir <folder>` before the
command picks the folder for that one run.

Private notes are keyed by member id, and rotating or replacing a key mints a new
id. Both paths carry the person's notes over to the new id in the same transaction
as the re-mint (`carry_notes`). `reattach-notes` is the repair for notes left behind
under an old id before that was the case.
"""

import hashlib
import secrets
import time
from dataclasses import dataclass

from server import config, db
from server.ulid import new_ulid

ROOT_ID = "root"


@dataclass(frozen=True)
class Identity:
    id: str
    name: str
    role: str  # 'director' | 'member'

    @property
    def is_director(self) -> bool:
        return self.role == "director"


ROOT = Identity(id=ROOT_ID, name="Director", role="director")


def key_hash(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def find_by_key(conn, key: str) -> Identity | None:
    row = conn.execute(
        "SELECT id, name, role FROM members WHERE key_hash = ? AND revoked_at IS NULL",
        (key_hash(key),),
    ).fetchone()
    if row is None:
        return None
    return Identity(id=row["id"], name=row["name"], role=row["role"])


def _insert_member(conn, name: str, role: str, now: int) -> tuple[Identity, str]:
    """Mint a member inside the caller's transaction. Returns (identity, plaintext_key)."""
    if role not in ("director", "member"):
        raise ValueError(f"invalid role: {role!r}")
    key = secrets.token_hex(32)
    member_id = new_ulid()
    conn.execute(
        "INSERT INTO members (id, name, role, key_hash, created_at) VALUES (?, ?, ?, ?, ?)",
        (member_id, name, role, key_hash(key), now),
    )
    return Identity(id=member_id, name=name, role=role), key


def _revoke_member(conn, member_id: str, now: int) -> bool:
    """Revoke inside the caller's transaction. False when there was nothing to revoke."""
    cur = conn.execute(
        "UPDATE members SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        (now, member_id),
    )
    return cur.rowcount > 0


def carry_notes(conn, from_id: str, to_id: str) -> tuple[int, int]:
    """Move private notes from one owner id to another, inside the caller's transaction.

    Returns (moved, kept): `kept` counts songs where the new id already had a note of
    its own. Those stay as they are, because they are what the person sees today; the
    old row stays where it was, unreadable, so nothing is destroyed either way.
    """
    if from_id == to_id:
        return 0, 0
    kept = conn.execute(
        "SELECT COUNT(*) FROM personal_notes old WHERE old.owner_id = ? AND EXISTS ("
        "SELECT 1 FROM personal_notes new WHERE new.owner_id = ? AND new.piece_id = old.piece_id)",
        (from_id, to_id),
    ).fetchone()[0]
    moved = conn.execute(
        "UPDATE personal_notes SET owner_id = ? WHERE owner_id = ? AND piece_id NOT IN ("
        "SELECT piece_id FROM personal_notes WHERE owner_id = ?)",
        (to_id, from_id, to_id),
    ).rowcount
    return moved, kept


def add_member(conn, name: str, role: str = "member") -> tuple[Identity, str]:
    """Mint a member. Returns (identity, plaintext_key); the key is never stored."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        result = _insert_member(conn, name, role, int(time.time() * 1000))
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    return result


def revoke_member(conn, member_id: str) -> bool:
    conn.execute("BEGIN IMMEDIATE")
    try:
        revoked = _revoke_member(conn, member_id, int(time.time() * 1000))
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    return revoked


def rotate_member(conn, member_id: str) -> tuple[Identity, str] | None:
    """Revoke + re-mint under the same name/role. Returns the NEW (identity, key).

    The person's private notes move to the new id in the same transaction, so a
    rotation never loses them: either everything lands or nothing does.
    """
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute(
            "SELECT name, role FROM members WHERE id = ? AND revoked_at IS NULL",
            (member_id,),
        ).fetchone()
        if row is None:
            conn.execute("ROLLBACK")
            return None
        now = int(time.time() * 1000)
        _revoke_member(conn, member_id, now)
        ident, key = _insert_member(conn, row["name"], row["role"], now)
        carry_notes(conn, member_id, ident.id)
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    return ident, key


class ReattachProblem(ValueError):
    """Why `reattach_notes` refused. The message is written for the director."""


def reattach_notes(conn, old_id: str, new_id: str, allow_different_name: bool = False) -> tuple[int, int]:
    """Director repair: move notes left under an old member id to that person's new id.

    `new_id` must be a member who can still sign in, `old_id` a revoked member id of
    this band (every re-mint leaves the old id revoked, so a working id as `old_id`
    is a slip that would drain someone's live account). The two must carry the same
    name unless the director says otherwise, so a slip of the id cannot hand one
    person's notes to another. Returns (moved, kept) as `carry_notes` does.
    """
    if old_id == new_id:
        raise ReattachProblem("The old id and the new id are the same.")
    conn.execute("BEGIN IMMEDIATE")
    try:
        old = conn.execute(
            "SELECT name, revoked_at FROM members WHERE id = ?", (old_id,)
        ).fetchone()
        new = conn.execute(
            "SELECT name FROM members WHERE id = ? AND revoked_at IS NULL", (new_id,)
        ).fetchone()
        if old is None:
            raise ReattachProblem(f"No member has ever had the id {old_id}.")
        if new is None:
            raise ReattachProblem(f"{new_id} is not a member who can sign in. Notes go to a working id.")
        if old["revoked_at"] is None:
            raise ReattachProblem(
                f"{old_id} is still a working id. Notes only move away from a revoked id; "
                "revoke it first, or check the ids."
            )
        if old["name"].casefold() != new["name"].casefold() and not allow_different_name:
            raise ReattachProblem(
                f"{old_id} belongs to {old['name']} and {new_id} to {new['name']}. "
                "Add --allow-different-name if this really is the same person."
            )
        result = carry_notes(conn, old_id, new_id)
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    return result


def list_members(conn) -> list[dict]:
    return [
        dict(r)
        for r in conn.execute(
            "SELECT id, name, role, created_at, revoked_at FROM members ORDER BY created_at"
        ).fetchall()
    ]


def _main() -> int:
    import argparse
    import os
    import sys

    parser = argparse.ArgumentParser(prog="python -m server.members")
    parser.add_argument(
        "--data-dir",
        help="the band's data folder (default: BANDSTAND_DATA_DIR, then ~/Bandstand)",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_add = sub.add_parser("add")
    p_add.add_argument("name")
    p_add.add_argument("--role", default="member", choices=["director", "member"])
    sub.add_parser("list")
    p_rev = sub.add_parser("revoke")
    p_rev.add_argument("id")
    p_rot = sub.add_parser("rotate")
    p_rot.add_argument("id")
    p_re = sub.add_parser(
        "reattach-notes",
        help="move private notes left under an old member id to that person's new id",
    )
    p_re.add_argument("old_id")
    p_re.add_argument("new_id")
    p_re.add_argument(
        "--allow-different-name",
        action="store_true",
        help="move them even though the two ids carry different names",
    )
    args = parser.parse_args()

    if args.data_dir is not None:
        os.environ["BANDSTAND_DATA_DIR"] = args.data_dir
    try:
        cfg = config.load()
        # Said before anything is written, so a command aimed at the wrong band is
        # visible at once.
        print(f"Data folder: {cfg.data_dir}", file=sys.stderr)
        db.bootstrap_schema(cfg)
    except (config.ConfigProblem, db.SchemaProblem) as problem:
        print(f"Cannot continue: {problem}", file=sys.stderr)
        return 1
    conn = db.connect(cfg.db_path)
    try:
        if args.cmd == "add":
            ident, key = add_member(conn, args.name, args.role)
            print(f"id:   {ident.id}")
            print(f"name: {ident.name}")
            print(f"role: {ident.role}")
            print(f"key:  {key}")
            print("(the key is shown ONCE. Send it to this person privately, together")
            print(" with the address of the server. They sign in with it.)")
        elif args.cmd == "list":
            for m in list_members(conn):
                state = "revoked" if m["revoked_at"] else "active"
                print(f'{m["id"]}  {m["role"]:8}  {state:7}  {m["name"]}')
        elif args.cmd == "revoke":
            print("revoked" if revoke_member(conn, args.id) else "not found (or already revoked)")
        elif args.cmd == "rotate":
            result = rotate_member(conn, args.id)
            if result is None:
                print("not found (or already revoked)")
                return 1
            ident, key = result
            print(f"new id:  {ident.id}")
            print(f"new key: {key}")
            print("(their private notes moved to the new id)", file=sys.stderr)
        elif args.cmd == "reattach-notes":
            try:
                moved, kept = reattach_notes(
                    conn, args.old_id, args.new_id, args.allow_different_name
                )
            except ReattachProblem as problem:
                print(f"Cannot continue: {problem}", file=sys.stderr)
                return 1
            print(f"moved: {moved}")
            if kept:
                print(f"kept:  {kept} (the new id already had a note on those songs; those stayed)")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
