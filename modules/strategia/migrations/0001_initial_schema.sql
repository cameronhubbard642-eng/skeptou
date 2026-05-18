-- ============================================================
-- Strategia document metadata — skeptou-strategia D1 database
-- Sképtou / specs/strategia.md rev 2
-- ============================================================

CREATE TABLE IF NOT EXISTS documents (
  slug            TEXT    PRIMARY KEY,
  title           TEXT    NOT NULL,
  source_team     TEXT    NOT NULL,
  source_actor    TEXT    NOT NULL,
  content_type    TEXT    NOT NULL
                          CHECK (content_type IN ('brief','annotated_pdf','worksheet','report','image','other')),
  mime_type       TEXT    NOT NULL,
  r2_key          TEXT    NOT NULL UNIQUE,
  byte_size       INTEGER NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  deleted_at      TEXT,
  tags            TEXT    NOT NULL DEFAULT '[]',
  metadata        TEXT    NOT NULL DEFAULT '{}'
);

CREATE TRIGGER IF NOT EXISTS documents_no_update
  BEFORE UPDATE ON documents FOR EACH ROW
  WHEN NEW.slug != OLD.slug OR NEW.r2_key != OLD.r2_key OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'slug, r2_key, and created_at are immutable');
END;

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name    TEXT    NOT NULL DEFAULT 'documents',
  row_key       TEXT    NOT NULL,
  action        TEXT    NOT NULL CHECK (action IN ('INSERT','DELETE')),
  actor         TEXT    NOT NULL,
  snapshot      TEXT    NOT NULL DEFAULT '{}',
  occurred_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
