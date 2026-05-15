-- ============================================================
-- Indexes — skeptou-op D1 database
-- Sképtou / specs/op-d1-migration.md rev 2 §III.3
-- ============================================================

-- projects
CREATE INDEX IF NOT EXISTS idx_projects_status    ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_area      ON projects(area);
CREATE INDEX IF NOT EXISTS idx_projects_priority  ON projects(priority);
CREATE INDEX IF NOT EXISTS idx_projects_due_date  ON projects(due_date);

-- opportunities
CREATE INDEX IF NOT EXISTS idx_opps_status        ON opportunities(status);
CREATE INDEX IF NOT EXISTS idx_opps_deadline      ON opportunities(deadline);
CREATE INDEX IF NOT EXISTS idx_opps_priority      ON opportunities(priority);
CREATE INDEX IF NOT EXISTS idx_opps_prestige      ON opportunities(prestige);

-- tasks
CREATE INDEX IF NOT EXISTS idx_tasks_status       ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_project      ON tasks(project_slug);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date     ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_priority     ON tasks(priority);

-- audit_log
CREATE INDEX IF NOT EXISTS idx_audit_ts           ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_table        ON audit_log(table_name);
CREATE INDEX IF NOT EXISTS idx_audit_actor        ON audit_log(actor);

-- service_tokens
CREATE INDEX IF NOT EXISTS idx_svc_role           ON service_tokens(role_slug);
