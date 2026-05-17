/**
 * GET /api/energeia/doc/:slug/:direction — download the Word (.docx) export
 *
 * Proxies papers/<slug>/main.docx from the dunamis/<slug>-<direction> branch of
 * the private agora repo through to authenticated browser sessions.
 *
 * compile-word.yml commits main.docx to the dunamis branch; until it has run
 * this returns 404, or 422 with the recorded error if the last run failed.
 *
 * Auth: energeia HMAC session cookie (validateSession).
 * Env:  AGORA_DISPATCH_PAT, AGORA_REPO, HMAC_SECRET
 */

import { validateSession } from '../../../../_shared/auth.js';

const VALID_SLUG      = /^[a-z0-9][a-z0-9-]*$/;
const VALID_DIRECTION = /^[a-z]+$/;

export async function onRequestGet(ctx) {
  const { env, params, request } = ctx;

  const auth = await validateSession(request, env);
  if (!auth.authenticated) return jsonError('Unauthorized — no active session', 401);

  const { slug, direction } = params;
  if (!VALID_SLUG.test(slug))           return jsonError('Invalid slug', 400);
  if (!VALID_DIRECTION.test(direction)) return jsonError('Invalid direction', 400);

  if (!env.AGORA_DISPATCH_PAT || !env.AGORA_REPO) {
    return jsonError('Doc proxy not configured (missing AGORA_DISPATCH_PAT or AGORA_REPO)', 503);
  }

  const ghRef = `dunamis/${slug}-${direction}`;

  try {
    const docBytes = await fetchGitHubFile(
      env.AGORA_DISPATCH_PAT, env.AGORA_REPO, `papers/${slug}/main.docx`, ghRef);

    if (docBytes === null) {
      /* No .docx — surface the last compile-word failure if one was recorded. */
      const statusBytes = await fetchGitHubFile(
        env.AGORA_DISPATCH_PAT, env.AGORA_REPO, `papers/${slug}/word-status.json`, ghRef);
      if (statusBytes !== null) {
        try {
          const status = JSON.parse(new TextDecoder().decode(statusBytes));
          if (status && status.ok === false) {
            return new Response(JSON.stringify({
              error:      'Word compile failed',
              detail:     status.error || 'See the compile run log.',
              compiledAt: status.compiledAt || null,
              runUrl:     status.runUrl || null,
            }), { status: 422, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
          }
        } catch { /* unparseable — fall through */ }
      }
      return jsonError('Word document not found — run "Word" on the branch first.', 404);
    }

    return new Response(docBytes, {
      status: 200,
      headers: {
        'Content-Type':           'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition':    `attachment; filename="${slug}-${direction}.docx"`,
        'Cache-Control':          'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });

  } catch (err) {
    console.error('Doc proxy error:', slug, direction, err);
    return jsonError(`GitHub API error: ${err.message}`, 502);
  }
}

/**
 * Fetch a single file from a private GitHub repo.
 * Returns Uint8Array on success, null on 404, throws on other errors.
 */
async function fetchGitHubFile(pat, repo, path, ref) {
  const url = `https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${pat}`,
      'Accept':        'application/vnd.github.v3+json',
      'User-Agent':    'energeia-skeptou/1.0',
    },
  });

  if (resp.status === 404) return null;
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`GitHub ${resp.status} for ${path}@${ref}: ${detail.slice(0, 200)}`);
  }

  const meta = await resp.json();

  if (meta.content) {
    const b64 = meta.content.replace(/[\n\r]/g, '');
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  }
  if (meta.download_url) {
    const dl = await fetch(meta.download_url, { headers: { 'Authorization': `Bearer ${pat}` } });
    if (!dl.ok) throw new Error(`Download failed: ${dl.status}`);
    return new Uint8Array(await dl.arrayBuffer());
  }
  throw new Error(`No content and no download_url for ${path}@${ref}`);
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
