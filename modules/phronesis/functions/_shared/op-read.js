/**
 * _shared/op-read.js — read-path handlers for the O&P D1 API (Phase 1).
 *
 * GET endpoints only. Write handlers (POST/PATCH/DELETE) land in Phase 4.
 * Spec: specs/op-d1-migration.md §IV.
 *
 * `table` and `keyCol` arguments are always hard-coded by the route file
 * (never request input) so they are safe to interpolate into SQL.
 */

import { authenticateRequest, checkScope, AuthError } from './auth.js';
import { errorResponse, listResponse, itemResponse, parseListQuery } from './api.js';
import { TABLES, buildListQuery } from './query.js';

/**
 * Authenticates a request and checks route scope. Returns { auth } on success
 * or { error: Response } on failure — the caller returns error.error directly.
 */
export async function authGate(request, env, routePrefix) {
  let auth;
  try {
    auth = await authenticateRequest(request, env);
  } catch (err) {
    if (err instanceof AuthError) {
      return { error: errorResponse(401, 'UNAUTHORIZED', err.message) };
    }
    throw err;
  }
  if (!checkScope(auth, routePrefix)) {
    return { error: errorResponse(403, 'FORBIDDEN', `No scope for ${routePrefix}`) };
  }
  return { auth };
}

export function requireDb(env) {
  if (!env.OP_DB) {
    return errorResponse(503, 'DB_UNAVAILABLE', 'OP_DB binding not configured');
  }
  return null;
}

/** GET /api/<table> — filtered, sorted, paginated list. */
export async function handleList(request, env, table, routePrefix) {
  const gate = await authGate(request, env, routePrefix);
  if (gate.error) return gate.error;
  const dbErr = requireDb(env);
  if (dbErr) return dbErr;

  const q = parseListQuery(new URL(request.url));
  const { whereClause, orderClause, filterBindings, limit, offset } = buildListQuery(table, q);

  try {
    const rows = await env.OP_DB.prepare(
      `SELECT * FROM ${table} ${whereClause} ${orderClause} LIMIT ? OFFSET ?`,
    ).bind(...filterBindings, limit, offset).all();

    const countRow = await env.OP_DB.prepare(
      `SELECT COUNT(*) AS n FROM ${table} ${whereClause}`,
    ).bind(...filterBindings).first();

    return listResponse(rows.results, countRow ? countRow.n : 0, limit, offset);
  } catch (err) {
    console.error(`list ${table} error:`, err);
    return errorResponse(500, 'DB_ERROR', err.message);
  }
}

/** GET /api/<table>/:key — single row by primary/unique key. */
export async function handleGetByKey(request, env, table, routePrefix, keyCol, keyVal) {
  const gate = await authGate(request, env, routePrefix);
  if (gate.error) return gate.error;
  const dbErr = requireDb(env);
  if (dbErr) return dbErr;

  try {
    const row = await env.OP_DB.prepare(
      `SELECT * FROM ${table} WHERE ${keyCol} = ?`,
    ).bind(keyVal).first();

    if (!row) {
      return errorResponse(404, 'NOT_FOUND', `${table} '${keyVal}' not found`);
    }
    return itemResponse(row);
  } catch (err) {
    console.error(`get ${table} error:`, err);
    return errorResponse(500, 'DB_ERROR', err.message);
  }
}

/** GET /api/projects/:slug — project with embedded non-cancelled tasks (§IV.5). */
export async function handleGetProject(request, env, slug) {
  const gate = await authGate(request, env, '/api/projects');
  if (gate.error) return gate.error;
  const dbErr = requireDb(env);
  if (dbErr) return dbErr;

  try {
    const project = await env.OP_DB.prepare(
      'SELECT * FROM projects WHERE slug = ?',
    ).bind(slug).first();

    if (!project) {
      return errorResponse(404, 'NOT_FOUND', `Project '${slug}' not found`);
    }

    const tasks = await env.OP_DB.prepare(
      `SELECT * FROM tasks
       WHERE parent_kind = 'project' AND parent_id = ? AND status != 'cancelled'
       ORDER BY priority ASC, due_date ASC`,
    ).bind(slug).all();

    return itemResponse({ ...project, tasks: tasks.results });
  } catch (err) {
    console.error('get project error:', err);
    return errorResponse(500, 'DB_ERROR', err.message);
  }
}

/** GET /api/commitments/:slug — commitment with embedded non-cancelled tasks. */
export async function handleGetCommitment(request, env, slug) {
  const gate = await authGate(request, env, '/api/commitments');
  if (gate.error) return gate.error;
  const dbErr = requireDb(env);
  if (dbErr) return dbErr;

  try {
    const commitment = await env.OP_DB.prepare(
      'SELECT * FROM commitments WHERE slug = ?',
    ).bind(slug).first();

    if (!commitment) {
      return errorResponse(404, 'NOT_FOUND', `Commitment '${slug}' not found`);
    }

    const tasks = await env.OP_DB.prepare(
      `SELECT * FROM tasks
       WHERE parent_kind = 'commitment' AND parent_id = ? AND status != 'cancelled'
       ORDER BY priority ASC, due_date ASC`,
    ).bind(slug).all();

    return itemResponse({ ...commitment, tasks: tasks.results });
  } catch (err) {
    console.error('get commitment error:', err);
    return errorResponse(500, 'DB_ERROR', err.message);
  }
}

/** GET /api/audit/since/:timestamp — audit rows newer than an ISO 8601 ts (§IV.10). */
export async function handleAuditSince(request, env, timestamp) {
  const gate = await authGate(request, env, '/api/audit');
  if (gate.error) return gate.error;
  const dbErr = requireDb(env);
  if (dbErr) return dbErr;

  if (!timestamp || isNaN(Date.parse(timestamp))) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid timestamp — use ISO 8601');
  }

  try {
    const rows = await env.OP_DB.prepare(
      'SELECT * FROM audit_log WHERE ts > ? ORDER BY ts ASC LIMIT 500',
    ).bind(timestamp).all();

    return new Response(
      JSON.stringify({ data: rows.results, since: timestamp, count: rows.results.length }),
      { headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    );
  } catch (err) {
    console.error('audit since error:', err);
    return errorResponse(500, 'DB_ERROR', err.message);
  }
}

/** GET /api/audit/table/:table — all audit rows for one table name. */
export async function handleAuditTable(request, env, tableName) {
  const gate = await authGate(request, env, '/api/audit');
  if (gate.error) return gate.error;
  const dbErr = requireDb(env);
  if (dbErr) return dbErr;

  if (!TABLES[tableName]) {
    return errorResponse(400, 'VALIDATION_ERROR', `Unknown table '${tableName}'`);
  }

  try {
    const rows = await env.OP_DB.prepare(
      'SELECT * FROM audit_log WHERE table_name = ? ORDER BY ts DESC LIMIT 500',
    ).bind(tableName).all();

    return new Response(
      JSON.stringify({ data: rows.results, table: tableName, count: rows.results.length }),
      { headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    );
  } catch (err) {
    console.error('audit table error:', err);
    return errorResponse(500, 'DB_ERROR', err.message);
  }
}

/* GET /api/audit/digest?since=<iso> — categorised changes for a planning
 * sweep. Tasks completed are surfaced with their completed_at so the
 * planner can credit progress; status flips, creations, deletions are
 * broken out per table. Falls back to a 7-day window if `since` is
 * omitted. Re-uses the /api/audit scope. */
export async function handleAuditDigest(request, env) {
  const gate = await authGate(request, env, '/api/audit');
  if (gate.error) return gate.error;
  const dbErr = requireDb(env);
  if (dbErr) return dbErr;

  const url = new URL(request.url);
  const sinceParam = url.searchParams.get('since');
  let since;
  if (sinceParam) {
    if (isNaN(Date.parse(sinceParam))) {
      return errorResponse(400, 'VALIDATION_ERROR', 'Invalid since — use ISO 8601');
    }
    since = sinceParam;
  } else {
    /* Default window: last 7 days. */
    since = new Date(Date.now() - 7 * 86400e3).toISOString();
  }
  const generated = new Date().toISOString();

  /* Audit rows newer than `since`. LIMIT 5001 to detect truncation. */
  let rowsResult;
  try {
    rowsResult = await env.OP_DB.prepare(
      'SELECT id, ts, table_name, row_id, operation, actor, diff FROM audit_log '
      + 'WHERE ts > ? ORDER BY ts ASC LIMIT 5001',
    ).bind(since).all();
  } catch (err) {
    console.error('digest audit query error:', err);
    return errorResponse(500, 'DB_ERROR', err.message);
  }

  const allRows = rowsResult.results || [];
  const truncated = allRows.length > 5000;
  const rows = allRows.slice(0, 5000);

  /* Categorise events. */
  const events = {
    tasks_completed:        [],
    tasks_reopened:         [],
    tasks_created:          [],
    tasks_other_changes:    [],
    tasks_deleted:          [],
    projects_created:       [],
    projects_changed:       [],
    projects_deleted:       [],
    opportunities_created:  [],
    opportunities_changed:  [],
    opportunities_deleted:  [],
    commitments_created:    [],
    commitments_changed:    [],
    commitments_deleted:    [],
    inventory_created:      [],
    inventory_changed:      [],
    inventory_deleted:      [],
  };

  for (const r of rows) {
    let diff = {};
    try { diff = JSON.parse(r.diff || '{}'); } catch (_) { diff = {}; }
    const before = diff.before || {};
    const after  = diff.after  || {};
    const meta   = { id: r.row_id, ts: r.ts, actor: r.actor };
    const title  = after.title || after.name || before.title || before.name || '';

    if (r.operation === 'INSERT') {
      const entry = { ...meta, title, status: after.status };
      if (r.table_name === 'tasks') {
        events.tasks_created.push({
          ...entry,
          priority:    after.priority,
          due_date:    after.due_date || null,
          parent_kind: after.parent_kind || null,
          parent_id:   after.parent_id   || null,
        });
      } else if (r.table_name === 'projects')      events.projects_created.push(entry);
      else if (r.table_name === 'opportunities')   events.opportunities_created.push(entry);
      else if (r.table_name === 'commitments')     events.commitments_created.push(entry);
      else if (r.table_name === 'inventory')       events.inventory_created.push(entry);
    } else if (r.operation === 'DELETE') {
      const entry = { ...meta, title };
      if (r.table_name === 'tasks')                events.tasks_deleted.push(entry);
      else if (r.table_name === 'projects')        events.projects_deleted.push(entry);
      else if (r.table_name === 'opportunities')   events.opportunities_deleted.push(entry);
      else if (r.table_name === 'commitments')     events.commitments_deleted.push(entry);
      else if (r.table_name === 'inventory')       events.inventory_deleted.push(entry);
    } else if (r.operation === 'UPDATE') {
      const fromStatus = before.status;
      const toStatus   = after.status;
      if (r.table_name === 'tasks') {
        if (toStatus === 'completed' && fromStatus !== 'completed') {
          events.tasks_completed.push({
            ...meta, title,
            completed_at: after.completed_at || r.ts,
            parent_kind:  after.parent_kind || null,
            parent_id:    after.parent_id   || null,
            priority:     after.priority,
          });
        } else if (fromStatus === 'completed' && toStatus !== 'completed') {
          events.tasks_reopened.push({
            ...meta, title, after_status: toStatus,
          });
        } else {
          events.tasks_other_changes.push({
            ...meta, title, before_status: fromStatus, after_status: toStatus,
          });
        }
      } else {
        const entry = { ...meta, title, before_status: fromStatus, after_status: toStatus };
        if (r.table_name === 'projects')           events.projects_changed.push(entry);
        else if (r.table_name === 'opportunities') events.opportunities_changed.push(entry);
        else if (r.table_name === 'commitments')   events.commitments_changed.push(entry);
        else if (r.table_name === 'inventory')     events.inventory_changed.push(entry);
      }
    }
  }

  /* Lightweight current-state snapshot. Non-fatal if any query fails. */
  const state = {};
  try {
    const [openTasks, doneInWindow, activeProjects, openOpps] = await env.OP_DB.batch([
      env.OP_DB.prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE status IN ('open','in_progress')"),
      env.OP_DB.prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE status = 'completed' AND completed_at > ?"
      ).bind(since),
      env.OP_DB.prepare(
        "SELECT COUNT(*) AS n FROM projects WHERE status NOT IN ('archived','completed')"),
      env.OP_DB.prepare(
        "SELECT COUNT(*) AS n FROM opportunities WHERE archived = 0"),
    ]);
    state.open_tasks                 = openTasks.results[0].n;
    state.tasks_completed_in_window  = doneInWindow.results[0].n;
    state.active_projects            = activeProjects.results[0].n;
    state.open_opportunities         = openOpps.results[0].n;
  } catch (err) {
    state.error = 'state snapshot unavailable: ' + err.message;
  }

  const totals = {};
  for (const k of Object.keys(events)) totals[k] = events[k].length;

  return new Response(JSON.stringify({
    since,
    generated,
    audit_rows: rows.length,
    truncated,
    totals,
    state,
    events,
  }), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
