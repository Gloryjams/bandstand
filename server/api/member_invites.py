"""Director-managed player links. Plaintext keys are returned only when minted."""
import secrets
import time

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from server import auth, config, db, members
from server.ulid import new_ulid

router = APIRouter(dependencies=[Depends(auth.require_director)])


@router.get('/api/member-invites')
def list_invites():
    conn = db.connect(config.load().db_path)
    try:
        return JSONResponse({'members': members.list_members(conn)}, headers={'Cache-Control': 'no-store'})
    finally:
        conn.close()


def _mint(name: str | None = None, replace_id: str | None = None):
    conn = db.connect(config.load().db_path)
    try:
        conn.execute('BEGIN IMMEDIATE')
        if replace_id:
            old = conn.execute("SELECT name FROM members WHERE id=? AND role='member' AND revoked_at IS NULL", (replace_id,)).fetchone()
            if not old:
                raise HTTPException(404, 'Member not found')
            name = old['name']
        elif any(r['name'].casefold() == name.casefold() for r in conn.execute('SELECT name FROM members WHERE revoked_at IS NULL')):
            raise HTTPException(409, 'Member access already exists. Use the saved link, or explicitly replace it.')
        key = secrets.token_hex(32); mid = new_ulid(); now = int(time.time() * 1000)
        conn.execute("INSERT INTO members(id,name,role,key_hash,created_at) VALUES (?,?,'member',?,?)", (mid, name, members.key_hash(key), now))
        if replace_id:
            conn.execute('UPDATE members SET revoked_at=? WHERE id=?', (now, replace_id))
            # Private notes are keyed by member id: the person keeps them under the new one.
            members.carry_notes(conn, replace_id, mid)
        conn.execute('COMMIT')
        return JSONResponse({'id': mid, 'name': name, 'role': 'member', 'key': key}, status_code=201, headers={'Cache-Control': 'no-store'})
    except BaseException:
        if conn.in_transaction:
            conn.execute('ROLLBACK')
        raise
    finally:
        conn.close()


@router.post('/api/member-invites')
def create_invite(body: dict):
    name = body.get('name')
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 100 or any(ord(ch) < 32 for ch in name):
        raise HTTPException(422, 'Enter a member name')
    return _mint(name=name.strip())


@router.post('/api/member-invites/{member_id}/replace')
def replace_invite(member_id: str):
    return _mint(replace_id=member_id)
