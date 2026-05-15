/**
 * POST /api/opportunities/:slug/accept — accept an opportunity.
 * Archives the opp + creates a linked project + an SAA planning task,
 * all in one atomic batch (spec §IV.8).
 */

import { handleAccept } from '../../../_shared/op-write.js';
import { errorResponse } from '../../../_shared/api.js';

export async function onRequestPost(ctx) {
  const slug = ctx.params.slug;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid slug');
  }
  return handleAccept(ctx.request, ctx.env, slug);
}
