/**
 * GET /api/documents — list live documents with optional filters.
 *
 * Query params: team, content_type, since, until, tag, limit (default 50, max 200), offset (default 0).
 * Returns r2_key and metadata are excluded from list responses (spec §V.1).
 */

import { authenticateRequest, AuthError } from '../../_shared/auth.js';
import { jsonResponse, errorResponse } from '../../_shared/api.js';

function parseTags(raw) {
  try { return JSON.parse(raw || '[]'); } catch { return []; }
}

export async function onRequestGet(ctx) {
  const { request, env } = ctx;

  let auth;
  try {
    auth = await authenticateRequest(request, env);
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(401, err.message);
    throw err;
  }

  if (!env.DB) return errorResponse(503, 'DB binding not configured');

  const url = new URL(request.url);
  const p   = url.searchParams;

  const team         = p.get('team')         || null;
  const content_type = p.get('content_type') || null;
  const since        = p.get('since')        || null;
  const until        = p.get('until')        || null;
  const tag          = p.get('tag')          || null;
  const rawLimit     = parseInt(p.get('limit')  ?? '50',  10);
  const offset       = parseInt(p.get('offset') ?? '0',   10);
  const limit        = Number.isFinite(rawLimit) ? Math.min(rawLimit, 200) : 50;

  const conditions = ['1=1'];
  const bindings   = [];

  if (team)         { conditions.push('source_team = ?');    bindings.push(team); }
  if (content_type) { conditions.push('content_type = ?');   bindings.push(content_type); }
  if (since)        { conditions.push('created_at >= ?');    bindings.push(since); }
  if (until)        { conditions.push('created_at <= ?');    bindings.push(until); }
  if (tag)          {
    conditions.push('EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)');
    bindings.push(tag);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const dataSql  = `SELECT slug, title, source_team, source_actor, content_type, mime_type,
                           byte_size, created_at, tags
                    FROM live_documents ${where}
                    ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  const countSql = `SELECT COUNT(*) AS total FROM live_documents ${where}`;

  const [dataResult, countResult] = await env.DB.batch([
    env.DB.prepare(dataSql).bind(...bindings, limit, offset),
    env.DB.prepare(countSql).bind(...bindings),
  ]);

  const rows = dataResult.results.map((row) => ({
    ...row,
    tags: parseTags(row.tags),
  }));

  const total = (countResult.results[0]?.total) ?? 0;

  return jsonResponse({ data: rows, meta: { total, limit, offset } });
}
