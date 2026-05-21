/**
 * GET /api/documents/:slug — full metadata for one live document.
 * Returns r2_key and metadata (included; list endpoint omits them).
 */

import { authenticateRequest, AuthError } from '../../../_shared/auth.js';
import { jsonResponse, errorResponse } from '../../../_shared/api.js';

function parseJson(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

export async function onRequestGet(ctx) {
  const { request, env, params } = ctx;

  let auth;
  try {
    auth = await authenticateRequest(request, env);
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(401, err.message);
    throw err;
  }

  if (!env.DB) return errorResponse(503, 'DB binding not configured');

  const slug = params.slug;
  if (!slug || !/^[a-z0-9][a-z0-9-]{2,127}$/.test(slug)) {
    return errorResponse(400, 'invalid slug');
  }

  const row = await env.DB.prepare(
    'SELECT * FROM live_documents WHERE slug = ?'
  ).bind(slug).first();

  if (!row) return errorResponse(404, 'not found');

  return jsonResponse({
    slug:         row.slug,
    title:        row.title,
    source_team:  row.source_team,
    source_actor: row.source_actor,
    content_type: row.content_type,
    mime_type:    row.mime_type,
    r2_key:       row.r2_key,
    byte_size:    row.byte_size,
    created_at:   row.created_at,
    tags:         parseJson(row.tags, []),
    metadata:     parseJson(row.metadata, {}),
  });
}
