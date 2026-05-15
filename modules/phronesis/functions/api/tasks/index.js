/**
 * GET /api/tasks — list tasks (O&P D1 API, Phase 1).
 * Filters: status, project_slug, priority. Sort: due, priority.
 */

import { handleList } from '../../_shared/op-read.js';

export async function onRequestGet(ctx) {
  return handleList(ctx.request, ctx.env, 'tasks', '/api/tasks');
}
