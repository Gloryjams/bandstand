-- How many rehearsal rooms may be open at once is now a server setting
-- (BANDSTAND_ROOMS_MAX_OPEN, default 1), checked by the server inside the
-- transaction that opens a room. The index that hard-wired "exactly one" goes.
-- Nothing else about rooms changes.
BEGIN;

DROP INDEX IF EXISTS one_open_rehearsal_room;

INSERT INTO schema_version(version, applied_at)
VALUES(8, CAST(strftime('%s','now') AS INTEGER) * 1000);

COMMIT;
