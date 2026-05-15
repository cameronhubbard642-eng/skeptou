/**
 * GET /api/commitments — list commitments (O&P D1 API).
 * Filters: status, kind.
 */

import { handleList } from '../../_shared/op-read.js';

export async function onRequestGet(ctx) {
  return handleList(ctx.request, ctx.env, 'commitments', '/api/commitments');
}
