"""Create an empty song slot, keeping its identity when the real chart arrives."""
import json
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from server import auth, config, db
from server.api import events
from server.api.upload_chart import prepare_chart, write_and_upsert
from server.ulid import new_ulid

router = APIRouter(dependencies=[Depends(auth.require_key)])


class Placeholder(BaseModel):
    model_config = ConfigDict(extra='forbid')
    title: str = Field(min_length=1, max_length=300)
    composer: str = Field(default='', max_length=300)
    setlist_id: str | None = None


@router.post('/api/placeholders')
def create_placeholder(body: Placeholder):
    if not body.title.strip():
        raise HTTPException(422, 'Enter a song title')
    cfg = config.load()
    now = int(time.time() * 1000)
    chart = {'id': 'notes_' + new_ulid(), 'title': body.title.strip(), 'artist': body.composer.strip(),
             'sections': [], 'arrangement': [], 'createdAt': now, 'updatedAt': now}
    chart, target, rel = prepare_chart(cfg, chart)
    conn = db.connect(cfg.db_path)
    try:
        conn.execute('BEGIN IMMEDIATE')
        if body.setlist_id and not conn.execute('SELECT 1 FROM setlists WHERE id=?', (body.setlist_id,)).fetchone():
            raise HTTPException(404, 'Set unavailable')
        # An intentional empty slot must not adopt another slot with the same title.
        pid = write_and_upsert(conn, cfg, chart, target, rel, now, match_placeholder=False)
        conn.execute('UPDATE pieces SET is_placeholder=1 WHERE id=?', (pid,))
        if body.setlist_id:
            ordinal = conn.execute('SELECT COALESCE(MAX(ordinal),-1)+1 FROM setlist_items WHERE setlist_id=?', (body.setlist_id,)).fetchone()[0]
            conn.execute("INSERT INTO setlist_items(id,setlist_id,kind,piece_id,ordinal) VALUES (?,?,'piece',?,?)",
                         (new_ulid(), body.setlist_id, pid, ordinal))
            conn.execute('UPDATE setlists SET updated_at=? WHERE id=?', (now, body.setlist_id))
        conn.commit()
    except Exception:
        conn.rollback()
        target.unlink(missing_ok=True)
        raise
    finally:
        conn.close()
    events.publish('piece_changed', path=str(target))
    return {'id': pid}


def _has_chart_content(chart):
    """A title, section label or empty measure is still an unwritten draft."""
    if not isinstance(chart, dict) or not isinstance(chart.get('sections'), list):
        return False

    def written(value):
        return isinstance(value, str) and bool(value.strip())

    for section in chart['sections']:
        if not isinstance(section, dict):
            continue
        if any(written(section.get(field)) for field in ('description', 'hits')):
            return True
        bars = section.get('bars')
        if isinstance(bars, list) and any(
            isinstance(bar, dict) and any(written(bar.get(field)) for field in
                ('chords', 'lyrics', 'hits', 'direction', 'ending', 'sign'))
            for bar in bars
        ):
            return True
    section_ids = {section['id'] for section in chart['sections']
                   if isinstance(section, dict) and written(section.get('id'))}
    if isinstance(chart.get('arrangement'), list):
        for step in chart['arrangement']:
            if not isinstance(step, dict) or not isinstance(step.get('sectionId'), str) or step['sectionId'] not in section_ids:
                continue
            if any(written(step.get(field)) for field in ('note', 'hits')):
                return True
            if isinstance(step.get('solos'), list) and any(written(solo) for solo in step['solos']):
                return True
    return False


@router.post('/api/placeholders/{piece_id}/ready')
def mark_ready(piece_id: str):
    """Publish a text-only chart deliberately; metadata autosaves don't publish drafts."""
    conn = db.connect(config.load().db_path)
    try:
        conn.execute('BEGIN IMMEDIATE')
        row = conn.execute('SELECT chart_json FROM pieces WHERE id=? AND deleted_at IS NULL', (piece_id,)).fetchone()
        if not row or not row['chart_json']:
            raise HTTPException(404, 'Chart unavailable')
        try:
            chart = json.loads(row['chart_json'])
        except (TypeError, ValueError):
            chart = None
        if not _has_chart_content(chart):
            raise HTTPException(409, 'Add chords or rehearsal notes in Saltycharts before showing this chart.')
        conn.execute('UPDATE pieces SET is_placeholder=0,updated_at=? WHERE id=?', (int(time.time()*1000), piece_id))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    events.publish('piece_changed', path=piece_id)
    return {'id': piece_id}
