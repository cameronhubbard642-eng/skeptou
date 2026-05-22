/**
 * POST /api/energeia/compile-draft/:slug/:direction — on-demand draft compile
 *
 * Dispatches compile-draft.yml on the agora repo.
 * Does NOT promote — just compiles the current state of the dunamis branch.
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

  if (!slug      || !/^[a-z0-9-]+$/.test(slug))  return jsonResponse({ error: 'Invalid slug' }, 400);
  if (!direction || !/^[a-z]+$/.test(direction))  return jsonResponse({ error: 'Invalid direction name' }, 400);

  const branch = `dunamis/${slug}-${direction}`;

  /* Optional compile toggles — anonymise / plain LaTeX / word count.
     Body may be absent (defaults below). wordcount triggers the .sty's
     `wordcount` option, which runs texcount via \write18 to print an
     "N words" line in the title block. */
  let body = {};
  try { body = await request.json(); } catch (_) { /* no body — defaults */ }
  const anonymous = body.anonymous === true;
  const plain     = body.plain === true;
  const wordcount = body.wordcount === true;

  try {
    await dispatchWorkflow(env.AGORA_DISPATCH_PAT, env.AGORA_REPO,
      'compile-draft.yml',
      { branch, slug,
        anonymous: String(anonymous),
        plain:     String(plain),
        wordcount: String(wordcount) });

    const flags = [anonymous && 'anonymous', plain && 'plain', wordcount && 'wordcount']
      .filter(Boolean);
    return jsonResponse({
      status: 'dispatched',
      slug,
      direction,
      branch,
      anonymous,
      plain,
      wordcount,
      message: `Draft compile dispatched for ${branch}${flags.length
        ? ` (${flags.join(', ')})` : ''}. `
        + 'PDF will be committed to the branch when ready.'
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

