CREATE INDEX IF NOT EXISTS idx_publications_status      ON publications(status);
CREATE INDEX IF NOT EXISTS idx_publications_deleted_at  ON publications(deleted_at);
CREATE INDEX IF NOT EXISTS idx_import_history_slug      ON import_history(slug);
CREATE INDEX IF NOT EXISTS idx_import_history_imported  ON import_history(imported_at DESC);

CREATE VIEW IF NOT EXISTS live_publications AS
  SELECT * FROM publications WHERE deleted_at IS NULL;
