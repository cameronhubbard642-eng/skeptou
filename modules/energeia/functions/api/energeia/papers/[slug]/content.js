/**
 * GET /api/energeia/papers/[slug]/content
 *
 * Streams the canonical PDF for a paper from R2 storage.
 * Supports optional ?version=<tag> query param to retrieve a specific compiled version.
 *
 * Auth:
 *   - Bearer service token (scope: 'aristeia' or 'internal-read')
 *   - Cloudflare Access session (Cam)
 *   Unauthenticated → 401. Wrong scope → 403.
 *
 * Query params:
 *   - version (optional): version tag string (e.g., 'v1.3'). Omit for latest canonical.
 *
 * R2 key patterns:
 *   - Latest canonical: papers/<slug>/canonical.pdf
 *   - Tagged version: papers/<slug>/<version>/main.pdf
 *
 * Env: ENERGEIA_R2 (R2 bucket binding), AUTH_DB (D1 for service token validation)
 */

import { authenticateRequest } from '../../../../_shared/auth.js';

const VALID_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const VALID_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export async function onRequestGet(ctx) {
  const { env, params, request } = ctx;
  const { slug } = params;

  /* Validate slug */
  if (!slug || !VALID_SLUG.test(slug)) {
    return jsonError('Invalid slug', 400);
  }

  /* Authenticate */
  const auth = await authenticateRequest(request, env);
  if (!auth.authenticated) {
    return new Response(null, { status: 401 });
  }

  /* Check scope for service tokens */
  if (auth.mode === 'service_token') {
    const allowedScopes = ['aristeia', 'internal-read'];
    if (!allowedScopes.includes(auth.scope)) {
      return new Response(null, { status: 403 });
    }
  }

  /* Parse optional version param */
  const url = new URL(request.url);
  const version = url.searchParams.get('version');
  if (version && !VALID_VERSION.test(version)) {
    return jsonError('Invalid version tag', 400);
  }

  /* Check R2 binding */
  if (!env.ENERGEIA_R2) {
    return jsonError('R2 storage not configured (missing ENERGEIA_R2)', 503);
  }

  /* Construct R2 key and fetch */
  let r2Key;
  if (version) {
    r2Key = `papers/${slug}/${version}/main.pdf`;
  } else {
    r2Key = `papers/${slug}/canonical.pdf`;
  }

  try {
    const object = await env.ENERGEIA_R2.get(r2Key);
    if (!object) {
      const reason = version
        ? `PDF not found for version "${version}".`
        : 'Canonical PDF not found for this paper.';
      return jsonError(reason, 404);
    }

    return new Response(object.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${slug}.pdf"`,
        'Cache-Control': 'private, no-store',
        'X-Energeia-Version': version ?? 'canonical',
        'X-Energeia-Slug': slug,
        'X-Content-Type-Options': 'nosniff',
      },
    });

  } catch (err) {
    console.error('R2 fetch error:', slug, version, err);
    return jsonError(`R2 error: ${err.message}`, 502);
  }
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
