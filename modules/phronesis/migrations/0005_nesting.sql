-- Phase 5 — nested sub-tasks + nested projects.
--
-- tasks: extend parent_kind to include 'task' so a task can itself be the
--        parent of a subtask. SQLite can't ALTER COLUMN CHECK in place, so
--        we recreate the table and copy rows. Audit log is unaffected.
--
-- projects: add a parent_id column referencing another project's slug
--        (app-level FK, mirroring the existing slug-based references).
--        ALTER TABLE … ADD COLUMN is supported by SQLite for nullable cols.
--
-- Cycle prevention lives in op-write.js (checkRefs); the schema only
-- enforces shape, not graph validity.
--
-- D1 wraps each migration in its own implicit transaction and rejects
-- raw BEGIN/COMMIT, so no explicit transaction block here.

-- ── tasks ────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS tasks_updated_at;
ALTER TABLE tasks RENAME TO tasks_old;

CREATE TABLE tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT    UNIQUE NOT NULL,
  title        TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','in_progress','completed','cancelled')),
  parent_kind  TEXT    CHECK (parent_kind IN ('project','commitment','task')),
  parent_id    TEXT,                          -- slug of parent (app-level FK)
  description  TEXT,
  due_date     TEXT,
  priority     INTEGER NOT NULL DEFAULT 3
                       CHECK (priority BETWEEN 1 AND 4),
  completed_at TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  metadata     TEXT    DEFAULT '{}'
);

INSERT INTO tasks (
  id, slug, title, status, parent_kind, parent_id, description, due_date,
  priority, completed_at, created_at, updated_at, metadata
)
SELECT
  id, slug, title, status, parent_kind, parent_id, description, due_date,
  priority, completed_at, created_at, updated_at, metadata
FROM tasks_old;

DROP TABLE tasks_old;

CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent   ON tasks(parent_kind, parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);

CREATE TRIGGER tasks_updated_at
  AFTER UPDATE ON tasks
  FOR EACH ROW BEGIN
    UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    WHERE id = OLD.id;
  END;

-- ── projects ─────────────────────────────────────────────────────────
-- A project can now be a sub-project of another project. parent_id holds
-- the parent project's slug (app-level FK). NULL = top-level project.
ALTER TABLE projects ADD COLUMN parent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_projects_parent ON projects(parent_id);
