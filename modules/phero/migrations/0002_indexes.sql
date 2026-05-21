CREATE INDEX IF NOT EXISTS idx_shares_source     ON shares(source_module, source_slug);
CREATE INDEX IF NOT EXISTS idx_shares_created    ON shares(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shares_expires    ON shares(expires_at);
CREATE INDEX IF NOT EXISTS idx_views_slug        ON share_views(share_slug);
CREATE INDEX IF NOT EXISTS idx_views_occurred    ON share_views(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_views_country     ON share_views(cf_country);

CREATE VIEW IF NOT EXISTS active_shares AS
  SELECT * FROM shares
  WHERE revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%SZ','now'));
