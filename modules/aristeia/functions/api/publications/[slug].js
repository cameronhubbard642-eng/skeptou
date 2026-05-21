/**
 * GET /api/publications/:slug — full publication metadata + import history
 *
 * Auth: any valid session or dev mode.
 * Response: { data: { ...full row, import_history: [...] } }
 */

import { validateSession } from '../../_shared/auth.js';

export async function onRequestGet(ctx) {
  const { env, request, params } = ctx;

  const auth = await validateSession(request, env);
  if (!auth.authenticated) return jsonResponse({ error: 'Unauthorized' }, 401);

  if (!env.ARISTEIA_DB) return jsonResponse({ error: 'Database not configured' }, 503);

  const slug = params.slug;
  if (!slug) return jsonResponse({ error: 'Missing slug' }, 400);

  try {
    const row = await env.ARISTEIA_DB.prepare(
      'SELECT slug, title, authors, status, current_version, r2_key, byte_size, citation, notes, imported_at FROM live_publications WHERE slug = ?'
    ).bind(slug).first();

    if (!row) return jsonResponse({ error: 'Not found' }, 404);

    /* Import history ordered newest-first; r2_history_key not returned to client */
    const histResult = await env.ARISTEIA_DB.prepare(
      'SELECT id, version_tag, imported_at, byte_size FROM import_history WHERE slug = ? ORDER BY imported_at DESC'
    ).bind(slug).all();

    let authors = [];
    try { authors = JSON.parse(row.authors || '[]'); } catch (_) {}
    let citation = {};
    try { citation = JSON.parse(row.citation || '{}'); } catch (_) {}

    return jsonResponse({
      data: {
        slug:            row.slug,
        title:           row.title,
        authors,
        status:          row.status,
        current_version: row.current_version || null,
        r2_key:          row.r2_key,
        byte_size:       row.byte_size,
        citation,
        notes:           row.notes || '',
        imported_at:     row.imported_at,
        import_history:  histResult.results || [],
      },
    });

  } catch (err) {
    console.error(`GET /api/publications/${slug} error:`, err);
    return jsonResponse({ error: 'Internal error', detail: err.message }, 500);
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
