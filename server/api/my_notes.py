"""Private text notes. No content is included in manifests, shares, copies or SSE."""
import time

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from server import auth, config, db
from server.members import Identity

router = APIRouter()


class NoteWrite(BaseModel):
    model_config = ConfigDict(extra='forbid')
    content: str = Field(max_length=50000, strict=True)
    base_revision: int = Field(ge=0, strict=True)
    mutation_id: str = Field(min_length=1, max_length=100, pattern=r'^[A-Za-z0-9_-]+$')


@router.get('/api/my-notes')
def read_notes(response: Response, identity: Identity = Depends(auth.require_identity)):
    response.headers['Cache-Control'] = 'no-store'
    conn = db.connect(config.load().db_path)
    try:
        notes = [dict(r) for r in conn.execute(
            'SELECT piece_id, content, revision, mutation_id, updated_at '
            'FROM personal_notes WHERE owner_id = ?', (identity.id,))]
        return {'notes': notes}
    finally:
        conn.close()


@router.put('/api/my-notes/{piece_id}')
def write_note(piece_id: str, body: NoteWrite, response: Response,
               identity: Identity = Depends(auth.require_identity)):
    response.headers['Cache-Control'] = 'no-store'
    conn = db.connect(config.load().db_path)
    try:
        conn.execute('BEGIN IMMEDIATE')
        if not conn.execute('SELECT 1 FROM pieces WHERE id = ? AND deleted_at IS NULL', (piece_id,)).fetchone():
            raise HTTPException(404, 'Song unavailable')
        row = conn.execute('SELECT piece_id, content, revision, mutation_id, updated_at '
                           'FROM personal_notes WHERE owner_id = ? AND piece_id = ?', (identity.id, piece_id)).fetchone()
        current = dict(row) if row else {'piece_id': piece_id, 'content': '', 'revision': 0, 'mutation_id': '', 'updated_at': 0}
        if current['mutation_id'] == body.mutation_id and current['content'] == body.content:
            conn.commit()
            return current  # Retry after losing a successful response.
        if current['revision'] != body.base_revision:
            conn.rollback()
            return JSONResponse({'current': current}, status_code=409, headers={'Cache-Control': 'no-store'})
        note = dict(piece_id=piece_id, content=body.content, revision=current['revision'] + 1,
                    mutation_id=body.mutation_id, updated_at=int(time.time() * 1000))
        conn.execute('INSERT INTO personal_notes(owner_id,piece_id,content,revision,mutation_id,updated_at) '
                     'VALUES (?,?,?,?,?,?) ON CONFLICT(owner_id,piece_id) DO UPDATE SET '
                     'content=excluded.content, revision=excluded.revision, mutation_id=excluded.mutation_id, updated_at=excluded.updated_at',
                     (identity.id, piece_id, note['content'], note['revision'], note['mutation_id'], note['updated_at']))
        conn.commit()
        return note
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
