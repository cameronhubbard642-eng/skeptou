# specs/op-d1-migration.md — O&P D1 Migration

**Version:** rev 3  
**Status:** draft — engineer-ready; all decisions resolved  
**Revised:** 2026-05-14 (rev 2 → rev 3: commitments table added; opportunities recast as queue; tasks parent_kind/parent_id polymorphic; accept/reject Worker flows updated; declined_opportunities view; commitments API routes)  
**Author:** Lead Dev / Architect — Sképtou  
**Date:** 2026-05-14  
**Supersedes:** `specs/runtime-fetch-cache.md` (for phronesis structured data only)  
**Consumers:** Phronesis engineer, DevOps engineer, O&P specialists (role-brief update)  
**Depends on:** `specs/auth-core.md`, `specs/phronesis.md`, `ARCHITECTURE.md`

---

## §I — Problem + motivation

### §I.1 — Why not runtime-fetch-cache

The runtime-fetch-cache spec (`specs/runtime-fetch-cache.md`, now superseded) proposed serving O&P data from agora git via GitHub Contents API with CF Cache. That approach has a structural limitation: agora git is a document store, not a relational data store. O&P structured data (projects, opportunities, tasks) has relational dependencies (tasks → projects, opportunities ↔ projects), filtering needs (status, due date, priority), and write patterns (specialists updating fields, Cam completing tasks from the UI) that git is not designed to serve.

Migrating to **Cloudflare D1** solves this cleanly:

- Fast filtered queries without GitHub API round-trips
- Atomic row-level writes from both the phronesis UI and O&P specialist agents
- Foreign-key relationships enforceable at the schema level
- Full queryable audit history (via `audit_log` table)
- Parallel agora-git audit trail (JSONL append) for Cam's `git log` workflow

### §I.2 — Scope boundary

| Layer | Storage | Edit path |
|---|---|---|
| Structured O&P data (projects, opportunities, tasks, inventory) | **D1** (`skeptou-op`) | Phronesis UI + O&P specialist API calls |
| Documents (papers, working notes, drafts) | **agora git** (unchanged) | Obsidian / Scrivener / Overleaf |
| Compiled PDFs | agora git (R2 deferred) | LaTeX workflows |
| energeia data (slugs, versions) | agora git (unchanged) | Managed by energeia spec |

This spec concerns the first row only. The agora-git workflow for documents is not changed by this migration.

---

## §II — Architecture overview

```
Phronesis UI (browser)
  │  credentials: session cookie
  │
  ▼
Phronesis Worker: /api/*
  │  auth: requireAuth() [session] OR validateServiceToken() [Bearer]
  │
  └─► D1 (skeptou-op) — read/write structured O&P data


O&P Specialist (Cowork sandbox)
  │  curl -H "Authorization: Bearer <svc-token>" https://phronesis.skeptou.com/api/...
  │
  ▼
Phronesis Worker /api/* ──► D1 + audit JSONL (same path as UI writes)
```

D1 is the single source of truth for current state. The D1 `audit_log` table records all changes; Cloudflare Time Travel provides 30-day point-in-time restore. No agora git dual-write.

---

## §III — D1 schema

### §III.1 — Migration files

Location: `modules/phronesis/migrations/`

Filename convention: `0001_initial_schema.sql`, `0002_indexes.sql`, ... Applied in order by `wrangler d1 migrations apply`.

### §III.2 — `0001_initial_schema.sql`

```sql
-- ============================================================
-- O&P data tables — skeptou-op D1 database
-- Sképtou / specs/op-d1-migration.md rev 1
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
  linked_opp_slug TEXT,                        -- NOT a DB FK (see §III.5)
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
  linked_project_slug TEXT,                   -- NOT a DB FK (see §III.5)
  decided_at      TEXT,
  accepted_at     TEXT,                        -- set on Accept; used to timestamp queue removal
  archived        INTEGER NOT NULL DEFAULT 0,  -- 1 = consumed (accepted/declined); excluded from active queue
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  metadata        TEXT    DEFAULT '{}'
);

-- active_opportunities view — the live decision queue (archived=0 only) -------
CREATE VIEW IF NOT EXISTS active_opportunities AS
  SELECT * FROM opportunities WHERE archived = 0;

-- declined_opportunities view — for Professionalization "do not re-suggest" ---
CREATE VIEW IF NOT EXISTS declined_opportunities AS
  SELECT * FROM opportunities
  WHERE status = 'rejected' AND archived = 1;

-- commitments -------------------------------------------------
CREATE TABLE IF NOT EXISTS commitments (
  slug            TEXT    PRIMARY KEY,
  title           TEXT    NOT NULL,
  kind            TEXT    NOT NULL DEFAULT 'recurring'
                          CHECK (kind IN ('recurring','long_running')),
  status          TEXT    NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','paused','completed','archived')),
  start_date      TEXT,
  end_date        TEXT,                        -- nullable for open-ended commitments
  cadence         TEXT,                        -- free text for recurring: 'MWF', 'weekly', etc.
  description     TEXT,
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
  parent_kind     TEXT    CHECK (parent_kind IN ('project','commitment')),
  parent_id       TEXT,                        -- slug of parent project or commitment (app-level FK; see §III.5)
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
```

### §III.3 — `0002_indexes.sql`

```sql
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
CREATE INDEX IF NOT EXISTS idx_tasks_parent       ON tasks(parent_kind, parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date     ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_priority     ON tasks(priority);

-- commitments
CREATE INDEX IF NOT EXISTS idx_commitments_status ON commitments(status);
CREATE INDEX IF NOT EXISTS idx_commitments_kind   ON commitments(kind);
CREATE INDEX IF NOT EXISTS idx_commitments_start  ON commitments(start_date);

-- opportunities (archived queue)
CREATE INDEX IF NOT EXISTS idx_opps_archived      ON opportunities(archived);

-- audit_log
CREATE INDEX IF NOT EXISTS idx_audit_ts           ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_table        ON audit_log(table_name);
CREATE INDEX IF NOT EXISTS idx_audit_actor        ON audit_log(actor);

-- service_tokens
CREATE INDEX IF NOT EXISTS idx_svc_role           ON service_tokens(role_slug);
```

### §III.4 — `0003_triggers.sql` — auto-update `updated_at`

D1 does not support stored procedure triggers in the same way full SQLite does, but basic `AFTER UPDATE` triggers are supported:

```sql
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

CREATE TRIGGER IF NOT EXISTS commitments_updated_at
  AFTER UPDATE ON commitments
  FOR EACH ROW BEGIN
    UPDATE commitments SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    WHERE slug = OLD.slug;
  END;
```

> **D1 trigger compatibility:** As of early 2026, D1 supports `AFTER UPDATE` triggers. Verify against current Cloudflare D1 release notes before applying. If triggers are unsupported, the Worker sets `updated_at` explicitly on every PATCH.

### §III.5 — Circular FK note

`projects.linked_opp_slug` and `opportunities.linked_project_slug` form a bidirectional reference. SQLite/D1 cannot represent a circular FK without deferrable constraints (which D1 does not expose). These two columns carry **no DB-level FK enforcement** — referential integrity is enforced by the Worker at write time (§IV.4, §IV.8). The Worker validates that the referenced slug exists before writing.

`tasks.parent_kind` + `tasks.parent_id` is a **polymorphic** parent reference — it points to either `projects.slug` or `commitments.slug` depending on `parent_kind`. SQLite cannot enforce a polymorphic FK at the DB level; the Worker validates the referenced parent exists before writing (same app-level enforcement pattern as the circular project↔opportunity reference).

### §III.6 — Wrangler D1 binding

```toml
# modules/phronesis/wrangler.toml (excerpt)

[[d1_databases]]
binding      = "OP_DB"
database_name = "skeptou-op"
database_id  = "<output of: wrangler d1 create skeptou-op>"
```

Local development: `wrangler d1 execute skeptou-op --local --file=migrations/0001_initial_schema.sql` etc.

---

## §IV — API surface

### §IV.1 — Route table

All routes are on `phronesis.skeptou.com`. Auth is required on every route (§V).

**Projects**

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/projects` | List projects. Filters: `status`, `area`, `priority`. Sort: `due`, `priority`, `created`, `updated`. |
| `GET` | `/api/projects/:slug` | Single project + related tasks (embedded). |
| `POST` | `/api/projects` | Create project. |
| `PATCH` | `/api/projects/:slug` | Update project fields (partial). |
| `DELETE` | `/api/projects/:slug` | Soft-delete: sets `archived_at`, `status='archived'`. |

**Opportunities** — active queue only (`archived = 0`) by default

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/opportunities` | List active queue (`archived=0`). Filters: `opp_type`, `priority`, `prestige_min`. Pass `?include_archived=1` to include consumed items. Sort: `deadline`, `priority`, `prestige`. |
| `GET` | `/api/opportunities/:slug` | Single opportunity (any state). |
| `POST` | `/api/opportunities` | Add to queue. |
| `PATCH` | `/api/opportunities/:slug` | Update pending fields. |
| `POST` | `/api/opportunities/:slug/accept` | Accept: archive opp + create project + create SAA planning task in one batch. |
| `POST` | `/api/opportunities/:slug/reject` | Decline: archive opp + record `decided_at`. Opportunity surfaces in `declined_opportunities` view for Professionalization "do not re-suggest" reads. |

**Tasks**

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/tasks` | List tasks. Filters: `status`, `parent_kind`, `parent_id`, `priority`. Omit `parent_kind`/`parent_id` for unified all-tasks view. Sort: `due`, `priority`. |
| `GET` | `/api/tasks/:id` | Single task. |
| `POST` | `/api/tasks` | Create task. |
| `PATCH` | `/api/tasks/:id` | Update fields. |
| `DELETE` | `/api/tasks/:id` | Soft-delete: sets `status='cancelled'`. |
| `POST` | `/api/tasks/complete/:id` | Mark task completed. Sets `status='completed'`, `completed_at=now`. |

**Inventory**

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/inventory` | List. Filters: `status`, `category`. |
| `GET` | `/api/inventory/:slug` | Single item. |
| `POST` | `/api/inventory` | Create. |
| `PATCH` | `/api/inventory/:slug` | Update. |
| `DELETE` | `/api/inventory/:slug` | Soft-delete: sets `status='retired'`. |

**Commitments**

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/commitments` | List. Filters: `status`, `kind`. |
| `GET` | `/api/commitments/:slug` | Single commitment + related tasks (embedded). |
| `POST` | `/api/commitments` | Create. |
| `PATCH` | `/api/commitments/:slug` | Update. |
| `DELETE` | `/api/commitments/:slug` | Soft-delete: sets `archived_at`, `status='archived'`. |

**Audit**

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/audit/since/:timestamp` | Return `audit_log` rows with `ts > :timestamp`. ISO 8601 timestamp in path. Used by specialists on activation. |
| `GET` | `/api/audit/table/:table` | All audit rows for a given table name. |

### §IV.2 — Query parameter parsing

```typescript
// modules/phronesis/src/lib/query-params.ts

export interface ListQuery {
  status?: string;
  area?: string;
  priority?: number;
  prestige_min?: number;
  parent_kind?: 'project' | 'commitment';
  parent_id?: string;
  include_archived?: boolean;   // opportunities only
  sort?: 'due' | 'priority' | 'created' | 'updated' | 'deadline' | 'prestige';
  order?: 'asc' | 'desc';
  limit?: number;   // default 100, max 200
  offset?: number;
}

export function parseListQuery(url: URL): ListQuery {
  const p = url.searchParams;
  return {
    status:      p.get('status')      ?? undefined,
    area:        p.get('area')        ?? undefined,
    priority:    p.has('priority')    ? Number(p.get('priority'))    : undefined,
    prestige_min: p.has('prestige_min') ? Number(p.get('prestige_min')) : undefined,
    parent_kind:  (p.get('parent_kind') ?? undefined) as ListQuery['parent_kind'],
    parent_id:    p.get('parent_id')   ?? undefined,
    include_archived: p.get('include_archived') === '1',
    sort:        (p.get('sort')       ?? 'updated') as ListQuery['sort'],
    order:       (p.get('order')      ?? 'desc')    as 'asc' | 'desc',
    limit:       Math.min(p.has('limit') ? Number(p.get('limit')) : 100, 200),
    offset:      p.has('offset')      ? Number(p.get('offset'))      : 0,
  };
}
```

### §IV.3 — Dynamic WHERE builder

```typescript
// modules/phronesis/src/lib/query-builder.ts

export function buildProjectsQuery(q: ListQuery): { sql: string; bindings: unknown[] } {
  const where: string[] = [];
  const bindings: unknown[] = [];

  if (q.status)       { where.push('status = ?');   bindings.push(q.status); }
  if (q.area)         { where.push('area = ?');      bindings.push(q.area); }
  if (q.priority)     { where.push('priority <= ?'); bindings.push(q.priority); }

  // Exclude permanently archived unless status=archived explicitly requested
  if (!q.status) { where.push("status != 'archived'"); }

  const sortCol = {
    due: 'due_date', priority: 'priority',
    created: 'created_at', updated: 'updated_at',
  }[q.sort ?? 'updated'] ?? 'updated_at';

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `
    SELECT * FROM projects
    ${whereClause}
    ORDER BY ${sortCol} ${(q.order ?? 'desc').toUpperCase()}
    LIMIT ? OFFSET ?
  `;
  bindings.push(q.limit ?? 100, q.offset ?? 0);

  return { sql, bindings };
}
```

Equivalent builders for `buildOpportunitiesQuery`, `buildTasksQuery`, `buildInventoryQuery` follow the same pattern.

### §IV.4 — Response envelopes

**List response:**

```typescript
interface ListResponse<T> {
  data: T[];
  total: number;    // total rows matching filter (for pagination)
  limit: number;
  offset: number;
}
```

**Single-item response:**

```typescript
interface ItemResponse<T> {
  data: T;
}
```

**Error response (all 4xx/5xx):**

```typescript
interface ErrorResponse {
  error: string;     // human-readable
  code: string;      // machine-readable: 'NOT_FOUND', 'VALIDATION_ERROR', 'CONFLICT', etc.
}
```

### §IV.5 — `GET /api/projects/:slug` — with embedded tasks

```typescript
async function getProject(slug: string, env: Env): Promise<Response> {
  const project = await env.OP_DB.prepare(
    'SELECT * FROM projects WHERE slug = ?'
  ).bind(slug).first();

  if (!project) return errorResponse(404, 'NOT_FOUND', `Project '${slug}' not found`);

  const tasks = await env.OP_DB.prepare(
    `SELECT * FROM tasks
     WHERE parent_kind = 'project' AND parent_id = ? AND status != 'cancelled'
     ORDER BY priority ASC, due_date ASC`
  ).bind(slug).all();

  return Response.json({ data: { ...project, tasks: tasks.results } });
}
```

### §IV.6 — `POST /api/projects` — create with validation

```typescript
const PROJECT_SCHEMA = {
  required: ['slug', 'title'],
  optional: ['status', 'area', 'description', 'due_date', 'priority', 'linked_opp_slug', 'metadata'],
  enums: {
    status: ['active', 'paused', 'completed', 'archived'],
    area: ['research', 'teaching', 'service', 'administrative', 'personal'],
  },
};

async function createProject(body: unknown, actor: string, env: Env): Promise<Response> {
  const validated = validateBody(body, PROJECT_SCHEMA);
  if (!validated.ok) return errorResponse(400, 'VALIDATION_ERROR', validated.error);

  const { slug, title, status, area, description, due_date, priority,
          linked_opp_slug, metadata } = validated.data;

  // App-level FK check for linked_opp_slug (see §III.5)
  if (linked_opp_slug) {
    const opp = await env.OP_DB.prepare(
      'SELECT slug FROM opportunities WHERE slug = ?'
    ).bind(linked_opp_slug).first();
    if (!opp) return errorResponse(400, 'VALIDATION_ERROR',
      `linked_opp_slug '${linked_opp_slug}' does not exist`);
  }

  const existing = await env.OP_DB.prepare(
    'SELECT slug FROM projects WHERE slug = ?'
  ).bind(slug).first();
  if (existing) return errorResponse(409, 'CONFLICT', `Slug '${slug}' already exists`);

  const before = null;
  const after = { slug, title, status: status ?? 'active', area, description,
                  due_date, priority: priority ?? 3, linked_opp_slug,
                  metadata: metadata ?? '{}' };

  await env.OP_DB.batch([
    env.OP_DB.prepare(
      `INSERT INTO projects (slug, title, status, area, description, due_date, priority,
                            linked_opp_slug, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(slug, title, status ?? 'active', area ?? null, description ?? null,
           due_date ?? null, priority ?? 3, linked_opp_slug ?? null,
           metadata ?? '{}'),
    auditInsert(env, 'projects', slug, 'INSERT', actor, before, after),
  ]);

  const created = await env.OP_DB.prepare(
    'SELECT * FROM projects WHERE slug = ?'
  ).bind(slug).first();
  return Response.json({ data: created }, { status: 201 });
}
```

### §IV.7 — `PATCH /api/projects/:slug` — partial update

```typescript
async function patchProject(slug: string, body: unknown, actor: string, env: Env): Promise<Response> {
  const before = await env.OP_DB.prepare(
    'SELECT * FROM projects WHERE slug = ?'
  ).bind(slug).first() as Record<string, unknown> | null;

  if (!before) return errorResponse(404, 'NOT_FOUND', `Project '${slug}' not found`);

  const allowed = ['title', 'status', 'area', 'description', 'due_date',
                   'priority', 'linked_opp_slug', 'metadata'];
  const updates = filterAllowedFields(body, allowed);

  if (Object.keys(updates).length === 0) {
    return errorResponse(400, 'VALIDATION_ERROR', 'No valid fields to update');
  }

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(updates), slug];
  const after = { ...before, ...updates };

  await env.OP_DB.batch([
    env.OP_DB.prepare(
      `UPDATE projects SET ${setClauses} WHERE slug = ?`
    ).bind(...values),
    auditInsert(env, 'projects', slug, 'UPDATE', actor, before, after),
  ]);

  const updated = await env.OP_DB.prepare(
    'SELECT * FROM projects WHERE slug = ?'
  ).bind(slug).first();
  return Response.json({ data: updated });
}
```

### §IV.8 — `POST /api/opportunities/:slug/accept`

Accepts an opportunity. **Always** archives the opportunity and creates a linked project. Additionally creates a planning-spec task for the SAA specialist. All three writes are batched atomically.

```typescript
interface AcceptBody {
  project_slug:  string;   // required — slug for the new project
  project_title: string;   // required — title for the new project
  project_area?: string;
}

async function acceptOpportunity(slug: string, body: AcceptBody, actor: string, env: Env): Promise<Response> {
  if (!body.project_slug || !body.project_title) {
    return errorResponse(400, 'VALIDATION_ERROR', 'project_slug and project_title are required');
  }

  const opp = await env.OP_DB.prepare(
    'SELECT * FROM opportunities WHERE slug = ?'
  ).bind(slug).first() as Record<string, unknown> | null;

  if (!opp) return errorResponse(404, 'NOT_FOUND', `Opportunity '${slug}' not found`);
  if (opp.archived === 1) {
    return errorResponse(409, 'CONFLICT', `Opportunity '${slug}' has already been consumed`);
  }

  const now = new Date().toISOString();
  const taskSlug = `task-planning-spec-${body.project_slug}`;

  const afterOpp  = { ...opp, status: 'accepted', decided_at: now, accepted_at: now, archived: 1,
                      linked_project_slug: body.project_slug };
  const afterProj = { slug: body.project_slug, title: body.project_title,
                      status: 'active', area: body.project_area ?? null, linked_opp_slug: slug };
  const afterTask = { slug: taskSlug, title: `Write planning spec for: ${body.project_title}`,
                      parent_kind: 'project', parent_id: body.project_slug,
                      status: 'open', priority: 2 };

  await env.OP_DB.batch([
    // 1. Archive opportunity (remove from active queue)
    env.OP_DB.prepare(
      `UPDATE opportunities
       SET status='accepted', decided_at=?, accepted_at=?, archived=1,
           linked_project_slug=?
       WHERE slug=?`
    ).bind(now, now, body.project_slug, slug),
    auditInsert(env, 'opportunities', slug, 'UPDATE', actor, opp, afterOpp),

    // 2. Create project
    env.OP_DB.prepare(
      `INSERT INTO projects (slug, title, status, area, linked_opp_slug)
       VALUES (?, ?, 'active', ?, ?)`
    ).bind(body.project_slug, body.project_title, body.project_area ?? null, slug),
    auditInsert(env, 'projects', body.project_slug, 'INSERT', actor, null, afterProj),

    // 3. Create SAA planning-spec task (surfaces on SAA's next brief-on-activation)
    env.OP_DB.prepare(
      `INSERT INTO tasks (slug, title, parent_kind, parent_id, status, priority)
       VALUES (?, ?, 'project', ?, 'open', 2)`
    ).bind(taskSlug, `Write planning spec for: ${body.project_title}`, body.project_slug),
    auditInsert(env, 'tasks', taskSlug, 'INSERT', actor, null, afterTask),
  ]);

  const project = await env.OP_DB.prepare(
    'SELECT * FROM projects WHERE slug = ?'
  ).bind(body.project_slug).first();

  return Response.json({ data: { project, saa_task_slug: taskSlug } }, { status: 201 });
}
```

> **SAA dispatch pattern:** The planning-spec task (priority 2, `parent_kind='project'`) appears in `GET /api/tasks?status=open&priority=2` on the SAA specialist's next brief-on-activation. No separate notification mechanism is required — the audit log + task list serve as the handoff.

### §IV.9 — `POST /api/opportunities/:slug/reject`

Archives the opportunity and records `decided_at`. The opportunity row is preserved and surfaces in the `declined_opportunities` view, which the PM specialist reads on activation to avoid re-suggesting the same item.

```typescript
async function rejectOpportunity(slug: string, actor: string, env: Env): Promise<Response> {
  const opp = await env.OP_DB.prepare(
    'SELECT * FROM opportunities WHERE slug = ?'
  ).bind(slug).first() as Record<string, unknown> | null;

  if (!opp) return errorResponse(404, 'NOT_FOUND', `Opportunity '${slug}' not found`);
  if (opp.archived === 1) {
    return errorResponse(409, 'CONFLICT', `Opportunity '${slug}' has already been consumed`);
  }

  const now = new Date().toISOString();
  const afterOpp = { ...opp, status: 'rejected', decided_at: now, archived: 1 };

  await env.OP_DB.batch([
    env.OP_DB.prepare(
      `UPDATE opportunities SET status='rejected', decided_at=?, archived=1 WHERE slug=?`
    ).bind(now, slug),
    auditInsert(env, 'opportunities', slug, 'UPDATE', actor, opp, afterOpp),
  ]);

  return Response.json({ data: afterOpp });
}
```

> **PM specialist "do not re-suggest" pattern:** On brief-on-activation the PM specialist calls `GET /api/opportunities?include_archived=1&status=rejected` (or queries `declined_opportunities` view directly via `GET /api/audit/table/opportunities` filtered to `status=rejected`). Any slug in those results is excluded from future suggestions.

### §IV.10 — `POST /api/tasks/complete/:id`

Optimised for the UI checkbox flow — one round-trip, no field merge:

```typescript
async function completeTask(id: number, actor: string, env: Env): Promise<Response> {
  const before = await env.OP_DB.prepare(
    'SELECT * FROM tasks WHERE id = ?'
  ).bind(id).first() as Record<string, unknown> | null;

  if (!before) return errorResponse(404, 'NOT_FOUND', `Task ${id} not found`);
  if (before.status === 'completed') {
    return errorResponse(409, 'CONFLICT', 'Task is already completed');
  }

  const now = new Date().toISOString();
  const after = { ...before, status: 'completed', completed_at: now };

  await env.OP_DB.batch([
    env.OP_DB.prepare(
      `UPDATE tasks SET status='completed', completed_at=? WHERE id=?`
    ).bind(now, id),
    auditInsert(env, 'tasks', String(id), 'UPDATE', actor, before, after),
  ]);

  return Response.json({ data: after });
}
```

### §IV.11 — `GET /api/audit/since/:timestamp`

```typescript
async function auditSince(timestamp: string, env: Env): Promise<Response> {
  // Validate ISO 8601
  if (isNaN(Date.parse(timestamp))) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid timestamp format — use ISO 8601');
  }

  const rows = await env.OP_DB.prepare(
    `SELECT * FROM audit_log WHERE ts > ? ORDER BY ts ASC LIMIT 500`
  ).bind(timestamp).all();

  return Response.json({
    data: rows.results,
    since: timestamp,
    count: rows.results.length,
  });
}
```

---

### §IV.12 — Commitments handlers

Commitments follow the same CRUD pattern as projects, with an additional embedded tasks fetch for the detail endpoint:

```typescript
// GET /api/commitments/:slug — with embedded tasks
async function getCommitment(slug: string, env: Env): Promise<Response> {
  const commitment = await env.OP_DB.prepare(
    'SELECT * FROM commitments WHERE slug = ?'
  ).bind(slug).first();

  if (!commitment) return errorResponse(404, 'NOT_FOUND', `Commitment '${slug}' not found`);

  const tasks = await env.OP_DB.prepare(
    `SELECT * FROM tasks
     WHERE parent_kind = 'commitment' AND parent_id = ? AND status != 'cancelled'
     ORDER BY priority ASC, due_date ASC`
  ).bind(slug).all();

  return Response.json({ data: { ...commitment, tasks: tasks.results } });
}
```

The `POST /api/commitments` and `PATCH /api/commitments/:slug` handlers follow the same validation + `auditInsert` batch pattern as projects (§IV.6–§IV.7). `DELETE /api/commitments/:slug` sets `archived_at` and `status='archived'`.

---

## §V — Authentication model

### §V.1 — Two auth paths

Every `/api/*` handler calls `authenticateRequest(request, env)` before any D1 access. This function returns `{ actor: string }` on success or throws `AuthError` (→ 401).

```typescript
// modules/phronesis/src/lib/auth.ts

export interface AuthContext {
  actor: string;    // 'cam' (session) or role slug (service token)
  mode: 'session' | 'service_token';
}

export async function authenticateRequest(request: Request, env: Env): Promise<AuthContext> {
  // Path 1: session cookie (phronesis UI)
  const cookieHeader = request.headers.get('Cookie');
  if (cookieHeader?.includes('__Host-session=')) {
    const session = await validateSession(request, env.AUTH_CONFIG);
    if (session) return { actor: 'cam', mode: 'session' };
  }

  // Path 2: Bearer service token (O&P specialists)
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const rawToken = authHeader.slice(7);
    const ctx = await validateServiceToken(rawToken, env);
    if (ctx) return ctx;
  }

  throw new AuthError('No valid session or service token');
}
```

### §V.2 — Service token validation

```typescript
async function validateServiceToken(
  rawToken: string,
  env: Env,
): Promise<AuthContext | null> {
  const hash = await sha256Hex(rawToken);

  const row = await env.OP_DB.prepare(
    `SELECT * FROM service_tokens WHERE token_hash = ? AND active = 1`
  ).bind(hash).first() as ServiceTokenRow | null;

  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;

  return { actor: row.role_slug, mode: 'service_token' };
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}
```

### §V.3 — Service token scope enforcement

The `service_tokens.scopes` column holds a JSON array of allowed route prefixes:

```json
["/api/projects", "/api/tasks", "/api/opportunities", "/api/inventory", "/api/audit"]
```

Check scope in the auth layer:

```typescript
export function checkScope(ctx: AuthContext, routePrefix: string): boolean {
  if (ctx.mode === 'session') return true;   // Cam session: full access
  const scopes: string[] = JSON.parse(ctx.scopes ?? '[]');
  return scopes.some(s => routePrefix.startsWith(s));
}
```

A scope of `/api/audit` grants read-only access to the audit endpoint. Scope `/api/tasks` grants read + write on tasks. If a specialist should be read-only across the board, scope them to `/api/audit` only — the route handlers check write permission:

```typescript
// In write handlers (POST, PATCH, DELETE):
if (ctx.mode === 'service_token' && !checkScope(ctx, '/api/projects/write')) {
  // Service tokens require explicit write scope
  return errorResponse(403, 'FORBIDDEN', 'Service token does not have write scope');
}
```

> Scope design is intentionally coarse-grained for now. Refine per-specialist if scope conflicts arise.

### §V.4 — Service token provisioning

Cam provisions tokens via Wrangler CLI (no admin UI required initially):

```bash
# Generate a token
TOKEN=$(openssl rand -hex 32)

# Compute hash
HASH=$(echo -n "$TOKEN" | sha256sum | awk '{print $1}')

# Insert into D1 (expires in 90 days)
wrangler d1 execute skeptou-op --command \
  "INSERT INTO service_tokens (token_hash, role_slug, scopes, expires_at) VALUES (
    '${HASH}',
    'pm-specialist',
    '[\"/api/projects\",\"/api/opportunities\",\"/api/tasks\",\"/api/audit\"]',
    datetime('now', '+90 days')
  );"

# Deliver TOKEN to the specialist role-brief (as a Worker secret or env var in the role)
```

The raw token value is never stored in D1. Only the SHA-256 hash is stored. Token delivery is manual (Cam pastes it into the specialist role-brief or sets it as a Cowork session variable).

---

## §VI — O&P specialist integration

### §VI.1 — Call pattern from Cowork sandbox

Specialists in Cowork sessions call the phronesis API via bash/curl. The service token is injected at session start via the role brief:

```bash
# Role brief sets this at activation:
export PHRONESIS_TOKEN="<token-value-from-provisioning>"
export PHRONESIS_API="https://phronesis.skeptou.com/api"

# Example: PM specialist lists active projects
curl -s \
  -H "Authorization: Bearer $PHRONESIS_TOKEN" \
  "$PHRONESIS_API/projects?status=active&sort=priority" \
  | jq '.data[] | {slug, title, status, due_date}'

# Create a task
curl -s -X POST \
  -H "Authorization: Bearer $PHRONESIS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"slug":"task-revise-intro","title":"Revise intro section","project_slug":"proj-dissertation","priority":2}' \
  "$PHRONESIS_API/tasks"

# Accept an opportunity and create linked project in one call
curl -s -X POST \
  -H "Authorization: Bearer $PHRONESIS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "create_project": true,
    "project_slug": "proj-apa-2026",
    "project_title": "APA 2026 Eastern Division Paper",
    "project_area": "research"
  }' \
  "$PHRONESIS_API/opportunities/opp-apa-2026-cfp/accept"
```

### §VI.2 — Brief-on-activation pattern

Each specialist calls `GET /api/audit/since/<last-session-ts>` at session start to catch up on changes since last active:

```bash
# In role brief activation hook:
LAST_TS=${PHRONESIS_LAST_SESSION_TS:-"2026-01-01T00:00:00Z"}

CHANGES=$(curl -s \
  -H "Authorization: Bearer $PHRONESIS_TOKEN" \
  "$PHRONESIS_API/audit/since/${LAST_TS}")

echo "$CHANGES" | jq -r '.data[] | "[\(.ts)] \(.actor) \(.operation) \(.table_name) \(.row_id)"'
```

After session closes, the specialist records `PHRONESIS_LAST_SESSION_TS` as the current ISO timestamp in its session memory.

### §VI.3 — Role-brief update scope

Each O&P role brief requires these updates (engineering deliverable, not a spec decision):

| Role | Current write pattern | Updated pattern |
|---|---|---|
| PM Specialist | Creates/updates `proj-*.md`, `opp-*.md` in agora | `POST /api/projects`, `PATCH /api/projects/:slug`, `POST /api/opportunities`, `PATCH /api/opportunities/:slug`, `POST /api/commitments`, `PATCH /api/commitments/:slug` |
| C&C Specialist | Updates project status, schedules follow-ups | `PATCH /api/projects/:slug`, `POST /api/tasks`, `PATCH /api/tasks/:id` |
| SAA Specialist | Reviews opportunities, Accept/Reject; writes planning specs | `POST /api/opportunities/:slug/accept`, `POST /api/opportunities/:slug/reject`, `POST /api/tasks` (planning-spec task updates) |
| Inventory Keeper | Manages inventory | `POST /api/inventory`, `PATCH /api/inventory/:slug` |
| Notetaker | No write access; reads for context; checks declined opps list | Read-only scope on `/api/audit`, `/api/opportunities` |

The role briefs are updated in Phase 3 of the cutover sequence (§IX Phase 3). Specialists continue using agora file writes until Phase 3 completes.

---

## §VII — Audit history

### §VII.1 — Audit layers

All audit data lives in the D1 `audit_log` table. No agora git dual-write.

| Mechanism | Role |
|---|---|
| `audit_log` D1 table | Queryable change history; specialist brief-on-activation; `SELECT * FROM audit_log WHERE ts > ?` |
| D1 Time Travel | 30-day point-in-time restore; no configuration required |
| Nightly D1 snapshot to agora (§XI.2) | Long-term backup; not a change-by-change audit trail |

### §VII.2 — `auditInsert` helper

```typescript
// modules/phronesis/src/lib/audit.ts

export function auditInsert(
  env: Env,
  table: string,
  rowId: string,
  op: 'INSERT' | 'UPDATE' | 'DELETE',
  actor: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): D1PreparedStatement {
  return env.OP_DB.prepare(
    `INSERT INTO audit_log (table_name, row_id, operation, actor, diff)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(
    table, rowId, op, actor,
    JSON.stringify({ before, after }),
  );
}
```

This is always called inside a `env.OP_DB.batch([...])` with the data write statement — they commit atomically.

## §VIII — Initial population

On D1 bind, dispatch the five O&P specialists (Portfolio Manager, Commitments & Calendar, Structured Approach Advisor, Inventory Keeper, Notetaker) to repopulate their content directly via the `/api/*` write surface. No vault-to-D1 migration script. Empty D1 → specialist writes → live state.

---

## §IX — Cutover sequence

Migration is six phases. Each phase is independently deployable and non-breaking until Phase 6.

### Phase 1 — D1 schema + Worker read endpoints

**Scope:** Schema applied, read-only `/api/*` endpoints live. D1 starts empty — specialists repopulate via API in Phase 3. UI continues reading from `dist/data/*.json`. Specialists continue using file writes until Phase 3.

**Deliverables:**
- Migration SQL files `0001`–`0003` applied via `wrangler d1 migrations apply`
- `modules/shared/lib/auth.ts` — `authenticateRequest` (§V.1)
- `modules/shared/lib/audit.ts` — `auditInsert` (§VII.2)
- `modules/phronesis/src/handlers/projects.ts` — GET endpoints only
- `modules/phronesis/src/handlers/opportunities.ts` — GET endpoints only
- `modules/phronesis/src/handlers/tasks.ts` — GET + `/complete/:id` read path only
- `modules/phronesis/src/handlers/inventory.ts` — GET endpoints only
- `modules/phronesis/src/handlers/audit.ts` — GET `/audit/since/:timestamp`

**Verification:** `curl` authenticated GET requests to all read endpoints return `200` with empty arrays (no data yet). Unauthenticated requests return `401`.

### Phase 2 — Phronesis UI reads from D1

**Scope:** UI switches from `dist/data/*.json` to `/api/*` endpoints. **Cam has unblocked Phase 2 — engineer can proceed immediately** (commitment-vs-opportunity architecture resolved; all schema questions settled). The `window.__INITIAL_DATA__` fallback (from superseded runtime-fetch-cache spec) is NOT needed here — D1 is always available; no GitHub API latency. Initial render can be a loading skeleton or skeleton state.

**Deliverables:**
- `modules/phronesis/src/app.js` — swap data fetch from static JSON to `/api/projects` etc.
- Loading skeleton components while API responds
- Remove `sync-vault.js` build step (no longer needed for phronesis UI)

**Verification:** Dashboard renders correct live data. Changes made directly in D1 via `wrangler d1 execute` appear in UI without redeploy.

### Phase 3 — O&P specialist role-brief updates + service token provisioning

**Scope:** Cam provisions service tokens (§V.4). Each role brief is updated to use API calls instead of agora file writes (§VI.3). Specialists transition to API-first workflow.

**Deliverables:**
- Service tokens provisioned for each active O&P specialist
- Role-brief updates for PM, C&C, SAA, Inventory Keeper, Notetaker (see §VI.3)
- Brief-on-activation `GET /api/audit/since/` pattern in each brief

**Verification:** Specialist session creates a test project row via API; row appears in phronesis UI and in D1 audit_log.

### Phase 4 — Worker write endpoints (UI-driven writes)

**Scope:** POST, PATCH, DELETE endpoints live. Phronesis UI can now create/update/complete items directly without going through agora. Task-complete checkbox calls `POST /api/tasks/complete/:id`.

**Deliverables:**
- All write handlers enabled for projects, opportunities, tasks, inventory
- `POST /api/opportunities/:slug/accept` and `/reject`
- UI components wired to write endpoints

**Verification:** Create project from UI → appears in D1. Complete task from UI → `completed_at` set, checkbox state persists across reload.

### Phase 5 — Cam confirms; markdown files deleted

**Scope:** Cam reviews D1 data against markdown source for accuracy, then gives explicit confirmation. On confirmation, markdown files are deleted from agora. D1 is the sole source of truth going forward. **Migration does not auto-proceed to deletion — explicit Cam sign-off is required (Q22: hybrid timing).**

**Deliverables:**
- Lead Dev presents D1 row counts + spot-check report to Cam for review
- Cam issues explicit confirmation (e.g. "proceed with deletion")
- `git rm O&P/projects/*.md O&P/opportunities/*.md O&P/tasks/*.md` (one commit — Q23: clean vault)
- D1 nightly backup job confirmed live (§XI.2)

**Verification:** Full end-to-end: create opp → accept → create project → add tasks → complete tasks — all in phronesis UI. Audit log confirms all steps. `git log` shows deletion commit. Nightly snapshot exists in `backups/op-snapshots/`.

---

## §X — DASHBOARD.md regression

> **Resolved 2026-05-14 — Option D (accept loss):** Cam decided to drop DASHBOARD.md entirely. No export job, no stub files, no launcher page. Phronesis UI replaces Obsidian as the O&P dashboard. The mitigation options below are retained for reference only; none will be implemented.

### §X.1 — Problem

Obsidian's DataviewJS plugin queries markdown frontmatter in vault files directly. After Phase 6, `proj-*.md` etc. no longer exist as live files — they are either archived stubs or deleted. Existing DASHBOARD.md DataviewJS queries break.

This is a known regression. Cam must choose a mitigation path before Phase 6 deploys.

### §X.2 — Option A — DASHBOARD.md becomes a launcher page

DASHBOARD.md retains its structure but DataviewJS blocks are replaced with a simple link:

```markdown
## Projects

→ [Phronesis Dashboard](https://phronesis.skeptou.com)

All project/task/opportunity state is now in Phronesis. Open the link above.
```

**Pros:** Zero maintenance, no sync lag, no stale data.  
**Cons:** Obsidian is no longer a direct window into O&P state. Requires opening a browser.

### §X.3 — Option B — Nightly JSON export → DataviewJS reads JSON

A Worker cron job runs nightly: exports D1 → `O&P/snapshots/latest.json` in agora. DataviewJS reads from this JSON file via Dataview's `dv.io.csv()` or a custom `dv.pages()` equivalent.

**Implementation note:** Native Dataview does not support reading raw JSON (only CSV via `dv.io.csv()`). Would require writing data as CSV, or using a DataviewJS block with `dv.io.load()` + `JSON.parse()`. This is technically viable but fragile — breaks if Dataview changes its API.

**Pros:** Preserves some Obsidian visibility into O&P state.  
**Cons:** Data is 0–24h stale; adds a cron job to maintain; DataviewJS workaround is brittle.

### §X.4 — Option C — Keep stub markdown files updated by export job

Export job (Worker cron, runs on every D1 write or nightly) regenerates `proj-*.md`, `opp-*.md`, `task-*.md` with frontmatter only — no prose body. Files are committed back to agora. DataviewJS continues to work unchanged.

```markdown
---
slug: proj-dissertation
title: "Dissertation"
status: active
area: research
due_date: 2027-05-01
priority: 1
_source: d1_export
_exported_at: 2026-05-14T08:00:00Z
---
<!-- auto-generated from D1 skeptou-op — do not edit -->
```

**Pros:** DataviewJS works without modification; Obsidian visibility preserved.  
**Cons:** Two representations of the same data (D1 rows + markdown stubs). Edit conflict possible if Cam edits a stub thinking it's live. Must document clearly that stubs are read-only exports. Adds export job maintenance.

### §X.5 — Option D — Accept loss

Remove DASHBOARD.md DataviewJS blocks. Phronesis UI replaces Obsidian dashboard entirely for O&P state.

**Pros:** Simplest; no ongoing maintenance.  
**Cons:** Removes Obsidian as a fallback/offline view of O&P state.

> **Cam-decision required (see §XIV Q1)** before Phase 6 can proceed.

---

## §XI — Backups

### §XI.1 — D1 Time Travel (primary)

Cloudflare D1 automatically retains point-in-time snapshots for 30 days at no extra cost. Restore via:

```bash
wrangler d1 time-travel restore skeptou-op \
  --timestamp="2026-05-10T12:00:00Z"
```

This is the primary recovery path for accidental deletes or data corruption. No configuration required.

### §XI.2 — Nightly D1 → JSON export to agora (secondary)

A Worker cron (`0 4 * * *` — 4am UTC) exports full D1 tables to JSON and commits to `backups/op-snapshots/YYYY-MM-DD.json` in agora:

```toml
# modules/phronesis/wrangler.toml
[triggers]
crons = ["0 4 * * *"]
```

```typescript
export async function scheduled(event: ScheduledEvent, env: Env): Promise<void> {
  const snapshot = {
    exported_at: new Date().toISOString(),
    projects:     (await env.OP_DB.prepare('SELECT * FROM projects').all()).results,
    opportunities:(await env.OP_DB.prepare('SELECT * FROM opportunities').all()).results,
    tasks:        (await env.OP_DB.prepare('SELECT * FROM tasks').all()).results,
    inventory:    (await env.OP_DB.prepare('SELECT * FROM inventory').all()).results,
  };

  const date = new Date().toISOString().slice(0, 10);
  const path = `backups/op-snapshots/${date}.json`;
  await commitFileToGit(env, path, JSON.stringify(snapshot, null, 2),
    `backup: nightly D1 export ${date}`);
}
```

---

## §XII — Security

### §XII.1 — Auth on all routes

Every request goes through `authenticateRequest()` (§V.1) before touching D1. No unauthenticated reads or writes. Auth failure → 401. Scope failure → 403.

### §XII.2 — Service token storage

Raw token is never stored. Only SHA-256 hash is in D1. Even a full D1 dump does not expose any usable token values. Tokens are revoked by setting `active=0` in the `service_tokens` table.

### §XII.3 — GitHub PAT scopes

One PAT needed across this spec: Cam's existing **classic PAT** (`contents: read` + `contents: write`), set as Worker secret `GITHUB_PAT`. Used by:
- Migration script (read — fetches markdown files from agora for bootstrap)
- Nightly D1 export job (write — commits snapshot to `backups/op-snapshots/` in agora)

No write PAT is needed for Worker API operations — audit dual-write was removed (Q21). No separate fine-grained PAT required (Q24).

### §XII.4 — Soft-delete pattern

`DELETE` endpoints set `archived_at` / `status='archived'` rather than physically deleting rows. Physical deletion requires a separate admin endpoint or direct `wrangler d1 execute`. This prevents accidental data loss from a mistaken DELETE call.

### §XII.5 — Input validation

All POST/PATCH bodies are validated against the schema before any D1 write (§IV.6 `validateBody`). Unknown fields are stripped (not rejected) to avoid breaking specialist calls when schema evolves.

---

## §XIII — Cost + scale

### §XIII.1 — D1 free tier

| Metric | Free tier limit | Expected usage |
|---|---|---|
| Rows | 5M rows / database | <10,000 rows (personal O&P) |
| Storage | 5GB | <100MB |
| Read operations | 25M / day | <5,000 / day |
| Write operations | 100K / day | <200 / day |

Verdict: Free tier is sufficient with multiple orders of magnitude of headroom.

### §XIII.2 — Workers compute

Each API call is one Worker invocation. Estimate:
- 200 page loads/day × 5 API calls each = 1,000
- 50 specialist API calls/day = 50
- 1 cron invocation/day = 1
- Total: ~1,051 / day vs. 100,000/day free tier limit

### §XIII.3 — GitHub Contents API (audit dual-write)

Each write operation triggers 2 GitHub API calls (GET file + PUT file). Estimate 200 writes/day × 2 = 400 calls/day vs. 5,000/hr limit. Negligible.

---

## §XIV — Open questions for Cam

| # | Question | Options | Blocks |
|---|---|---|---|
| 1 | **DASHBOARD.md impact** — which mitigation? | ~~A/B/C/D — **resolved 2026-05-14: Option D, accept loss; DASHBOARD.md dropped entirely**~~ | ~~Phase 6~~ |
| 2 | ~~Audit dual-write to agora git~~ | **Resolved 2026-05-14 — No. D1 `audit_log` + Time Travel only. No agora JSONL.** |
| 3 | ~~Migration timing~~ | **Resolved 2026-05-14 — Hybrid: run script + verify, then await explicit Cam confirmation before `git rm`. Not auto-retire.** |
| 4 | ~~Markdown file retention~~ | **Resolved 2026-05-14 — Delete (`git rm`). Clean vault.** |
| 5 | ~~Write PAT for agora~~ | **Resolved 2026-05-14 — Cam's existing classic PAT. No separate fine-grained PAT.** |
| 6 | ~~Service token TTL~~ | **Resolved 2026-05-14 — 90 days.** |
| 7 | ~~inventory.md format~~ | **Resolved 2026-05-14 — Empty at present. No migration parser needed. `inventory` table starts empty; populated via API.** |

---

## §XV — Out of scope

- Full-text search across project descriptions (SQLite FTS5 extension; deferred)
- Pagination beyond `LIMIT/OFFSET` (cursor-based pagination; unnecessary at personal scale)
- Multi-tenant access (Glossolalia or a second user on phronesis; deferred)
- Real-time notifications (WebSocket / SSE when a specialist updates a row; deferred)
- R2 for PDF binary storage (energeia PDF pipeline spec handles this separately)
- GraphQL API (REST per-table is sufficient)
- Versioned row history in D1 (full row versioning is covered by audit_log + JSONL)

---

## §XVI — Definition of done

**Phase 1:**
- [ ] Migration SQL applied; `wrangler d1 info skeptou-op` shows 5 tables + 2 views (`active_opportunities`, `declined_opportunities`)
- [ ] `inventory` table is empty (no migration needed — starts fresh)
- [ ] `commitments` table is empty (starts fresh — no source data)
- [ ] All GET endpoints return `200` with empty arrays (D1 starts empty; authenticated)
- [ ] `GET /api/opportunities` (no params) returns only `archived=0` rows
- [ ] Unauthenticated GET returns `401`
- [ ] `GET /api/audit/since/2026-01-01T00:00:00Z` returns empty array (no data yet from API writes)

**Phase 2:**
- [ ] Phronesis UI loads dashboard from D1 API with no static JSON fallback
- [ ] Direct D1 row edit via `wrangler d1 execute` appears in UI without redeploy

**Phase 3:**
- [ ] Service token provisioned for at least one O&P specialist
- [ ] Specialist session creates a test project row via `curl`; row visible in UI
- [ ] `GET /api/audit/since/` returns the test row creation event

**Phase 4:**
- [ ] Full CRUD cycle via phronesis UI for projects, commitments, tasks, inventory
- [ ] `POST /api/tasks/complete/:id` sets `completed_at`, persists across reload
- [ ] `POST /api/opportunities/:slug/accept`: opportunity archived + project created + SAA planning task created in one batch; `active_opportunities` count decreases by 1
- [ ] `POST /api/opportunities/:slug/reject`: opportunity archived; appears in `declined_opportunities` view; not in `active_opportunities`
- [ ] Task with `parent_kind='commitment'` surfaces on both unified Tasks tab and commitment detail page
- [ ] Unified `GET /api/tasks` (no parent filter) returns tasks from projects and commitments together


**Phase 5:**
- [ ] Lead Dev spot-check report presented to Cam: D1 row counts match markdown source for projects, opportunities, tasks
- [ ] Cam issues explicit confirmation to proceed with deletion
- [ ] `git rm O&P/projects/*.md O&P/opportunities/*.md O&P/tasks/*.md` committed to agora `main` (via PR)
- [ ] Nightly D1 export cron confirmed firing and committing to `backups/op-snapshots/`
- [ ] D1 Time Travel verified: restore to a 10-minute-old timestamp succeeds
