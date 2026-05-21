-- ============================================================
-- Phero share metadata -- skeptou-phero D1 database
-- Skeptou / specs/phero.md rev 4 / brief-phero-phase1.md rev 2
-- ============================================================

CREATE TABLE IF NOT EXISTS shares (
  slug               TEXT    PRIMARY KEY,
  source_module      TEXT    NOT NULL CHECK (source_module IN ('energeia','aristeia')),
  source_slug        TEXT    NOT NULL,
  source_version     TEXT,
  label              TEXT,
  recipient_email    TEXT,
  expires_at         TEXT,
  view_count         INTEGER NOT NULL DEFAULT 0,
  last_viewed_at     TEXT,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  revoked_at         TEXT,
  metadata           TEXT    NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS share_views (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  share_slug     TEXT    NOT NULL REFERENCES shares(slug),
  event_type     TEXT    NOT NULL CHECK (event_type IN ('view','download')),
  ip_hash        TEXT,
  cf_country     TEXT,
  user_agent     TEXT,
  referrer       TEXT,
  occurred_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  row_key      TEXT    NOT NULL,
  action       TEXT    NOT NULL CHECK (action IN ('CREATE','REVOKE','UPDATE')),
  actor        TEXT    NOT NULL DEFAULT 'cam',
  snapshot     TEXT    NOT NULL DEFAULT '{}',
  occurred_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
