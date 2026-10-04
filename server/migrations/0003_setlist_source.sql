-- Setlists sent whole from Saltycharts ("send the set"). `source_id` is the Saltycharts
-- setlist.id — the UPSERT identity, so a re-sent set replaces its Bandstand setlist in
-- place instead of duplicating (mirrors pieces.chart_source_id from 0002). Saltycharts
-- owns the set name and the item order; Bandstand-native setlist columns (date/venue/
-- notes) it never sends are left untouched on re-send. There's no source_id on
-- setlist_items: items are rebuilt from the payload each send (order is the payload's).
--
-- Wrapped in an explicit transaction for the same reason as 0002: run_migrations()
-- executes each file with executescript() on an autocommit connection, so without this
-- BEGIN the ALTER and the version INSERT would commit independently — a crash between
-- them would leave the schema half-migrated and wedge every later boot on "duplicate
-- column name". SQLite DDL is transactional, so this makes the migration cleanly
-- retryable. (executescript() issues an implicit COMMIT before running the script; on an
-- autocommit connection that's a harmless no-op, then this BEGIN opens the real one.)
BEGIN;

ALTER TABLE setlists ADD COLUMN source_id TEXT;

CREATE INDEX idx_setlists_source ON setlists(source_id);

INSERT INTO schema_version (version, applied_at)
VALUES (3, CAST(strftime('%s','now') AS INTEGER) * 1000);

COMMIT;
