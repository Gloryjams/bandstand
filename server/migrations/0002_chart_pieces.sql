-- Native chord-chart pieces. A chart is a piece with no PDF/image files: its whole
-- content is opaque Saltycharts JSON stored inline on the piece row, so it flows
-- through the existing manifest → Dexie mirror unchanged (no new table, no new sync
-- entity, no new manifest key). `kind` distinguishes it from the default 'pdf' piece;
-- `chart_source_id` is the Saltycharts chart.id, used to UPSERT on re-send after an edit.
--
-- Wrapped in an explicit transaction so the ALTERs, the index, and the version bump are
-- all-or-nothing. run_migrations() executes each file with executescript() on an
-- autocommit connection, so without this every ALTER would commit independently — a crash
-- between the first ALTER and the version INSERT would leave the schema half-migrated and
-- wedge every later boot on "duplicate column name". SQLite DDL is transactional, so this
-- makes the migration cleanly retryable. (executescript() issues an implicit COMMIT before
-- running the script; on an autocommit connection that's a harmless no-op, then this BEGIN
-- opens the real transaction.)
BEGIN;

ALTER TABLE pieces ADD COLUMN kind TEXT NOT NULL DEFAULT 'pdf';
ALTER TABLE pieces ADD COLUMN chart_json TEXT;
ALTER TABLE pieces ADD COLUMN chart_source_id TEXT;
-- The chart's on-disk filename (relative to the library dir). Charts have no files
-- row, so this is how the watcher maps a deleted .saltychart.json back to its piece.
ALTER TABLE pieces ADD COLUMN chart_file TEXT;

CREATE INDEX idx_pieces_chart_source ON pieces(chart_source_id);

INSERT INTO schema_version (version, applied_at)
VALUES (2, CAST(strftime('%s','now') AS INTEGER) * 1000);

COMMIT;
