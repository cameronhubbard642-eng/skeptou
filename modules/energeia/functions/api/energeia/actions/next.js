/**
 * GET /api/energeia/actions/next — daemon polling endpoint
 *
 * Called by the local daemon every ~5 seconds.
 * Returns the oldest pending action from the KV queue, or { action: null }.
 *
 * Auth: daemon bearer token stored in KV as daemon-token:<token>
 *
 * Env: ENERGEIA_ACTIONS (KV namespace binding)
 */

export async function onRequestGet(ctx) {
  const { env, request } = ctx;

  const authErr = await validateDaemonToken(request, env.ENERGEIA_ACTIONS);
  if (authErr) return jsonResponse({ error: 'Unauthorized', detail: authErr }, 401);

  if (!env.ENERGEIA_ACTIONS) {
    return jsonResponse({ action: null, reason: 'KV not configured' }, 200);
  }

  try {
    const queueRaw = await env.ENERGEIA_ACTIONS.get('action-queue');
    if (!queueRaw) return jsonResponse({ action: null }, 200);

    const queue = JSON.parse(queueRaw);
    if (queue.length === 0) return jsonResponse({ action: null }, 200);

    /* Find the first pending action */
    for (const id of queue) {
      const raw = await env.ENERGEIA_ACTIONS.get(`action:${id}`);
      if (!raw) continue;
      const action = JSON.parse(raw);
      if (action.status === 'pending') {
        /* Mark as claimed so daemon won't re-receive it before reporting complete */
        action.status = 'claimed';
        action.claimed_at = new Date().toISOString();
        await env.ENERGEIA_ACTIONS.put(`action:${id}`, JSON.stringify(action));
        return jsonResponse({ action }, 200);
      }
    }

    return jsonResponse({ action: null }, 200);

  } catch (err) {
    console.error('Actions/next error:', err);
    return jsonResponse({ error: 'Internal error', detail: err.message }, 500);
  }
}

/* ── Daemon token auth ──────────────────────────────────────────────────── */
async function validateDaemonToken(request, kv) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return 'Missing Bearer token';
  const token = auth.slice(7).trim();
  if (!token) return 'Empty token';
  if (!kv) return null; /* KV not configured — skip (dev mode) */
  const entry = await kv.get(`daemon-token:${token}`);
  if (!entry) return 'Unknown daemon token';
  return null;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
