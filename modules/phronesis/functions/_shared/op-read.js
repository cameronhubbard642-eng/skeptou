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

function requireDb(env) {
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
      `SELECT * FROM tasks WHERE project_slug = ? AND status != 'cancelled'
       ORDER BY priority ASC, due_date ASC`,
    ).bind(slug).all();

    return itemResponse({ ...project, tasks: tasks.results });
  } catch (err) {
    console.error('get project error:', err);
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
