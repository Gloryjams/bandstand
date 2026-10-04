-- Read-only share links. A share is a bearer token that grants a stranger's phone
-- browser access to exactly one piece, or to the *current* members of one setlist
-- (setlist shares are live: editing the setlist changes what the link shows).
--
-- `target_id` has no FK because the target is polymorphic (a piece or a setlist), and
-- because a dangling target must degrade to a 404 rather than cascade-delete history.
-- `label` is denormalized from the target title at create time so the revoke list still
-- reads sensibly after the target is renamed or deleted. `expires_at` NULL means "until
-- revoked". Both timestamps are epoch milliseconds, matching every other table.
--
-- Wrapped in an explicit transaction for the same reason as 0002/0003: run_migrations()
-- executes each file with executescript() on an autocommit connection, so without this
-- BEGIN the CREATEs and the version INSERT would commit independently and a crash between
-- them would wedge every later boot on "table shares already exists".
BEGIN;

CREATE TABLE shares (
  id          TEXT PRIMARY KEY,
  token       TEXT NOT NULL UNIQUE,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('piece','setlist')),
  target_id   TEXT NOT NULL,
  label       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  revoked_at  INTEGER
);

-- The revoke list is the only listing query and it is always newest-first.
CREATE INDEX idx_shares_created ON shares(created_at DESC);

INSERT INTO schema_version (version, applied_at)
VALUES (4, CAST(strftime('%s','now') AS INTEGER) * 1000);

COMMIT;
