/**
 * POST /api/energeia/compile-word/:slug/:direction — on-demand Word (.docx) compile
 *
 * Dispatches compile-word.yml on the agora repo: renders the dunamis branch's
 * paper to ODT via tex4ht (make4ht) and converts it to .docx with pandoc.
 * The .docx is committed to the dunamis branch as papers/<slug>/main.docx.
 * Does NOT promote.
 *
 * Env: AGORA_DISPATCH_PAT, AGORA_REPO, HMAC_SECRET, AUTH_DOMAIN
 */

import { validateSession } from '../../../../_shared/auth.js';

export async function onRequestPost(ctx) {
  const { env, params, request } = ctx;

  const auth = await validateSession(request, env);
  if (!auth.authenticated) return jsonResponse({ error: 'Unauthorized — no active session' }, 401);

  const slug      = params.slug;
  const direction = params.direction;

  if (!slug      || !/^[a-z0-9-]+$/.test(slug))   return jsonResponse({ error: 'Invalid slug' }, 400);
  if (!direction || !/^[a-z]+$/.test(direction))  return jsonResponse({ error: 'Invalid direction name' }, 400);

  const branch = `dunamis/${slug}-${direction}`;

  try {
    await dispatchWorkflow(env.AGORA_DISPATCH_PAT, env.AGORA_REPO,
      'compile-word.yml',
      { branch, slug });

    return jsonResponse({
      status: 'dispatched',
      slug,
      direction,
      branch,
      message: `Word compile dispatched for ${branch}. main.docx will be committed to the branch when ready.`
    }, 202);

  } catch (err) {
    console.error('Compile-word error:', err);
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
