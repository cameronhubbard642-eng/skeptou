/**
 * GET /api/publications — list live publications
 *
 * Query params:
 *   status   — filter by publications.status
 *   limit    — max results (default 50, max 200)
 *   offset   — pagination offset (default 0)
 *
 * Auth: any valid session or dev mode.
 * Response: { data: [...summary rows], meta: { total, limit, offset } }
 */

import { validateSession } from '../../_shared/auth.js';

export async function onRequestGet(ctx) {
  const { env, request } = ctx;

  const auth = await validateSession(request, env);
  if (!auth.authenticated) return jsonResponse({ error: 'Unauthorized' }, 401);

  if (!env.ARISTEIA_DB) return jsonResponse({ error: 'Database not configured' }, 503);

  const url    = new URL(request.url);
  const status = url.searchParams.get('status') || null;
  const limit  = Math.min(parseInt(url.searchParams.get('limit')  || '50',  10), 200);
  const offset = Math.max(parseInt(url.searchParams.get('offset') || '0',   10), 0);

  try {
    /* Count query */
    let countSql  = 'SELECT COUNT(*) AS n FROM live_publications';
    const countParams = [];
    if (status) {
      countSql += ' WHERE status = ?';
      countParams.push(status);
    }

    /* Data query — summary fields only (r2_key, notes, deleted_at excluded) */
    let dataSql = `
      SELECT slug, title, authors, status, current_version, byte_size, imported_at,
             json_extract(citation, '$.journal') AS citation_journal,
             json_extract(citation, '$.year')    AS citation_year,
             json_extract(citation, '$.doi')     AS citation_doi
      FROM live_publications
    `;
    const dataParams = [];
    if (status) {
      dataSql += ' WHERE status = ?';
      dataParams.push(status);
    }
    dataSql += ' ORDER BY imported_at DESC LIMIT ? OFFSET ?';
    dataParams.push(limit, offset);

    const [countResult, dataResult] = await Promise.all([
      env.ARISTEIA_DB.prepare(countSql).bind(...countParams).first(),
      env.ARISTEIA_DB.prepare(dataSql).bind(...dataParams).all(),
    ]);

    const rows = (dataResult.results || []).map(function(row) {
      let authors = [];
      try { authors = JSON.parse(row.authors || '[]'); } catch (_) {}
      const citation = {};
      if (row.citation_journal) citation.journal = row.citation_journal;
      if (row.citation_year)    citation.year    = row.citation_year;
      if (row.citation_doi)     citation.doi     = row.citation_doi;
      return {
        slug:            row.slug,
        title:           row.title,
        authors,
        status:          row.status,
        current_version: row.current_version || null,
        byte_size:       row.byte_size,
        imported_at:     row.imported_at,
        citation,
      };
    });

    return jsonResponse({
      data: rows,
      meta: { total: countResult ? countResult.n : 0, limit, offset },
    });

  } catch (err) {
    console.error('GET /api/publications error:', err);
    return jsonResponse({ error: 'Internal error', detail: err.message }, 500);
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
