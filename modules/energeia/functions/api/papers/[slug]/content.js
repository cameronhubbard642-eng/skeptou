/**
 * GET /api/papers/:slug/content — stream canonical paper PDF
 *
 * Fetches the compiled canonical PDF for a paper from papers/<slug>/main.pdf
 * on the energeia branch. Streams it as application/pdf.
 *
 * Auth: Requires either:
 *   - Valid session cookie (__skeptou_session) OR
 *   - Bearer token in Authorization header (service token for server-to-server calls)
 *
 * Returns:
 *   200 + binary PDF stream on success
 *   404 if paper not found (unpromoted or doesn't exist)
 *   401 if unauthorized
 *   500 on server error
 *
 * Env: AGORA_DISPATCH_PAT, AGORA_REPO, HMAC_SECRET, AUTH_DOMAIN
 */

import { validateSession } from '../../../_shared/auth.js';

export async function onRequestGet(ctx) {
  const { env, params, request } = ctx;

  const slug = params.slug;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return jsonResponse({ error: 'Invalid slug' }, 400);
  }

  /* Auth: session cookie or service token */
  const auth = await validateSession(request, env);
  if (!auth.authenticated) {
    const serviceAuth = validateServiceToken(request, env);
    if (!serviceAuth) {
      return jsonResponse({ error: 'Unauthorized — no active session or valid token' }, 401);
    }
  }

  if (!env.AGORA_DISPATCH_PAT || !env.AGORA_REPO) {
    return jsonResponse({ error: 'agora not configured' }, 503);
  }

  try {
    /* Fetch the compiled PDF from energeia branch */
    const pdfContent = await fetchPdfFromGitHub(
      env.AGORA_DISPATCH_PAT,
      env.AGORA_REPO,
      `papers/${slug}/main.pdf`
    );

    if (!pdfContent) {
      return jsonResponse(
        { error: 'Paper not found or not promoted', slug },
        404
      );
    }

    /* Return PDF as binary with proper Content-Type */
    return new Response(pdfContent, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${slug}.pdf"`,
        'Cache-Control': 'public, max-age=3600',
      },
    });

  } catch (err) {
    console.error(`PDF stream error for slug=${slug}:`, err);
    return jsonResponse({ error: 'Internal error', detail: err.message }, 500);
  }
}

/**
 * Fetch binary PDF from GitHub. Returns the ArrayBuffer if successful, null if 404.
 */
async function fetchPdfFromGitHub(pat, repo, filePath) {
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${repo}/contents/${filePath}?ref=energeia`,
      {
        headers: {
          'Authorization': `Bearer ${pat}`,
          'Accept': 'application/vnd.github.v3.raw',
          'User-Agent': 'energeia-skeptou'
        }
      }
    );

    if (resp.status === 404) return null;
    if (!resp.ok) {
      throw new Error(`GitHub fetch ${filePath}: ${resp.status} ${resp.statusText}`);
    }

    /* Get raw binary content */
    return await resp.arrayBuffer();

  } catch (err) {
    console.error(`fetchPdfFromGitHub error for ${filePath}:`, err);
    throw err;
  }
}

/**
 * Validate service token from Authorization header.
 * Placeholder: checks for a Bearer token matching a configured service token.
 * TODO: Implement proper service token validation once the token infrastructure
 * is defined (e.g., KV-backed tokens with scopes for aristeia/phero).
 */
function validateServiceToken(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;

  const token = authHeader.slice(7).trim();
  if (!token) return false;

  /* Placeholder: check against env.SERVICE_TOKEN (will be KV-based later) */
  return env.SERVICE_TOKEN && token === env.SERVICE_TOKEN;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
