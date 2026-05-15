-- ============================================================
-- O&P data tables — skeptou-op D1 database
-- Sképtou / specs/op-d1-migration.md rev 2
-- ============================================================

PRAGMA foreign_keys = ON;

-- projects -------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
  slug            TEXT    PRIMARY KEY,
  title           TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','paused','completed','archived')),
  area            TEXT    CHECK (area IN ('research','teaching','service','administrative','personal')),
  description     TEXT,
  due_date        TEXT,                        -- ISO 8601 date (YYYY-MM-DD)
  priority        INTEGER NOT NULL DEFAULT 3   -- 1=critical 2=high 3=normal 4=low
                          CHECK (priority BETWEEN 1 AND 4),
  linked_opp_slug TEXT,                        -- NOT a DB FK (see spec §III.5)
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  archived_at     TEXT,
  metadata        TEXT    DEFAULT '{}'         -- JSON blob for extension fields
);

-- opportunities --------------------------------------------
CREATE TABLE IF NOT EXISTS opportunities (
  slug            TEXT    PRIMARY KEY,
  title           TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','accepted','rejected','deferred','expired')),
  opp_type        TEXT    CHECK (opp_type IN ('job','fellowship','grant','cfp','invitation','conference','other')),
  venue           TEXT,
  description     TEXT,
  deadline        TEXT,                        -- ISO 8601 date
  priority        INTEGER NOT NULL DEFAULT 3
                          CHECK (priority BETWEEN 1 AND 4),
  prestige        INTEGER CHECK (prestige BETWEEN 1 AND 5),
  requirement     TEXT,                        -- what this opportunity requires of Cam
  linked_project_slug TEXT,                    -- NOT a DB FK (see spec §III.5)
  decided_at      TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  archived_at     TEXT,
  metadata        TEXT    DEFAULT '{}'
);

-- tasks ----------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT    UNIQUE NOT NULL,
  title           TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','in_progress','completed','cancelled')),
  project_slug    TEXT    REFERENCES projects(slug) ON DELETE SET NULL,
  description     TEXT,
  due_date        TEXT,
  priority        INTEGER NOT NULL DEFAULT 3
                          CHECK (priority BETWEEN 1 AND 4),
  completed_at    TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  metadata        TEXT    DEFAULT '{}'
);

-- inventory ------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT    UNIQUE NOT NULL,
  name            TEXT    NOT NULL,
  category        TEXT    CHECK (category IN ('hardware','software','subscription','reference','credential','other')),
  status          TEXT    NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','retired','needed')),
  location        TEXT,
  notes           TEXT,
  acquired_at     TEXT,
  expires_at      TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  metadata        TEXT    DEFAULT '{}'
);

-- audit_log ------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  table_name      TEXT    NOT NULL,
  row_id          TEXT    NOT NULL,            -- slug (projects/opportunities/inventory) or id (tasks)
  operation       TEXT    NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE')),
  actor           TEXT    NOT NULL,            -- 'cam' or specialist role slug
  diff            TEXT    NOT NULL             -- JSON: { "before": {...}, "after": {...} }
);

-- service_tokens -------------------------------------------
-- Long-lived tokens for O&P specialist agents.
-- Managed via Phronesis admin endpoint or wrangler d1 execute directly.
CREATE TABLE IF NOT EXISTS service_tokens (
  token_hash      TEXT    PRIMARY KEY,         -- SHA-256 hex of the raw token
  role_slug       TEXT    NOT NULL,            -- e.g. 'pm-specialist', 'saa-specialist'
  scopes          TEXT    NOT NULL,            -- JSON array of allowed route prefixes
  issued_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at      TEXT    NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1   -- 0 = revoked
);
