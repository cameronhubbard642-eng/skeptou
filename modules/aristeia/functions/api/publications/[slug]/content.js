/**
 * GET /api/publications/:slug/content — stream PDF from R2
 *
 * Query params:
 *   version=<id>  — stream a historical snapshot (import_history.id)
 *                   omit to stream the current canonical PDF
 *
 * Auth: any valid session or dev mode.
 * Response: PDF stream with Content-Disposition: inline
 */

import { validateSession } from '../../../_shared/auth.js';

export async function onRequestGet(ctx) {
  const { env, request, params } = ctx;

  const auth = await validateSession(request, env);
  if (!auth.authenticated) return new Response(null, { status: 401 });

  if (!env.DB)          return new Response(null, { status: 503 });
  if (!env.ARISTEIA_R2) return new Response(null, { status: 503 });

  const slug      = params.slug;
  const url       = new URL(request.url);
  const versionId = url.searchParams.get('version') || null;

  try {
    let r2Key;

    if (versionId) {
      const hist = await env.DB.prepare(
        'SELECT r2_history_key FROM import_history WHERE id = ? AND slug = ?'
      ).bind(parseInt(versionId, 10), slug).first();
      if (!hist) return new Response(null, { status: 404 });
      r2Key = hist.r2_history_key;
    } else {
      const pub = await env.DB.prepare(
        'SELECT r2_key FROM live_publications WHERE slug = ?'
      ).bind(slug).first();
      if (!pub) return new Response(null, { status: 404 });
      r2Key = pub.r2_key;
    }

    const object = await env.ARISTEIA_R2.get(r2Key);
    if (!object) return new Response(null, { status: 404 });

    return new Response(object.body, {
      headers: {
        'Content-Type':              'application/pdf',
        'Content-Disposition':       `inline; filename="${slug}.pdf"`,
        'X-Content-Type-Options':    'nosniff',
        'Cache-Control':             'private, no-store',
      },
    });

  } catch (err) {
    console.error(`GET /api/publications/${slug}/content error:`, err);
    return new Response(null, { status: 500 });
  }
}
