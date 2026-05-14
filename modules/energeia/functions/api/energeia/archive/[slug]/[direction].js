/**
 * POST /api/energeia/archive/:slug/:direction — archive a dunamis direction
 *
 * Queues a daemon action to move the Scrivener project + git worktree to archive.
 * The remote branch is NOT deleted; it stays as a permanent record.
 *
 * Env: ENERGEIA_ACTIONS, HMAC_SECRET, AUTH_DOMAIN
 */

import { requireSession } from '../../../../_shared/auth.js';

export async function onRequestPost(ctx) {
  const { env, params, request } = ctx;

  const authRedirect = await requireSession(request, env);
  if (authRedirect) return authRedirect;

  const slug      = params.slug;
  const direction = params.direction;

  if (!slug      || !/^[a-z0-9-]+$/.test(slug))      return jsonResponse({ error: 'Invalid slug' }, 400);
  if (!direction || !/^[a-z]+$/.test(direction))      return jsonResponse({ error: 'Invalid direction name' }, 400);

  const branch = `dunamis/${slug}-${direction}`;

  try {
    if (env.ENERGEIA_ACTIONS) {
      await queueDaemonAction(env.ENERGEIA_ACTIONS, 'archive-scrivener-project',
        { slug, direction, branch });
      await queueDaemonAction(env.ENERGEIA_ACTIONS, 'remove-worktree',
        { slug, direction, branch });
    }

    return jsonResponse({
      status: 'queued',
      slug,
      direction,
      branch,
      message: `Direction "${direction}" queued for archival. Daemon will move worktree and Scrivener project.`
    }, 202);

  } catch (err) {
    console.error('Archive error:', err);
    return jsonResponse({ error: 'Internal error', detail: err.message }, 500);
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

