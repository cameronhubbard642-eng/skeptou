/**
 * POST /api/energeia/compile-draft/:slug/:direction — on-demand draft compile
 *
 * Dispatches compile-draft.yml on the agora repo.
 * Does NOT promote — just compiles the current state of the dunamis branch.
 *
 * Env: AGORA_DISPATCH_PAT, AGORA_REPO, CF_ACCESS_AUD
 */

export async function onRequestPost(ctx) {
  const { env, params, request } = ctx;

  const authErr = await validateCFAccess(request, env.CF_ACCESS_AUD);
  if (authErr) return jsonResponse({ error: 'Unauthorized', detail: authErr }, 401);

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

async function validateCFAccess(request, audience) {
  if (!audience) return null;
  const token = request.headers.get('CF-Access-Jwt-Assertion');
  if (!token) return 'Missing CF-Access-Jwt-Assertion header';
  try {
    const [headerB64] = token.split('.');
    const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));
    const certsResp = await fetch('https://skeptou.cloudflareaccess.com/cdn-cgi/access/certs');
    if (!certsResp.ok) return 'Failed to fetch Access certs';
    const certs = await certsResp.json();
    const jwk = (certs.keys || []).find(k => k.kid === header.kid);
    if (!jwk) return 'No matching JWK';
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const [, payloadB64, sigB64] = token.split('.');
    const sig  = Uint8Array.from(atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
    if (!valid) return 'Invalid JWT signature';
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    const audOk = Array.isArray(payload.aud) ? payload.aud.includes(audience) : payload.aud === audience;
    if (!audOk) return 'JWT audience mismatch';
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return 'JWT expired';
    return null;
  } catch (e) {
    return `JWT validation error: ${e.message}`;
  }
}
