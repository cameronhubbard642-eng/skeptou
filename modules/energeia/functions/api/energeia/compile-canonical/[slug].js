/**
 * POST /api/energeia/compile-canonical/:slug — manual canonical recompile
 *
 * Dispatches compile-canonical.yml on the agora repo for a single paper slug,
 * without requiring a push to the energeia branch.
 * Does NOT promote — compiles whatever is currently on the energeia branch.
 *
 * Env: AGORA_DISPATCH_PAT, AGORA_REPO, HMAC_SECRET, AUTH_DOMAIN
 */

import { validateSession } from '../../../../_shared/auth.js';

export async function onRequestPost(ctx) {
  const { env, params, request } = ctx;

  const auth = await validateSession(request, env);
  if (!auth.authenticated) return jsonResponse({ error: 'Unauthorized — no active session' }, 401);

  const slug = params.slug;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return jsonResponse({ error: 'Invalid slug' }, 400);

  if (!env.AGORA_DISPATCH_PAT || !env.AGORA_REPO) {
    return jsonResponse({ error: 'agora not configured' }, 503);
  }

  try {
    await dispatchWorkflow(env.AGORA_DISPATCH_PAT, env.AGORA_REPO,
      'compile-canonical.yml',
      { slug });

    return jsonResponse({
      status: 'dispatched',
      slug,
      message: `Canonical recompile dispatched for ${slug}. PDF will be committed to energeia when ready.`
    }, 202);

  } catch (err) {
    console.error('Compile-canonical error:', err);
    return jsonResponse({ error: 'Internal error', detail: err.message }, 500);
  }
}

async function dispatchWorkflow(pat, repo, workflow, inputs, ref = 'energeia') {
  const resp = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'energeia-skeptou'
      },
      body: JSON.stringify({ ref, inputs })
    }
  );
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Dispatch ${workflow}: ${resp.status} — ${detail}`);
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
