/**
 * GET /api/projects — list projects (O&P D1 API, Phase 1).
 * Filters: status, area, priority. Sort: due, priority, created, updated.
 */

import { handleList } from '../../_shared/op-read.js';

export async function onRequestGet(ctx) {
  return handleList(ctx.request, ctx.env, 'projects', '/api/projects');
}
