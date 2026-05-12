/**
 * POST /api/energeia/actions/:id/complete — daemon reports action completion
 *
 * Body: { status: "success" | "error", message? }
 *
 * Updates the KV action record and removes the action from the queue.
 *
 * Env: ENERGEIA_ACTIONS (KV namespace binding)
 */

export async function onRequestPost(ctx) {
  const { env, params, request } = ctx;

  const authErr = await validateDaemonToken(request, env.ENERGEIA_ACTIONS);
  if (authErr) return jsonResponse({ error: 'Unauthorized', detail: authErr }, 401);

  const id = params.id;
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    return jsonResponse({ error: 'Invalid action id' }, 400);
  }

  let body;
  try { body = await request.json(); }
  catch (_) { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

  const { status, message = '' } = body;
  if (status !== 'success' && status !== 'error') {
    return jsonResponse({ error: 'status must be "success" or "error"' }, 400);
  }

  if (!env.ENERGEIA_ACTIONS) {
    return jsonResponse({ ok: true, note: 'KV not configured' }, 200);
  }

  try {
    const raw = await env.ENERGEIA_ACTIONS.get(`action:${id}`);
    if (!raw) return jsonResponse({ error: 'Action not found' }, 404);

    const action = JSON.parse(raw);
    action.status       = status;
    action.result       = message;
    action.completed_at = new Date().toISOString();
    await env.ENERGEIA_ACTIONS.put(`action:${id}`, JSON.stringify(action));

    /* Remove from queue */
    const queueRaw = await env.ENERGEIA_ACTIONS.get('action-queue');
    if (queueRaw) {
      const queue = JSON.parse(queueRaw).filter(qid => qid !== id);
      await env.ENERGEIA_ACTIONS.put('action-queue', JSON.stringify(queue));
    }

    return jsonResponse({ ok: true, id, status }, 200);

  } catch (err) {
    console.error('Actions/complete error:', err);
    return jsonResponse({ error: 'Internal error', detail: err.message }, 500);
  }
}

async function validateDaemonToken(request, kv) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return 'Missing Bearer token';
  const token = auth.slice(7).trim();
  if (!token) return 'Empty token';
  if (!kv) return null;
  const entry = await kv.get(`daemon-token:${token}`);
  if (!entry) return 'Unknown daemon token';
  return null;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
