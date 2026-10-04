-- Private rehearsal rooms. The room join token and per-participant credentials are
-- stored only as sha256 hashes; plaintext values are returned once to the client.
BEGIN;

CREATE TABLE rehearsal_rooms (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('draft','open','closed')),
  join_token_hash TEXT NOT NULL UNIQUE,
  join_expires_at INTEGER NOT NULL,
  revision        INTEGER NOT NULL DEFAULT 0,
  queue_revision  INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  closed_at       INTEGER
);

CREATE UNIQUE INDEX one_open_rehearsal_room
ON rehearsal_rooms(state) WHERE state = 'open';

CREATE TABLE room_participants (
  id              TEXT PRIMARY KEY,
  room_id         TEXT NOT NULL REFERENCES rehearsal_rooms(id) ON DELETE CASCADE,
  display_name    TEXT NOT NULL,
  instrument      TEXT NOT NULL,
  credential_hash TEXT NOT NULL UNIQUE,
  joined_at       INTEGER NOT NULL,
  left_at         INTEGER,
  UNIQUE (room_id, id)
);

CREATE INDEX room_participants_room ON room_participants(room_id, joined_at);

CREATE TABLE room_proposals (
  id              TEXT PRIMARY KEY,
  room_id         TEXT NOT NULL REFERENCES rehearsal_rooms(id) ON DELETE CASCADE,
  participant_id  TEXT NOT NULL REFERENCES room_participants(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  music_key       TEXT,
  piece_id        TEXT REFERENCES pieces(id),
  sharing_scope   TEXT NOT NULL DEFAULT 'session'
                    CHECK (sharing_scope IN ('session','save_allowed')),
  state           TEXT NOT NULL DEFAULT 'open'
                    CHECK (state IN ('open','queued','withdrawn')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (room_id, id),
  FOREIGN KEY (room_id, participant_id)
    REFERENCES room_participants(room_id, id) ON DELETE CASCADE
);

CREATE INDEX room_proposals_room ON room_proposals(room_id, created_at);

CREATE TABLE room_votes (
  room_id         TEXT NOT NULL REFERENCES rehearsal_rooms(id) ON DELETE CASCADE,
  proposal_id     TEXT NOT NULL,
  participant_id  TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('play','hear')),
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (proposal_id, participant_id, kind),
  FOREIGN KEY (room_id, proposal_id)
    REFERENCES room_proposals(room_id, id) ON DELETE CASCADE,
  FOREIGN KEY (room_id, participant_id)
    REFERENCES room_participants(room_id, id) ON DELETE CASCADE
);

CREATE TABLE room_volunteers (
  room_id         TEXT NOT NULL REFERENCES rehearsal_rooms(id) ON DELETE CASCADE,
  proposal_id     TEXT NOT NULL,
  participant_id  TEXT NOT NULL,
  instrument_key  TEXT NOT NULL,
  instrument      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (proposal_id, participant_id, instrument_key),
  FOREIGN KEY (room_id, proposal_id)
    REFERENCES room_proposals(room_id, id) ON DELETE CASCADE,
  FOREIGN KEY (room_id, participant_id)
    REFERENCES room_participants(room_id, id) ON DELETE CASCADE
);

CREATE TABLE room_queue_entries (
  id              TEXT PRIMARY KEY,
  room_id         TEXT NOT NULL REFERENCES rehearsal_rooms(id) ON DELETE CASCADE,
  proposal_id     TEXT,
  title           TEXT NOT NULL,
  music_key       TEXT,
  state           TEXT NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued','current','played','skipped')),
  ordinal         INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  FOREIGN KEY (proposal_id) REFERENCES room_proposals(id) ON DELETE SET NULL
);

CREATE INDEX room_queue_room ON room_queue_entries(room_id, ordinal);
CREATE UNIQUE INDEX room_queue_ordinal ON room_queue_entries(room_id, ordinal);
CREATE UNIQUE INDEX room_queue_proposal
ON room_queue_entries(room_id, proposal_id) WHERE proposal_id IS NOT NULL;
CREATE UNIQUE INDEX one_current_tune_per_room
ON room_queue_entries(room_id) WHERE state = 'current';

INSERT INTO schema_version (version, applied_at)
VALUES (6, CAST(strftime('%s','now') AS INTEGER) * 1000);

COMMIT;
