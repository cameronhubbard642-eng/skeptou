/**
 * GET /api/inventory — list inventory items (O&P D1 API, Phase 1).
 * Filters: status, category.
 */

import { handleList } from '../../_shared/op-read.js';

export async function onRequestGet(ctx) {
  return handleList(ctx.request, ctx.env, 'inventory', '/api/inventory');
}
