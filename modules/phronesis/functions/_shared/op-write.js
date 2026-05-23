/**
 * _shared/op-write.js — write-path handlers for the O&P D1 API (Phase 4).
 *
 * POST / PATCH / DELETE for projects, opportunities, tasks, inventory,
 * commitments, plus the opportunity accept/reject and task-complete flows.
 * Spec: specs/op-d1-migration.md rev 3 §IV.6–§IV.12.
 *
 * `table`, column names, and key columns are always hard-coded by the route
 * file (never request input) so they are safe to interpolate into SQL.
 * Request values are always passed as bound parameters.
 */

import { authGate, requireDb } from './op-read.js';
import { errorResponse, itemResponse } from './api.js';
import { auditInsert } from './audit.js';
import { validateBody, filterAllowedFields } from './validate.js';

/* Per-table write config. `create` is the validateBody schema; `patch` is the
 * PATCH allowlist; `softDelete` describes what a DELETE sets (absent → no
 * DELETE support, e.g. opportunities use accept/reject instead). */
const WRITE_CONFIG = {
  projects: {
    create: { required: ['slug', 'title'],
              optional: ['status', 'area', 'description', 'due_date', 'priority', 'linked_opp_slug', 'parent_id', 'metadata'] },
    patch: ['title', 'status', 'area', 'description', 'due_date', 'priority', 'linked_opp_slug', 'parent_id', 'metadata'],
    softDelete: { status: 'archived', archived_at: true },
  },
  opportunities: {
    create: { required: ['slug', 'title'],
              optional: ['status', 'opp_type', 'venue', 'description', 'deadline', 'priority', 'prestige', 'requirement', 'linked_project_slug', 'metadata'] },
    patch: ['title', 'status', 'opp_type', 'venue', 'description', 'deadline', 'priority', 'prestige', 'requirement', 'linked_project_slug', 'metadata'],
    /* no softDelete — consumed via accept/reject */
  },
  tasks: {
    create: { required: ['slug', 'title'],
              optional: ['status', 'parent_kind', 'parent_id', 'description', 'due_date', 'priority', 'metadata'] },
    patch: ['title', 'status', 'parent_kind', 'parent_id', 'description', 'due_date', 'priority', 'completed_at', 'metadata'],
    softDelete: { status: 'cancelled' },
  },
  inventory: {
    create: { required: ['slug', 'name'],
              optional: ['category', 'status', 'location', 'notes', 'acquired_at', 'expires_at', 'metadata'] },
    patch: ['name', 'category', 'status', 'location', 'notes', 'acquired_at', 'expires_at', 'metadata'],
    softDelete: { status: 'retired' },
  },
  commitments: {
    create: { required: ['slug', 'title'],
              optional: ['kind', 'status', 'start_date', 'end_date', 'cadence', 'description', 'metadata'] },
    patch: ['title', 'kind', 'status', 'start_date', 'end_date', 'cadence', 'description', 'metadata'],
    softDelete: { status: 'archived', archived_at: true },
  },
};

/* String-enum values mirroring the schema CHECK constraints. Numeric ranges
 * (priority 1-4, prestige 1-5) are left to the D1 CHECK constraints. */
const ENUMS = {
  projects:      { status: ['active', 'paused', 'completed', 'archived'],
                   area: ['research', 'teaching', 'service', 'administrative', 'personal'] },
  opportunities: { status: ['pending', 'accepted', 'rejected', 'deferred', 'expired'],
                   opp_type: ['job', 'fellowship', 'grant', 'cfp', 'invitation', 'conference', 'other'] },
  tasks:         { status: ['open', 'in_progress', 'completed', 'cancelled'],
                   parent_kind: ['project', 'commitment', 'task'] },
  inventory:     { category: ['hardware', 'software', 'subscription', 'reference', 'credential', 'other'],
                   status: ['active', 'retired', 'needed'] },
  commitments:   { kind: ['recurring', 'long_running'],
                   status: ['active', 'paused', 'completed', 'archived'] },
};

async function readBody(request) {
  try {
    return { ok: true, body: await request.json() };
  } catch (_) {
    return { ok: false };
  }
}

/* Maps a D1 write failure to a 400 (constraint violation — the common case
 * on a bad write) or a 500 (genuine backend error). */
function writeError(err) {
  const msg = String((err && err.message) || err);
  if (/constraint|CHECK|UNIQUE|NOT NULL|FOREIGN/i.test(msg)) {
    return errorResponse(400, 'CONSTRAINT', msg);
  }
  console.error('write error:', msg);
  return errorResponse(500, 'DB_ERROR', msg);
}

function checkEnums(table, data) {
  const enums = ENUMS[table] || {};
  for (const col of Object.keys(enums)) {
    const v = data[col];
    if (v !== undefined && v !== null && !enums[col].includes(v)) {
      return `Invalid ${col}: '${v}'`;
    }
  }
  return null;
}

async function refExists(env, table, slug) {
  const row = await env.OP_DB.prepare(
    `SELECT 1 AS ok FROM ${table} WHERE slug = ?`,
  ).bind(slug).first();
  return !!row;
}

/* Walks up the parent chain in `table` starting from `startSlug`, returning
 * true if `targetSlug` is reached. Bounded by MAX_DEPTH so a pre-existing
 * cycle in the data (shouldn't happen, but defensively) doesn't hang.
 * Used by the cycle guard when re-parenting tasks or projects. */
async function ancestorContains(env, table, startSlug, targetSlug) {
  const MAX_DEPTH = 100;
  let cur = startSlug;
  for (let i = 0; i < MAX_DEPTH; i++) {
    if (cur === targetSlug) return true;
    const row = await env.OP_DB.prepare(
      table === 'tasks'
        ? `SELECT parent_kind, parent_id FROM tasks WHERE slug = ?`
        : `SELECT parent_id FROM projects WHERE slug = ?`,
    ).bind(cur).first();
    if (!row) return false;
    if (table === 'tasks') {
      if (row.parent_kind !== 'task' || !row.parent_id) return false;
      cur = row.parent_id;
    } else {
      if (!row.parent_id) return false;
      cur = row.parent_id;
    }
  }
  return false; /* depth cap reached — treat as not-a-cycle */
}

/* App-level FK validation (§III.5): polymorphic task parent, the
 * project↔opportunity circular reference, and the task→task / project→project
 * nesting introduced in migration 0005 are not DB-enforced. `selfSlug` is the
 * slug of the row being written; needed for the cycle guard on nesting. */
async function checkRefs(env, table, data, selfSlug) {
  if (table === 'projects' && data.linked_opp_slug) {
    if (!(await refExists(env, 'opportunities', data.linked_opp_slug))) {
      return `linked_opp_slug '${data.linked_opp_slug}' does not exist`;
    }
  }
  if (table === 'opportunities' && data.linked_project_slug) {
    if (!(await refExists(env, 'projects', data.linked_project_slug))) {
      return `linked_project_slug '${data.linked_project_slug}' does not exist`;
    }
  }
  if (table === 'tasks' && data.parent_kind) {
    const parentTable = data.parent_kind === 'project'    ? 'projects'
                      : data.parent_kind === 'commitment' ? 'commitments'
                      : data.parent_kind === 'task'       ? 'tasks' : null;
    if (!parentTable) return `Invalid parent_kind '${data.parent_kind}'`;
    if (!data.parent_id) return 'parent_id is required when parent_kind is set';
    if (!(await refExists(env, parentTable, data.parent_id))) {
      return `parent_id '${data.parent_id}' not found in ${parentTable}`;
    }
    if (data.parent_kind === 'task' && selfSlug) {
      if (selfSlug === data.parent_id) return 'A task cannot be its own parent';
      if (await ancestorContains(env, 'tasks', data.parent_id, selfSlug)) {
        return 'Setting this parent would create a cycle';
      }
    }
  }
  if (table === 'projects' && data.parent_id !== undefined && data.parent_id !== null && data.parent_id !== '') {
    if (!(await refExists(env, 'projects', data.parent_id))) {
      return `parent_id '${data.parent_id}' not found in projects`;
    }
    if (selfSlug) {
      if (selfSlug === data.parent_id) return 'A project cannot be its own parent';
      if (await ancestorContains(env, 'projects', data.parent_id, selfSlug)) {
        return 'Setting this parent would create a cycle';
      }
    }
  }
  return null;
}

/* D1 columns are TEXT; a metadata object must be stored as a JSON string. */
function normaliseMetadata(obj) {
  if (obj.metadata !== undefined && obj.metadata !== null && typeof obj.metadata === 'object') {
    obj.metadata = JSON.stringify(obj.metadata);
  }
}

/* ── Generic CRUD ──────────────────────────────────────────────────────── */

/** POST /api/<table> — create a row. */
export async function handleCreate(request, env, table, routePrefix) {
  const gate = await authGate(request, env, routePrefix);
  if (gate.error) return gate.error;
  const dbErr = requireDb(env);
  if (dbErr) return dbErr;

  const cfg = WRITE_CONFIG[table];
  const rb = await readBody(request);
  if (!rb.ok) return errorResponse(400, 'VALIDATION_ERROR', 'Invalid or missing JSON body');

  const v = validateBody(rb.body, cfg.create);
  if (!v.ok) return errorResponse(400, 'VALIDATION_ERROR', v.error);
  const data = v.data;
  normaliseMetadata(data);

  const enumErr = checkEnums(table, data);
  if (enumErr) return errorResponse(400, 'VALIDATION_ERROR', enumErr);
  const fkErr = await checkRefs(env, table, data, data.slug);
  if (fkErr) return errorResponse(400, 'VALIDATION_ERROR', fkErr);

  const existing = await env.OP_DB.prepare(
    `SELECT slug FROM ${table} WHERE slug = ?`,
  ).bind(data.slug).first();
  if (existing) return errorResponse(409, 'CONFLICT', `Slug '${data.slug}' already exists`);

  const cols = Object.keys(data);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  try {
    await env.OP_DB.batch([
      env.OP_DB.prepare(sql).bind(...cols.map((c) => data[c])),
      auditInsert(env, table, data.slug, 'INSERT', gate.auth.actor, null, data),
    ]);
  } catch (err) {
    return writeError(err);
  }

  const created = await env.OP_DB.prepare(
    `SELECT * FROM ${table} WHERE slug = ?`,
  ).bind(data.slug).first();
  return itemResponse(created, 201);
}

/** PATCH /api/<table>/:key — partial update. */
export async function handlePatch(request, env, table, routePrefix, keyCol, keyVal) {
  const gate = await authGate(request, env, routePrefix);
  if (gate.error) return gate.error;
  const dbErr = requireDb(env);
  if (dbErr) return dbErr;

  const cfg = WRITE_CONFIG[table];
  const before = await env.OP_DB.prepare(
    `SELECT * FROM ${table} WHERE ${keyCol} = ?`,
  ).bind(keyVal).first();
  if (!before) return errorResponse(404, 'NOT_FOUND', `${table} '${keyVal}' not found`);

  const rb = await readBody(request);
  if (!rb.ok) return errorResponse(400, 'VALIDATION_ERROR', 'Invalid or missing JSON body');

  const updates = filterAllowedFields(rb.body, cfg.patch);
  if (Object.keys(updates).length === 0) {
    return errorResponse(400, 'VALIDATION_ERROR', 'No valid fields to update');
  }
  normaliseMetadata(updates);

  const enumErr = checkEnums(table, updates);
  if (enumErr) return errorResponse(400, 'VALIDATION_ERROR', enumErr);
  const fkErr = await checkRefs(env, table, updates, before.slug);
  if (fkErr) return errorResponse(400, 'VALIDATION_ERROR', fkErr);

  const setClauses = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
  const after = Object.assign({}, before, updates);
  const rowId = before.slug !== undefined ? before.slug : keyVal;
  try {
    await env.OP_DB.batch([
      env.OP_DB.prepare(
        `UPDATE ${table} SET ${setClauses} WHERE ${keyCol} = ?`,
      ).bind(...Object.values(updates), keyVal),
      auditInsert(env, table, rowId, 'UPDATE', gate.auth.actor, before, after),
    ]);
  } catch (err) {
    return writeError(err);
  }

  const updated = await env.OP_DB.prepare(
    `SELECT * FROM ${table} WHERE ${keyCol} = ?`,
  ).bind(keyVal).first();
  return itemResponse(updated);
}

/** DELETE /api/<table>/:key — soft-delete (sets status / archived_at). */
export async function handleSoftDelete(request, env, table, routePrefix, keyCol, keyVal) {
  const gate = await authGate(request, env, routePrefix);
  if (gate.error) return gate.error;
  const dbErr = requireDb(env);
  if (dbErr) return dbErr;

  const cfg = WRITE_CONFIG[table];
  if (!cfg.softDelete) {
    return errorResponse(405, 'METHOD_NOT_ALLOWED', `${table} does not support DELETE`);
  }

  const before = await env.OP_DB.prepare(
    `SELECT * FROM ${table} WHERE ${keyCol} = ?`,
  ).bind(keyVal).first();
  if (!before) return errorResponse(404, 'NOT_FOUND', `${table} '${keyVal}' not found`);

  const updates = {};
  if (cfg.softDelete.status) updates.status = cfg.softDelete.status;
  if (cfg.softDelete.archived_at) updates.archived_at = new Date().toISOString();

  const setClauses = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
  const after = Object.assign({}, before, updates);
  const rowId = before.slug !== undefined ? before.slug : keyVal;
  try {
    await env.OP_DB.batch([
      env.OP_DB.prepare(
        `UPDATE ${table} SET ${setClauses} WHERE ${keyCol} = ?`,
      ).bind(...Object.values(updates), keyVal),
      auditInsert(env, table, rowId, 'DELETE', gate.auth.actor, before, after),
    ]);
  } catch (err) {
    return writeError(err);
  }
  return itemResponse(after);
}

/* ── Special flows ─────────────────────────────────────────────────────── */

/** POST /api/opportunities/:slug/accept — archive opp + create project + SAA task (§IV.8). */
export async function handleAccept(request, env, slug) {
  const gate = await authGate(request, env, '/api/opportunities');
  if (gate.error) return gate.error;
  const dbErr = requireDb(env);
  if (dbErr) return dbErr;

  const rb = await readBody(request);
  const body = rb.ok && rb.body ? rb.body : {};
  if (!body.project_slug || !body.project_title) {
    return errorResponse(400, 'VALIDATION_ERROR', 'project_slug and project_title are required');
  }

  const opp = await env.OP_DB.prepare(
    'SELECT * FROM opportunities WHERE slug = ?',
  ).bind(slug).first();
  if (!opp) return errorResponse(404, 'NOT_FOUND', `Opportunity '${slug}' not found`);
  if (opp.archived === 1) {
    return errorResponse(409, 'CONFLICT', `Opportunity '${slug}' has already been consumed`);
  }

  const projExists = await env.OP_DB.prepare(
    'SELECT slug FROM projects WHERE slug = ?',
  ).bind(body.project_slug).first();
  if (projExists) return errorResponse(409, 'CONFLICT', `Project '${body.project_slug}' already exists`);

  const now = new Date().toISOString();
  const actor = gate.auth.actor;
  const taskSlug = `task-planning-spec-${body.project_slug}`;
  const taskTitle = `Write planning spec for: ${body.project_title}`;
  const afterOpp = Object.assign({}, opp, {
    status: 'accepted', decided_at: now, accepted_at: now, archived: 1,
    linked_project_slug: body.project_slug,
  });
  const afterProj = { slug: body.project_slug, title: body.project_title,
                      status: 'active', area: body.project_area || null, linked_opp_slug: slug };
  const afterTask = { slug: taskSlug, title: taskTitle, parent_kind: 'project',
                      parent_id: body.project_slug, status: 'open', priority: 2 };

  try {
    await env.OP_DB.batch([
      env.OP_DB.prepare(
        `UPDATE opportunities
         SET status='accepted', decided_at=?, accepted_at=?, archived=1, linked_project_slug=?
         WHERE slug=?`,
      ).bind(now, now, body.project_slug, slug),
      auditInsert(env, 'opportunities', slug, 'UPDATE', actor, opp, afterOpp),

      env.OP_DB.prepare(
        `INSERT INTO projects (slug, title, status, area, linked_opp_slug)
         VALUES (?, ?, 'active', ?, ?)`,
      ).bind(body.project_slug, body.project_title, body.project_area || null, slug),
      auditInsert(env, 'projects', body.project_slug, 'INSERT', actor, null, afterProj),

      env.OP_DB.prepare(
        `INSERT INTO tasks (slug, title, parent_kind, parent_id, status, priority)
         VALUES (?, ?, 'project', ?, 'open', 2)`,
      ).bind(taskSlug, taskTitle, body.project_slug),
      auditInsert(env, 'tasks', taskSlug, 'INSERT', actor, null, afterTask),
    ]);
  } catch (err) {
    return writeError(err);
  }

  const project = await env.OP_DB.prepare(
    'SELECT * FROM projects WHERE slug = ?',
  ).bind(body.project_slug).first();
  return new Response(
    JSON.stringify({ data: { project, saa_task_slug: taskSlug } }),
    { status: 201, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
  );
}

/** POST /api/opportunities/:slug/reject — archive opp, record decided_at (§IV.9). */
export async function handleReject(request, env, slug) {
  const gate = await authGate(request, env, '/api/opportunities');
  if (gate.error) return gate.error;
  const dbErr = requireDb(env);
  if (dbErr) return dbErr;

  const opp = await env.OP_DB.prepare(
    'SELECT * FROM opportunities WHERE slug = ?',
  ).bind(slug).first();
  if (!opp) return errorResponse(404, 'NOT_FOUND', `Opportunity '${slug}' not found`);
  if (opp.archived === 1) {
    return errorResponse(409, 'CONFLICT', `Opportunity '${slug}' has already been consumed`);
  }

  const now = new Date().toISOString();
  const after = Object.assign({}, opp, { status: 'rejected', decided_at: now, archived: 1 });
  try {
    await env.OP_DB.batch([
      env.OP_DB.prepare(
        `UPDATE opportunities SET status='rejected', decided_at=?, archived=1 WHERE slug=?`,
      ).bind(now, slug),
      auditInsert(env, 'opportunities', slug, 'UPDATE', gate.auth.actor, opp, after),
    ]);
  } catch (err) {
    return writeError(err);
  }
  return itemResponse(after);
}

/** POST /api/tasks/complete/:id — mark a task completed (§IV.10). */
export async function handleCompleteTask(request, env, id) {
  const gate = await authGate(request, env, '/api/tasks');
  if (gate.error) return gate.error;
  const dbErr = requireDb(env);
  if (dbErr) return dbErr;

  const before = await env.OP_DB.prepare(
    'SELECT * FROM tasks WHERE id = ?',
  ).bind(id).first();
  if (!before) return errorResponse(404, 'NOT_FOUND', `Task ${id} not found`);
  if (before.status === 'completed') {
    return errorResponse(409, 'CONFLICT', 'Task is already completed');
  }

  const now = new Date().toISOString();
  const after = Object.assign({}, before, { status: 'completed', completed_at: now });
  const rowId = before.slug !== undefined ? before.slug : id;
  try {
    await env.OP_DB.batch([
      env.OP_DB.prepare(
        `UPDATE tasks SET status='completed', completed_at=? WHERE id=?`,
      ).bind(now, id),
      auditInsert(env, 'tasks', rowId, 'UPDATE', gate.auth.actor, before, after),
    ]);
  } catch (err) {
    return writeError(err);
  }
  return itemResponse(after);
}
