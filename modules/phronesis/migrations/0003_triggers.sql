-- ============================================================
-- Triggers — auto-update updated_at
-- Sképtou / specs/op-d1-migration.md rev 2 §III.4
--
-- D1 supports AFTER UPDATE triggers. If a future D1 release drops
-- trigger support, the Worker must set updated_at explicitly on
-- every PATCH (see spec §III.4 note).
-- ============================================================

CREATE TRIGGER IF NOT EXISTS projects_updated_at
  AFTER UPDATE ON projects
  FOR EACH ROW BEGIN
    UPDATE projects SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    WHERE slug = OLD.slug;
  END;

CREATE TRIGGER IF NOT EXISTS opportunities_updated_at
  AFTER UPDATE ON opportunities
  FOR EACH ROW BEGIN
    UPDATE opportunities SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    WHERE slug = OLD.slug;
  END;

CREATE TRIGGER IF NOT EXISTS tasks_updated_at
  AFTER UPDATE ON tasks
  FOR EACH ROW BEGIN
    UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    WHERE id = OLD.id;
  END;

CREATE TRIGGER IF NOT EXISTS inventory_updated_at
  AFTER UPDATE ON inventory
  FOR EACH ROW BEGIN
    UPDATE inventory SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    WHERE slug = OLD.slug;
  END;
