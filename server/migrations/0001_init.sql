CREATE TABLE pieces (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  composer        TEXT,
  music_key       TEXT,
  time_sig        TEXT,
  tempo           INTEGER,
  genre           TEXT,
  tags            TEXT NOT NULL DEFAULT '[]',
  notes           TEXT,
  page_count      INTEGER NOT NULL,
  added_at        INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_opened_at  INTEGER,
  play_count      INTEGER NOT NULL DEFAULT 0,
  preferred_orientation TEXT,
  default_half_page_turns INTEGER NOT NULL DEFAULT 0,
  deleted_at      INTEGER
);

CREATE TABLE files (
  id              TEXT PRIMARY KEY,
  piece_id        TEXT NOT NULL REFERENCES pieces(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  filename        TEXT NOT NULL,
  page_count      INTEGER NOT NULL,
  ordinal         INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  added_at        INTEGER NOT NULL,
  deleted_at      INTEGER
);

CREATE TABLE audio_tracks (
  id              TEXT PRIMARY KEY,
  piece_id        TEXT NOT NULL REFERENCES pieces(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,
  label           TEXT,
  duration_ms     INTEGER,
  content_hash    TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  added_at        INTEGER NOT NULL,
  ordinal         INTEGER NOT NULL DEFAULT 0,
  deleted_at      INTEGER
);

CREATE TABLE annotations (
  piece_id        TEXT NOT NULL,
  file_id         TEXT NOT NULL,
  page_index      INTEGER NOT NULL,
  svg_paths       TEXT NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (piece_id, file_id, page_index)
);

CREATE TABLE bookmarks (
  id              TEXT PRIMARY KEY,
  piece_id        TEXT NOT NULL REFERENCES pieces(id) ON DELETE CASCADE,
  file_id         TEXT NOT NULL,
  page_index      INTEGER NOT NULL,
  label           TEXT NOT NULL,
  ordinal         INTEGER NOT NULL
);

CREATE TABLE section_links (
  id              TEXT PRIMARY KEY,
  piece_id        TEXT NOT NULL REFERENCES pieces(id) ON DELETE CASCADE,
  from_file_id    TEXT NOT NULL,
  from_page_index INTEGER NOT NULL,
  to_bookmark_id  TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  initial_triggers INTEGER NOT NULL DEFAULT 1,
  active          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE setlists (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  date            TEXT,
  venue           TEXT,
  notes           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE setlist_items (
  id              TEXT PRIMARY KEY,
  setlist_id      TEXT NOT NULL REFERENCES setlists(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  piece_id        TEXT REFERENCES pieces(id) ON DELETE CASCADE,
  break_label     TEXT,
  ordinal         INTEGER NOT NULL,
  UNIQUE (setlist_id, ordinal)
);

CREATE TABLE settings (
  device_id       TEXT NOT NULL,
  key             TEXT NOT NULL,
  value           TEXT NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (device_id, key)
);

CREATE TABLE schema_version (
  version         INTEGER PRIMARY KEY,
  applied_at      INTEGER NOT NULL
);

CREATE INDEX idx_files_piece     ON files(piece_id);
CREATE INDEX idx_audio_piece     ON audio_tracks(piece_id);
CREATE INDEX idx_bookmarks_piece ON bookmarks(piece_id);
CREATE INDEX idx_links_from      ON section_links(piece_id, from_file_id, from_page_index);
CREATE INDEX idx_setlist_items   ON setlist_items(setlist_id, ordinal);
CREATE INDEX idx_files_hash      ON files(content_hash);
CREATE INDEX idx_audio_hash      ON audio_tracks(content_hash);

INSERT INTO schema_version (version, applied_at) VALUES (1, CAST(strftime('%s','now') AS INTEGER) * 1000);
