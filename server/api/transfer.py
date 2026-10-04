"""Director-to-director copies. Bundles contain music only, never pairing keys.

The browser carries the bundle between authenticated servers. Each destination
keeps its own pieces and reuses them on later copies; source edits cannot overwrite
those arrangements. A receipt makes retries of the same bundle idempotent.
"""
import hashlib
import json
import shutil
import tempfile
import time
import zipfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from server import auth, config, db
from server.api import events
from server.ingest import chart_meta
from server.ulid import new_ulid

router = APIRouter(dependencies=[Depends(auth.require_key)])
FORMAT = 'bandstand-copy-v1'
PIECE_FIELDS = ('title', 'composer', 'music_key', 'time_sig', 'tempo', 'genre', 'tags',
                'notes', 'page_count', 'preferred_orientation', 'default_half_page_turns', 'kind', 'is_placeholder')
TABLE_FIELDS = {
    'files': ('kind', 'page_count', 'ordinal', 'content_hash', 'bytes'),
    'audio_tracks': ('label', 'duration_ms', 'content_hash', 'bytes', 'ordinal'),
    'annotations': ('page_index', 'svg_paths'),
    'bookmarks': ('page_index', 'label', 'ordinal'),
    'section_links': ('from_page_index', 'initial_triggers', 'active'),
}
DOC_EXT = {'.pdf', '.png', '.jpg', '.jpeg', '.cho', '.chordpro', '.crd'}
AUDIO_EXT = {'.mp3', '.wav', '.m4a', '.flac'}


def _limit(cfg):
    return min(cfg.max_upload_mb * 10, 500) * 1024 * 1024


def _rows(conn, table, pid):
    live = ' AND deleted_at IS NULL' if table in ('files', 'audio_tracks') else ''
    return [dict(r) for r in conn.execute(f'SELECT * FROM {table} WHERE piece_id = ?{live}', (pid,))]


def export_bundle(cfg, *, setlist_id=None, piece_id=None):
    conn = db.connect(cfg.db_path)
    tmp = None
    try:
        conn.execute('BEGIN')
        bundle = {'format': FORMAT, 'copy_id': new_ulid(), 'pieces': [], 'items': [], 'setlist': None}
        if setlist_id:
            row = conn.execute('SELECT * FROM setlists WHERE id = ?', (setlist_id,)).fetchone()
            if not row:
                raise HTTPException(404, 'Set not found')
            bundle['setlist'] = {k: row[k] for k in ('name', 'date', 'venue', 'notes')}
            bundle['items'] = [dict(r) for r in conn.execute(
                'SELECT kind, piece_id, break_label FROM setlist_items WHERE setlist_id = ? ORDER BY ordinal', (setlist_id,))]
            ids = list(dict.fromkeys(it['piece_id'] for it in bundle['items'] if it['kind'] == 'piece'))
        else:
            ids = [piece_id]
        if len(ids) > 100 or len(bundle['items']) > 300:
            raise HTTPException(413, 'Copy up to 100 tunes in one set')
        fd = tempfile.NamedTemporaryFile(suffix='.zip', delete=False)
        tmp = Path(fd.name)
        fd.close()
        total = 0
        with zipfile.ZipFile(tmp, 'w', compression=zipfile.ZIP_STORED) as archive:
            for pid in ids:
                row = conn.execute('SELECT * FROM pieces WHERE id = ? AND deleted_at IS NULL', (pid,)).fetchone()
                if not row:
                    raise HTTPException(409, 'A tune in this set is missing. Refresh the set before copying.')
                piece = {k: row[k] for k in PIECE_FIELDS}
                piece['id'] = pid
                piece['chart'] = json.loads(row['chart_json']) if row['kind'] == 'chart' else None
                for table in TABLE_FIELDS:
                    piece[table] = _rows(conn, table, pid)
                for table in ('files', 'audio_tracks'):
                    for media in piece[table]:
                        path = (cfg.library_dir / media['filename']).resolve()
                        if cfg.library_dir.resolve() not in path.parents or not path.is_file():
                            raise HTTPException(409, 'A chart or audio file is unavailable. Nothing was copied.')
                        total += path.stat().st_size
                        if total > _limit(cfg):
                            raise HTTPException(413, 'This set is too large to copy in one operation')
                        name = f"media/{media['id']}{path.suffix.lower()}"
                        media['archive_name'] = name
                        digest = hashlib.sha256()
                        with path.open('rb') as src, archive.open(name, 'w') as dest:
                            while chunk := src.read(1024 * 1024):
                                digest.update(chunk)
                                dest.write(chunk)
                        if digest.hexdigest() != media['content_hash']:
                            raise HTTPException(409, 'A file changed while preparing the copy. Try again.')
                bundle['pieces'].append(piece)
            raw = json.dumps(bundle).encode()
            if len(raw) > 5_000_000:
                raise HTTPException(413, 'Too much chart data in this set')
            archive.writestr('manifest.json', raw)
        return tmp
    except Exception:
        if tmp:
            tmp.unlink(missing_ok=True)
        raise
    finally:
        conn.close()


def _insert(conn, table, row):
    # Keys here are selected from constant field lists, never supplied as SQL.
    cols = ','.join(row)
    conn.execute(f"INSERT INTO {table} ({cols}) VALUES ({','.join('?' for _ in row)})", tuple(row.values()))


def _setting(conn, key):
    r = conn.execute("SELECT value FROM settings WHERE device_id = 'band-copy' AND key = ?", (key,)).fetchone()
    return json.loads(r['value']) if r else None


def _remember(conn, key, value, now):
    conn.execute("INSERT OR REPLACE INTO settings (device_id,key,value,updated_at) VALUES ('band-copy',?,?,?)",
                 (key, json.dumps(value), now))


def _validate(bundle, archive, cfg):
    def require(condition):
        if not condition:
            raise HTTPException(422, 'Invalid band copy')
    require(isinstance(bundle, dict) and bundle.get('format') == FORMAT)
    require(isinstance(bundle.get('copy_id'), str) and len(bundle['copy_id']) == 26)
    pieces, items = bundle.get('pieces'), bundle.get('items')
    require(isinstance(pieces, list) and len(pieces) <= 100)
    require(isinstance(items, list) and len(items) <= 300)
    require(bundle.get('setlist') is None or isinstance(bundle['setlist'], dict))
    ids, names = set(), {'manifest.json'}
    for p in pieces:
        require(isinstance(p, dict) and isinstance(p.get('id'), str) and 0 < len(p['id']) <= 100)
        require(p['id'] not in ids)
        ids.add(p['id'])
        require(isinstance(p.get('title'), str) and isinstance(p.get('page_count'), int) and p['page_count'] >= 0)
        require(p.get('kind') in ('pdf', 'chart'))
        require(all(isinstance(p.get(table), list) and len(p[table]) <= 2000 for table in TABLE_FIELDS))
        # Only scalar DB fields may reach the SQL binder.
        require(all(p.get(k) is None or isinstance(p[k], (str, int, float)) for k in PIECE_FIELDS))
        if p['kind'] == 'chart':
            require(chart_meta.validate(p.get('chart'), len(json.dumps(p.get('chart')).encode()))[0])
        file_ids, mark_ids = set(), set()
        for table in ('files', 'audio_tracks'):
            for row in p[table]:
                require(isinstance(row, dict) and all(k in row for k in TABLE_FIELDS[table]))
                name = row.get('archive_name')
                require(isinstance(name, str) and name.startswith('media/') and len(Path(name).parts) == 2 and '\\' not in name)
                require(name not in names and Path(name).suffix in (DOC_EXT if table == 'files' else AUDIO_EXT))
                require(isinstance(row.get('id'), str) and row['id'] not in file_ids)
                require(all(row[k] is None or isinstance(row[k], (str, int, float)) for k in TABLE_FIELDS[table]))
                names.add(name)
                if table == 'files':
                    file_ids.add(row['id'])
        for row in p['bookmarks']:
            require(isinstance(row, dict) and isinstance(row.get('id'), str) and row.get('file_id') in file_ids)
            mark_ids.add(row['id'])
        for row in p['annotations']:
            require(isinstance(row, dict) and row.get('file_id') in file_ids)
            require(isinstance(row.get('svg_paths'), str) and isinstance(json.loads(row['svg_paths']), list))
        for row in p['section_links']:
            require(isinstance(row, dict) and row.get('from_file_id') in file_ids and row.get('to_bookmark_id') in mark_ids)
        for table in ('annotations', 'bookmarks', 'section_links'):
            for row in p[table]:
                require(all(k in row and (row[k] is None or isinstance(row[k], (str, int, float))) for k in TABLE_FIELDS[table]))
    for item in items:
        require(isinstance(item, dict) and item.get('kind') in ('piece', 'break'))
        require(item.get('kind') != 'piece' or item.get('piece_id') in ids)
        require(item.get('break_label') is None or isinstance(item['break_label'], str))
    if bundle.get('setlist'):
        require(isinstance(bundle['setlist'].get('name'), str))
        require(all(bundle['setlist'].get(k) is None or isinstance(bundle['setlist'][k], str) for k in ('date', 'venue', 'notes')))
    entries = archive.infolist()
    require(len(entries) == len(names) and {e.filename for e in entries} == names)
    require(all(not e.is_dir() and not (e.flag_bits & 1) for e in entries))
    if sum(e.file_size for e in entries) > _limit(cfg):
        raise HTTPException(413, 'This copy is too large')


def import_bundle(cfg, path):
    stage = Path(tempfile.mkdtemp(prefix='band-copy-', dir=cfg.data_dir))
    conn = None
    moved = []
    thumbnails = {}
    try:
        with zipfile.ZipFile(path) as archive:
            if archive.getinfo('manifest.json').file_size > 5_000_000:
                raise HTTPException(413, 'Copy manifest too large')
            bundle = json.loads(archive.read('manifest.json'))
            _validate(bundle, archive, cfg)
            extracted = 0
            # Check every file before taking a DB lock or publishing any new file.
            for p in bundle['pieces']:
                for table in ('files', 'audio_tracks'):
                    for media in p[table]:
                        name = media['archive_name']
                        target = stage / Path(name).name
                        digest, size = hashlib.sha256(), 0
                        with archive.open(name) as src, target.open('wb') as dest:
                            while chunk := src.read(1024 * 1024):
                                size += len(chunk)
                                extracted += len(chunk)
                                # Existing recordings can exceed the new-upload
                                # cap. Copies keep the bounded whole-bundle limit.
                                if extracted > _limit(cfg):
                                    raise HTTPException(413, 'This copy is too large')
                                digest.update(chunk)
                                dest.write(chunk)
                        if digest.hexdigest() != media['content_hash'] or size != media['bytes']:
                            raise HTTPException(422, 'Copy file verification failed')
        conn = db.connect(cfg.db_path)
        conn.execute('BEGIN IMMEDIATE')
        receipt_key = 'receipt:' + bundle['copy_id']
        prior = _setting(conn, receipt_key)
        if prior:
            conn.execute('COMMIT')
            return prior
        now = int(time.time() * 1000)
        mapping, created, reused = {}, 0, 0
        if cfg.library_quota_mb:
            used = sum(p.stat().st_size for p in cfg.library_dir.rglob('*') if p.is_file())
            incoming = sum(p.stat().st_size for p in stage.iterdir()) + sum(len(json.dumps(p.get('chart')).encode()) for p in bundle['pieces'])
            if used + incoming > cfg.library_quota_mb * 1024 * 1024:
                raise HTTPException(413, 'The destination library is full')
        for p in bundle['pieces']:
            source = p['id']
            previous = _setting(conn, 'piece:' + source)
            if previous and conn.execute('SELECT 1 FROM pieces WHERE id=? AND deleted_at IS NULL', (previous,)).fetchone():
                mapping[source] = previous
                reused += 1
                continue
            pid = new_ulid()
            mapping[source] = pid
            row = {k: p.get(k) for k in PIECE_FIELDS}
            row.update(id=pid, added_at=now, updated_at=now, is_placeholder=int(bool(p.get('is_placeholder'))))
            if p['kind'] == 'chart':
                chart = {**p['chart'], 'id': new_ulid(), 'createdAt': now, 'updatedAt': now}
                row.update(chart_source_id=chart['id'], chart_json=json.dumps(chart), chart_file=chart['id'] + chart_meta.CHART_SUFFIX)
                chart_path = cfg.library_dir / row['chart_file']
                staged = stage / chart_path.name
                staged.write_text(json.dumps(chart, ensure_ascii=False), encoding='utf-8')
                staged.replace(chart_path)
                moved.append(chart_path)
            _insert(conn, 'pieces', row)
            file_map, bookmark_map = {}, {}
            for table in ('files', 'audio_tracks'):
                for media in p[table]:
                    mid = new_ulid()
                    if table == 'files':
                        file_map[media['id']] = mid
                    target = cfg.library_dir / ('copies-' + pid) / (mid + Path(media['archive_name']).suffix)
                    target.parent.mkdir(exist_ok=True)
                    shutil.copyfile(stage / Path(media['archive_name']).name, target)
                    moved.append(target)
                    r = {k: media.get(k) for k in TABLE_FIELDS[table]}
                    r.update(id=mid, piece_id=pid, filename=target.relative_to(cfg.library_dir).as_posix(), added_at=now)
                    _insert(conn, table, r)
                    if table == 'files' and r['kind'] == 'pdf':
                        thumbnails.setdefault(pid, target)
            for mark in p['bookmarks']:
                mid = new_ulid()
                bookmark_map[mark['id']] = mid
                _insert(conn, 'bookmarks', {**{k: mark[k] for k in TABLE_FIELDS['bookmarks']}, 'id': mid, 'piece_id': pid, 'file_id': file_map[mark['file_id']]})
            for ann in p['annotations']:
                _insert(conn, 'annotations', {**{k: ann[k] for k in TABLE_FIELDS['annotations']}, 'piece_id': pid, 'file_id': file_map[ann['file_id']], 'updated_at': now})
            for link in p['section_links']:
                _insert(conn, 'section_links', {**{k: link[k] for k in TABLE_FIELDS['section_links']}, 'id': new_ulid(), 'piece_id': pid, 'from_file_id': file_map[link['from_file_id']], 'to_bookmark_id': bookmark_map[link['to_bookmark_id']]})
            _remember(conn, 'piece:' + source, pid, now)
            created += 1
        sid = None
        if bundle['setlist'] is not None:
            sid = new_ulid()
            _insert(conn, 'setlists', {**{k: bundle['setlist'].get(k) for k in ('name', 'date', 'venue', 'notes')}, 'id': sid, 'created_at': now, 'updated_at': now})
            for i, item in enumerate(bundle['items']):
                _insert(conn, 'setlist_items', {'id': new_ulid(), 'setlist_id': sid, 'ordinal': i, 'kind': item['kind'], 'piece_id': mapping[item['piece_id']] if item['kind'] == 'piece' else None, 'break_label': item.get('break_label')})
        result = {'id': sid or next(iter(mapping.values()), None), 'kind': 'setlist' if sid else 'piece', 'created': created, 'reused': reused}
        _remember(conn, receipt_key, result, now)
        conn.execute('COMMIT')
        # The durable copy is complete. Presentation/live-push failures must never
        # remove files belonging to committed rows.
        moved.clear()
        from server.ingest import pdf_meta
        for pid, target in thumbnails.items():
            try:
                pdf_meta.render_thumbnail(target, cfg.thumbs_dir / f'{pid}.png')
            except Exception:
                pass  # The chart itself remains readable if preview generation fails.
        try:
            events.publish('data_changed')
        except Exception:
            pass  # Devices also refresh on open/focus.
        return result
    except (ValueError, KeyError, TypeError, zipfile.BadZipFile) as exc:
        if conn and conn.in_transaction:
            conn.execute('ROLLBACK')
        for p in moved:
            p.unlink(missing_ok=True)
        raise HTTPException(422, 'Invalid band copy') from exc
    except Exception:
        if conn and conn.in_transaction:
            conn.execute('ROLLBACK')
        for p in moved:
            p.unlink(missing_ok=True)
        raise
    finally:
        if conn:
            conn.close()
        shutil.rmtree(stage, ignore_errors=True)


@router.get('/api/transfer/setlists/{setlist_id}')
def export_set(setlist_id: str):
    path = export_bundle(config.load(), setlist_id=setlist_id)
    return FileResponse(path, media_type='application/zip', filename='bandstand-copy.zip', background=BackgroundTask(path.unlink, missing_ok=True))


@router.get('/api/transfer/pieces/{piece_id}')
def export_piece(piece_id: str):
    path = export_bundle(config.load(), piece_id=piece_id)
    return FileResponse(path, media_type='application/zip', filename='bandstand-copy.zip', background=BackgroundTask(path.unlink, missing_ok=True))


@router.post('/api/transfer/import')
async def receive_copy(request: Request):
    cfg = config.load()
    with tempfile.TemporaryDirectory(prefix='band-transfer-') as tmp:
        path = Path(tmp) / 'copy.zip'
        size = 0
        with path.open('wb') as out:
            # Authenticate before consuming the archive, with an enforced byte cap
            # even when Content-Length is absent. No multipart pre-spooling.
            async for chunk in request.stream():
                size += len(chunk)
                if size > _limit(cfg):
                    raise HTTPException(413, 'This copy is too large')
                out.write(chunk)
        # Keep ZIP/file IO off the event loop while rehearsal devices sync.
        from starlette.concurrency import run_in_threadpool
        return await run_in_threadpool(import_bundle, cfg, path)
