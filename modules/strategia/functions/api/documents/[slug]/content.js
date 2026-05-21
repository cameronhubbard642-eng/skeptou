/**
 * GET /api/documents/:slug/content — stream R2 object bytes to browser.
 *
 * Content-Disposition: inline  → browser renders, not downloads.
 * Cache-Control: private, no-store  → no CDN caching of sensitive bytes.
 */

import { authenticateRequest, AuthError } from '../../../../_shared/auth.js';
import { errorResponse } from '../../../../_shared/api.js';

const MIME_TO_EXT = {
  'application/pdf': 'pdf',
  'text/markdown':   'md',
  'text/plain':      'txt',
  'image/png':       'png',
  'image/jpeg':      'jpg',
  'image/webp':      'webp',
};

export async function onRequestGet(ctx) {
  const { request, env, params } = ctx;

  try {
    await authenticateRequest(request, env);
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(401, err.message);
    throw err;
  }

  if (!env.STRATEGIA_DB)  return errorResponse(503, 'DB binding not configured');
  if (!env.STRATEGIA_R2)  return errorResponse(503, 'R2 binding not configured');

  const slug = params.slug;
  if (!slug || !/^[a-z0-9][a-z0-9-]{2,127}$/.test(slug)) {
    return errorResponse(400, 'invalid slug');
  }

  const row = await env.STRATEGIA_DB.prepare(
    'SELECT mime_type, r2_key FROM live_documents WHERE slug = ?'
  ).bind(slug).first();

  if (!row) return errorResponse(404, 'not found');

  const object = await env.STRATEGIA_R2.get(row.r2_key);
  if (!object) return errorResponse(404, 'storage object missing');

  const ext = MIME_TO_EXT[row.mime_type] ?? row.r2_key.split('.').pop() ?? 'bin';

  return new Response(object.body, {
    headers: {
      'Content-Type':           row.mime_type,
      'Content-Disposition':    `inline; filename="${slug}.${ext}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control':          'private, no-store',
    },
  });
}
