/**
 * POST /api/energeia/compile-draft/:slug/:direction — on-demand draft compile
 *
 * Dispatches compile-draft.yml on the agora repo.
 * Does NOT promote — just compiles the current state of the dunamis branch.
 *
 * Env: AGORA_DISPATCH_PAT, AGORA_REPO, HMAC_SECRET, AUTH_DOMAIN
 */

import { requireSession } from '../../../../_shared/auth.js';

export async function onRequestPost(ctx) {
  const { env, params, request } = ctx;

  const authRedirect = await requireSession(request, env);
  if (authRedirect) return authRedirect;

  const slug      = params.slug;
  const direction = params.direction;

  if (!slug      || !/^[a-z0-9-]+$/.test(slug))  return jsonResponse({ error: 'Invalid slug' }, 400);
  if (!direction || !/^[a-z]+$/.test(direction))  return jsonResponse({ error: 'Invalid direction name' }, 400);

  const branch = `dunamis/${slug}-${direction}`;

  try {
    await dispatchWorkflow(env.AGORA_DISPATCH_PAT, env.AGORA_REPO,
      'compile-draft.yml',
      { branch, slug });

    return jsonResponse({
      status: 'dispatched',
      slug,
      direction,
      branch,
      message: `Draft compile dispatched for ${branch}. PDF will be committed to the branch when ready.`
    }, 202);

  } catch (err) {
    console.error('Compile-draft error:', err);
    return jsonResponse({ error: 'Internal error', detail: err.message }, 500);
  }
}

async function dispatchWorkflow(pat, repo, workflow, inputs, ref = 'main') {
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

