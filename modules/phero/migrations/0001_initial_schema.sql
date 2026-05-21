-- ============================================================
-- Phero share metadata — skeptou-phero D1 database
-- Sképtou / specs/phero.md rev 4
-- ============================================================

CREATE TABLE IF NOT EXISTS shares (
  slug               TEXT    PRIMARY KEY,                -- URL segment; random 22-char or custom (4–64 chars)
  source_module      TEXT    NOT NULL CHECK (source_module IN ('energeia','aristeia')),
  source_slug        TEXT    NOT NULL,
  source_version     TEXT,                               -- NULL = live; set = snapshot at creation
  label              TEXT,                               -- human-readable Cam-facing name; never in URL
  recipient_email    TEXT,                               -- optional Cam annotation; NOT enforced for access
  expires_at         TEXT,                               -- NULL = no expiry; default 45 days from creation
  view_count         INTEGER NOT NULL DEFAULT 0,         -- denormalized for fast list rendering
  last_viewed_at     TEXT,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  revoked_at         TEXT,
  metadata           TEXT    NOT NULL DEFAULT '{}'
);

-- Per-access view log — supports per-share history drill-down in management UI
CREATE TABLE IF NOT EXISTS share_views (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  share_slug     TEXT    NOT NULL REFERENCES shares(slug),
  event_type     TEXT    NOT NULL CHECK (event_type IN ('view','download')),
  ip_hash        TEXT,          -- SHA-256(CF-Connecting-IP)
  cf_country     TEXT,          -- CF-IPCountry header (2-letter ISO; 'XX' if unknown)
  user_agent     TEXT,          -- truncated to 256 chars
  referrer       TEXT,          -- HTTP Referer (truncated to 256 chars)
  occurred_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Cam-action audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  row_key      TEXT    NOT NULL,
  action       TEXT    NOT NULL CHECK (action IN ('CREATE','REVOKE','UPDATE')),
  actor        TEXT    NOT NULL DEFAULT 'cam',
  snapshot     TEXT    NOT NULL DEFAULT '{}',
  occurred_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
