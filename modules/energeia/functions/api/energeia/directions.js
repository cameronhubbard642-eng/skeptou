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
 * Env: AGORA_DISPATCH_PAT, AGORA_REPO, ENERGEIA_ACTIONS, HMAC_SECRET, AUTH_DOMAIN
 */

const GREEK = [
  'alpha','beta','gamma','delta','epsilon','zeta','eta','theta',
  'iota','kappa','lambda','mu','nu','xi','omicron','pi','rho',
  'sigma','tau','upsilon','phi','chi','psi','omega'
];

import { requireSession } from '../../_shared/auth.js';

export async function onRequestPost(ctx) {
  const { env, request } = ctx;

  const authRedirect = await requireSession(request, env);
  if (authRedirect) return authRedirect;

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

