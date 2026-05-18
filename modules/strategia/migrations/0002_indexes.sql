CREATE INDEX IF NOT EXISTS idx_documents_source_team   ON documents(source_team);
CREATE INDEX IF NOT EXISTS idx_documents_content_type  ON documents(content_type);
CREATE INDEX IF NOT EXISTS idx_documents_created_at    ON documents(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_deleted_at    ON documents(deleted_at);
CREATE VIEW  IF NOT EXISTS live_documents AS
  SELECT * FROM documents WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_row_key       ON audit_log(row_key);
CREATE INDEX IF NOT EXISTS idx_audit_log_occurred_at   ON audit_log(occurred_at);
