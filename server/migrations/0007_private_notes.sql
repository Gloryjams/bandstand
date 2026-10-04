BEGIN;

-- Account ownership is resolved from authentication, never a client-supplied id.
-- Root is also an owner, so owner_id deliberately isn't an FK to members.
CREATE TABLE personal_notes (
    owner_id TEXT NOT NULL,
    piece_id TEXT NOT NULL REFERENCES pieces(id),
    content TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 0,
    mutation_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id, piece_id)
);
ALTER TABLE pieces ADD COLUMN is_placeholder INTEGER NOT NULL DEFAULT 0;
-- Remember the retired draft so a stale editor or a startup scan cannot resurrect it.
ALTER TABLE pieces ADD COLUMN placeholder_source_id TEXT;
CREATE INDEX idx_pieces_placeholder_source ON pieces(placeholder_source_id);

INSERT INTO schema_version(version, applied_at)
VALUES(7, CAST(strftime('%s','now') AS INTEGER) * 1000);
COMMIT;
