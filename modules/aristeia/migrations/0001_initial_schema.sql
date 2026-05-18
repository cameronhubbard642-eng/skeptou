-- ============================================================
-- Aristeia publication metadata — skeptou-aristeia D1 database
-- Sképtou / specs/aristeia.md rev 2
-- ============================================================

CREATE TABLE IF NOT EXISTS publications (
  slug            TEXT    PRIMARY KEY,
  title           TEXT    NOT NULL,
  authors         TEXT    NOT NULL DEFAULT '[]',     -- JSON array
  status          TEXT    NOT NULL
                          CHECK (status IN ('draft','in_pipeline','submitted','under_review',
                                            'accepted','published','archived')),
  current_version TEXT,                              -- e.g. 'v1.3' or NULL if no version tag
  r2_key          TEXT    NOT NULL UNIQUE,           -- canonical: publications/<slug>/canonical.pdf
  byte_size       INTEGER NOT NULL,
  citation        TEXT    NOT NULL DEFAULT '{}',     -- CitationMetadata JSON
  notes           TEXT    NOT NULL DEFAULT '',
  imported_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  deleted_at      TEXT                               -- NULL = live; soft-delete tombstone
);

CREATE TABLE IF NOT EXISTS import_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT    NOT NULL REFERENCES publications(slug),
  version_tag     TEXT,                              -- energeia version tag at import time
  r2_history_key  TEXT    NOT NULL,                  -- publications/<slug>/history/<imported_at>.pdf
  byte_size       INTEGER NOT NULL,
  imported_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  import_source   TEXT    NOT NULL DEFAULT 'energeia' CHECK (import_source IN ('energeia','manual')),
  metadata_snapshot TEXT  NOT NULL DEFAULT '{}'      -- CitationMetadata at import time
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name    TEXT    NOT NULL,
  row_key       TEXT    NOT NULL,
  action        TEXT    NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE','IMPORT')),
  actor         TEXT    NOT NULL,
  snapshot      TEXT    NOT NULL DEFAULT '{}',
  occurred_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
