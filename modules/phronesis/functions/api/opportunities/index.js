/**
 * GET /api/opportunities — list opportunities (O&P D1 API, Phase 1).
 * Filters: status, opp_type, priority, prestige_min.
 * Sort: deadline, priority, prestige, created, updated.
 */

import { handleList } from '../../_shared/op-read.js';

export async function onRequestGet(ctx) {
  return handleList(ctx.request, ctx.env, 'opportunities', '/api/opportunities');
}
