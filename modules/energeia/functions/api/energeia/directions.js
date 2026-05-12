/**
 * POST /api/energeia/directions — create a new dunamis direction for a paper
 *
 * Body: { slug, name? }
 *   slug — paper slug
 *   name — direction name (optional; auto-assigned next Greek letter if absent)
 *
 * Steps:
 *   1. Validate CF Access JWT
 *   2. Determine next Greek direction name
 *   3. Dispatch create-dunamis-branch.yml
 *   4. Queue daemon action: duplicate-scrivener-project
 *   5. Return 202
 *
 * Env: AGORA_DISPATCH_PAT, AGORA_REPO, CF_ACCESS_AUD, ENERGEIA_ACTIONS
 */

const GREEK = [
  'alpha','beta','gamma','delta','epsilon','zeta','eta','theta',
  'iota','kappa','lambda','mu','nu','xi','omicron','pi','rho',
  'sigma','tau','upsilon','phi','chi','psi','omega'
];

export async function onRequestPost(ctx) {
  const { env, request } = ctx;

  const authErr = await validateCFAccess(request, env.CF_ACCESS_AUD);
  if (authErr) return jsonResponse({ error: 'Unauthorized', detail: authErr }, 401);

  let body;
  try { body = await request.json(); }
  catch (_) { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

  const { slug, name } = body;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return jsonResponse({ error: 'slug is required and must be lowercase alphanumeric with hyphens' }, 400);
  }

  let directionName;
  if (name) {
    if (!GREEK.includes(name)) {
      return jsonResponse({ error: `name must be a Greek letter name: ${GREEK.join(', ')}` }, 400);
    }
    directionName = name;
  } else {
    /* Auto-assign: find existing branches to determine next letter */
    directionName = await nextGreekName(env.AGORA_DISPATCH_PAT, env.AGORA_REPO, slug);
  }

  const branchName = `dunamis/${slug}-${directionName}`;

  try {
    await dispatchWorkflow(env.AGORA_DISPATCH_PAT, env.AGORA_REPO,
      'create-dunamis-branch.yml',
      { slug, direction_name: directionName });

    if (env.ENERGEIA_ACTIONS) {
      await queueDaemonAction(env.ENERGEIA_ACTIONS, 'duplicate-scrivener-project',
        { slug, direction: directionName, branch: branchName });
    }

    return jsonResponse({
      status: 'dispatched',
      slug,
      direction: directionName,
      branch: branchName,
      message: `New direction "${directionName}" dispatched — branch ${branchName} being created.`
    }, 202);

  } catch (err) {
    console.error('New direction error:', err);
    return jsonResponse({ error: 'Internal error', detail: err.message }, 500);
  }
}

/* ── Determine next available Greek direction name ──────────────────────── */
async function nextGreekName(pat, repo, slug) {
  try {
    const url = `https://api.github.com/repos/${repo}/git/refs/heads/dunamis/${slug}-`;
    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'energeia-skeptou'
      }
    });
    if (!resp.ok) return GREEK[0];

    const refs = await resp.json();
    const existing = new Set(
      refs.map(r => r.ref.replace(`refs/heads/dunamis/${slug}-`, ''))
    );
    return GREEK.find(g => !existing.has(g)) || `${GREEK.at(-1)}-2`;

  } catch (_) {
    return GREEK[0];
  }
}

/* ── Shared utilities ───────────────────────────────────────────────────── */
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

async function queueDaemonAction(kv, type, payload) {
  const id = crypto.randomUUID();
  await kv.put(`action:${id}`, JSON.stringify({
    id, type, payload, status: 'pending', created: new Date().toISOString()
  }));
  const queueRaw = await kv.get('action-queue');
  const queue = queueRaw ? JSON.parse(queueRaw) : [];
  queue.push(id);
  await kv.put('action-queue', JSON.stringify(queue));
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
