import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useStore } from '@/store/useStore'
import type { Chart, LibraryBackup } from '@/types'
import { parseBackup } from '@/lib/backup'
import { loadBandstandConfig, saveBandstandConfig, servedByBandstand } from '@/lib/bandstand'
import {
  getSyncDetail,
  getSyncStatus,
  isSyncActive,
  runWithoutDeleteCapture,
  subscribeSync,
  syncNow,
} from '@/lib/sync'
import { IconSearch, IconPlay, IconPlus, IconImport, IconExport, IconList, IconEdit, IconTrash } from '@/ui/Icon'
import { MascotGuide } from '@/ui/Mascot'
import { fireMoment } from '@/ui/moments'
import type { Nav } from '@/App'

export function Library({ nav, onImport }: { nav: Nav; onImport: () => void }) {
  const charts = useStore((s) => s.charts)
  const setlists = useStore((s) => s.setlists)
  const createChart = useStore((s) => s.createChart)
  const createPocketChart = useStore((s) => s.createPocketChart)
  const createSetlist = useStore((s) => s.createSetlist)
  const deleteChart = useStore((s) => s.deleteChart)
  const deleteSetlist = useStore((s) => s.deleteSetlist)
  const exportBackup = useStore((s) => s.exportBackup)
  const importBackup = useStore((s) => s.importBackup)
  const [q, setQ] = useState('')

  // backup restore: file → parse → inline Merge/Replace choice (no browser dialogs)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [pendingRestore, setPendingRestore] = useState<LibraryBackup | null>(null)

  const doExport = () => {
    const backup = exportBackup()
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    // local date, not toISOString(): UTC stamps evening exports with tomorrow
    const d = new Date(backup.exportedAt)
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    a.download = `saltycharts-backup-${stamp}.json`
    // in-DOM anchor + deferred revoke: same-tick revocation aborts the
    // download on WebKit (the stage tablet's engine)
    document.body.appendChild(a)
    a.click()
    setTimeout(() => {
      a.remove()
      URL.revokeObjectURL(url)
    }, 1000)
    fireMoment(`Exported ${backup.charts.length} charts`, {})
  }

  const onRestoreFile = async (file: File) => {
    try {
      setPendingRestore(parseBackup(await file.text()))
    } catch (err) {
      fireMoment(err instanceof Error ? err.message : 'Restore failed', {})
    }
  }

  const applyRestore = (mode: 'merge' | 'replace') => {
    if (!pendingRestore) return
    // Replace swaps the whole local library; the disappearance of charts absent from
    // the backup must not sync out as server deletes (an old backup would destroy
    // newer work everywhere). The next pull re-merges whatever the server holds.
    runWithoutDeleteCapture(() => importBackup(pendingRestore, mode))
    fireMoment(
      `${mode === 'replace' ? 'Replaced library with' : 'Merged in'} ${pendingRestore.charts.length} charts`,
      {},
    )
    setPendingRestore(null)
    void syncNow()
  }

  // two-tap delete: first tap arms the trash (turns red), second tap deletes;
  // disarms itself after a beat so a stray tap never destroys anything
  const [armed, setArmed] = useState<string | null>(null)
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const armOrDelete = (id: string, doDelete: () => void, what: string) => {
    if (armed === id) {
      setArmed(null)
      doDelete()
      fireMoment(`${what} deleted`, {})
    } else {
      setArmed(id)
      if (armTimer.current) clearTimeout(armTimer.current)
      armTimer.current = setTimeout(() => setArmed((a) => (a === id ? null : a)), 2600)
    }
  }

  const sorted = useMemo(() => {
    const all = Object.values(charts)
    const needle = q.trim().toLowerCase()
    const filtered = needle
      ? all.filter(
          (c) =>
            c.title.toLowerCase().includes(needle) ||
            c.artist.toLowerCase().includes(needle) ||
            c.key.toLowerCase() === needle ||
            c.tags.some((t) => t.includes(needle)),
        )
      : all
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt)
  }, [charts, q])

  const setlistArr = Object.values(setlists).sort((a, b) => b.updatedAt - a.updatedAt)

  const newSong = () => nav.go({ view: 'editor', chartId: createChart() })
  const newSet = () => nav.go({ view: 'setlist', setlistId: createSetlist() })
  const newPocket = () => nav.go({ view: 'editor', chartId: createPocketChart() })

  return (
    <>
      <div className="search">
        <IconSearch size={18} />
        <input
          className="input"
          placeholder="Search by title, artist, or key..."
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {Object.keys(charts).length === 0 && (
        <MascotGuide mood="wave">
          Hey, I'm <b>Pinch</b>. Your library's empty  -  tap <b>+</b> to chart a tune by hand, or{' '}
          <b>Import</b> to paste chords from anywhere and I'll lay them out for you.
        </MascotGuide>
      )}

      {setlistArr.length > 0 && (
        <>
          <div className="section-title setlists-title">
            Setlists
            <span className="section-count">{setlistArr.length}</span>
            <button className="btn sm setlists-new" onClick={newSet}>
              <IconPlus size={15} /> New setlist
            </button>
          </div>
          <div className="cards">
            {setlistArr.map((sl) => (
              <button key={sl.id} className="song-card" onClick={() => nav.go({ view: 'setlist', setlistId: sl.id })}>
                <span className="song-key" style={{ background: 'var(--teal-soft)', color: 'var(--teal)' }}>
                  <IconList size={20} />
                </span>
                <span className="song-meta">
                  <span className="t">{sl.name}</span>
                  <span className="s">
                    {sl.chartIds.length} song{sl.chartIds.length === 1 ? '' : 's'}
                    {sl.venue ? ` · ${sl.venue}` : ''}
                  </span>
                </span>
                {sl.chartIds.length > 0 && (
                  <span
                    className="btn icon primary"
                    onClick={(e) => {
                      e.stopPropagation()
                      nav.go({ view: 'perform', setlistId: sl.id, perfIndex: 0 })
                    }}
                  >
                    <IconPlay size={16} />
                  </span>
                )}
                <span
                  className={`btn icon ghost trash${armed === sl.id ? ' armed' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    armOrDelete(sl.id, () => deleteSetlist(sl.id), 'Setlist')
                  }}
                >
                  <IconTrash size={15} />
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="section-title songs-title">
        Songs
        <span className="section-count">{sorted.length}</span>
      </div>

      {sorted.length === 0 && q ? (
        <div className="empty">
          <p>No songs match "{q}".</p>
        </div>
      ) : (
        <div className="cards">
          {sorted.map((c) => (
            <SongCard
              key={c.id}
              chart={c}
              armed={armed === c.id}
              onOpen={() => nav.go({ view: 'editor', chartId: c.id })}
              onPlay={() => nav.go({ view: 'perform', chartId: c.id, perfIndex: 0 })}
              onDelete={() => armOrDelete(c.id, () => deleteChart(c.id), 'Chart')}
            />
          ))}
        </div>
      )}

      <div className="divider" />
      <div className="row" style={{ gap: 10 }}>
        <button className="btn primary" onClick={newSong} style={{ flex: 1, justifyContent: 'center' }}>
          <IconPlus size={17} /> New chart
        </button>
        <button className="btn" onClick={newPocket} style={{ flex: 1, justifyContent: 'center' }}>
          <IconEdit size={16} /> Pocket chart
        </button>
        <button className="btn" onClick={onImport} style={{ flex: 1, justifyContent: 'center' }}>
          <IconImport size={17} /> Import
        </button>
      </div>

      <div className="section-title" style={{ marginTop: 18 }}>
        Backup <span className="line" />
      </div>
      {pendingRestore ? (
        <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="hint">
            Restore {pendingRestore.charts.length} charts, {pendingRestore.setlists.length} sets:
          </span>
          <button className="btn sm" onClick={() => applyRestore('merge')}>
            Merge
          </button>
          <button className="btn sm" onClick={() => applyRestore('replace')}>
            Replace library
          </button>
          <button className="btn ghost sm" onClick={() => setPendingRestore(null)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="row" style={{ gap: 10 }}>
          <button className="btn sm" onClick={doExport}>
            <IconExport size={15} /> Export library
          </button>
          <button className="btn sm" onClick={() => fileRef.current?.click()}>
            <IconImport size={15} /> Restore
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void onRestoreFile(f)
            }}
          />
        </div>
      )}
      <p className="hint" style={{ marginTop: 6 }}>
        {isSyncActive()
          ? 'Backups stay useful as snapshots, but with sync on, your library follows the Bandstand server across devices.'
          : 'Your library lives in this browser only. Export before switching devices or origins; Restore merges (the backup wins on matching ids) or replaces outright.'}
      </p>

      <SyncSection />
    </>
  )
}

/** Bandstand sync: status + manual kick when connected; a one-screen connect flow
    when not. Lives in the Library so a brand-new device can pull the whole library
    without hunting for the config buried in the editor's parts sheet. */
function SyncSection() {
  const status = useSyncExternalStore(subscribeSync, getSyncStatus)
  const [cfg, setCfg] = useState(loadBandstandConfig)
  const [draftUrl, setDraftUrl] = useState(cfg.url)
  const [draftKey, setDraftKey] = useState(cfg.key)
  const sameOrigin = servedByBandstand()

  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === 'saltycharts.bandstand.v1') {
        const next = loadBandstandConfig()
        setCfg(next); setDraftKey(next.key); setDraftUrl(next.url)
      }
    }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [])

  const connect = () => {
    const next = { url: sameOrigin ? '' : draftUrl.trim(), key: draftKey.trim() }
    saveBandstandConfig(next)
    setCfg(next)
    if (isSyncActive(next)) {
      fireMoment('Connected to Bandstand, syncing...', {})
      void syncNow()
    }
  }

  const label: Record<string, string> = {
    synced: 'Synced with Bandstand',
    pending: 'Changes waiting to sync',
    offline: 'Server unreachable, changes saved here and will sync later',
    error: `Sync error${getSyncDetail() ? ` (${getSyncDetail()})` : ''}, changes saved here`,
    off: '',
  }

  return (
    <>
      <div className="section-title" style={{ marginTop: 18 }}>
        Bandstand sync <span className="line" />
      </div>
      {isSyncActive(cfg) ? (
        <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="hint">{label[status] || label.synced}</span>
          <button className="btn sm" onClick={() => void syncNow()}>
            Sync now
          </button>
        </div>
      ) : (
        <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {!sameOrigin && (
            <input
              className="input"
              style={{ flex: '1 1 220px' }}
              placeholder="Bandstand URL (e.g. https://…:8443)"
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
            />
          )}
          <input
            className="input"
            style={{ flex: '1 1 180px' }}
            type="password"
            placeholder="Bandstand key"
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
          />
          <button className="btn sm" onClick={connect} disabled={!draftKey.trim()}>
            Connect
          </button>
          <p className="hint" style={{ width: '100%', marginTop: 2 }}>
            With a key set, your whole library lives on the Bandstand server and follows
            you to any device or address. Without one, this stays a local-only app.
          </p>
        </div>
      )}
    </>
  )
}

function SongCard({
  chart,
  armed,
  onOpen,
  onPlay,
  onDelete,
}: {
  chart: Chart
  armed: boolean
  onOpen: () => void
  onPlay: () => void
  onDelete: () => void
}) {
  return (
    <button className="song-card" onClick={onOpen}>
      <span className="song-key">{chart.key}</span>
      <span className="song-meta">
        <span className="t">{chart.title || 'Untitled'}</span>
        <span className="s">
          {chart.artist || ' - '}
          {chart.bpm ? ` · ${chart.bpm} bpm` : ''}
          {chart.style ? ` · ${chart.style}` : ''}
        </span>
        {chart.tags.length > 0 && (
          <span className="song-tags">
            {chart.tags.slice(0, 3).map((t) => (
              <span className="chip" key={t}>
                {t}
              </span>
            ))}
          </span>
        )}
      </span>
      <span
        className="btn icon primary"
        onClick={(e) => {
          e.stopPropagation()
          onPlay()
        }}
      >
        <IconPlay size={16} />
      </span>
      <span
        className={`btn icon ghost trash${armed ? ' armed' : ''}`}
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
      >
        <IconTrash size={15} />
      </span>
    </button>
  )
}
