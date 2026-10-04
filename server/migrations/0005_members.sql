-- Band members: a member's key IS their account (no passwords). Each member gets a
-- personal 64-hex key delivered as a pair link; only its sha256 lands here. The .key
-- file stays the root director credential and is NOT represented in this table, so
-- existing single-user instances keep working with zero re-pairing.
--
-- BEGIN/COMMIT so the CREATE and the version INSERT land atomically (a crash between
-- them would otherwise leave the schema half-applied but unversioned).
BEGIN;

CREATE TABLE members (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('director','member')),
  key_hash    TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);

INSERT INTO schema_version (version, applied_at)
VALUES (5, CAST(strftime('%s','now') AS INTEGER) * 1000);

COMMIT;
