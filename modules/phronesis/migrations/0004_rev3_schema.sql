-- ============================================================
-- rev 3 schema deltas — skeptou-op D1 database
-- Sképtou / specs/op-d1-migration.md rev 3
--
-- Applied on top of 0001-0003. Brings the schema to rev 3:
--   - opportunities: + accepted_at, + archived; - archived_at
--   - active_opportunities / declined_opportunities views
--   - commitments table (+ indexes, + updated_at trigger)
--   - tasks: project_slug FK replaced by polymorphic parent_kind/parent_id
-- ============================================================

-- opportunities — rev 3 columns -----------------------------
ALTER TABLE opportunities ADD COLUMN accepted_at TEXT;
ALTER TABLE opportunities ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE opportunities DROP COLUMN archived_at;

CREATE INDEX IF NOT EXISTS idx_opps_archived ON opportunities(archived);

-- active_opportunities view — the live decision queue (archived=0 only)
CREATE VIEW IF NOT EXISTS active_opportunities AS
  SELECT * FROM opportunities WHERE archived = 0;

-- declined_opportunities view — for Professionalization "do not re-suggest"
CREATE VIEW IF NOT EXISTS declined_opportunities AS
  SELECT * FROM opportunities
  WHERE status = 'rejected' AND archived = 1;

-- commitments — new table -----------------------------------
CREATE TABLE IF NOT EXISTS commitments (
  slug         TEXT    PRIMARY KEY,
  title        TEXT    NOT NULL,
  kind         TEXT    NOT NULL DEFAULT 'recurring'
                       CHECK (kind IN ('recurring','long_running')),
  status       TEXT    NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','paused','completed','archived')),
  start_date   TEXT,
  end_date     TEXT,                          -- nullable for open-ended commitments
  cadence      TEXT,                          -- free text: 'MWF', 'weekly', etc.
  description  TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  archived_at  TEXT,
  metadata     TEXT    DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_commitments_status ON commitments(status);
CREATE INDEX IF NOT EXISTS idx_commitments_kind   ON commitments(kind);
CREATE INDEX IF NOT EXISTS idx_commitments_start  ON commitments(start_date);

CREATE TRIGGER IF NOT EXISTS commitments_updated_at
  AFTER UPDATE ON commitments
  FOR EACH ROW BEGIN
    UPDATE commitments SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    WHERE slug = OLD.slug;
  END;

-- tasks — polymorphic parent --------------------------------
-- project_slug carried an inline REFERENCES (foreign key); SQLite ALTER TABLE
-- DROP COLUMN refuses a column used in a FK constraint, so the table is
-- recreated. Safe: D1 holds no task rows before Phase 3 populates it.
-- DROP TABLE also drops the old idx_tasks_project index automatically.
DROP TRIGGER IF EXISTS tasks_updated_at;
DROP TABLE IF EXISTS tasks;

CREATE TABLE tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT    UNIQUE NOT NULL,
  title        TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','in_progress','completed','cancelled')),
  parent_kind  TEXT    CHECK (parent_kind IN ('project','commitment')),
  parent_id    TEXT,                          -- slug of parent project/commitment (app-level FK)
  description  TEXT,
  due_date     TEXT,
  priority     INTEGER NOT NULL DEFAULT 3
                       CHECK (priority BETWEEN 1 AND 4),
  completed_at TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  metadata     TEXT    DEFAULT '{}'
);

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
