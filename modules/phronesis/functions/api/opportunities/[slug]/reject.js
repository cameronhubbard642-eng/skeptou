/**
 * POST /api/opportunities/:slug/reject — decline an opportunity.
 * Archives the opp and records decided_at; it surfaces in the
 * declined_opportunities view (spec §IV.9).
 */

import { handleReject } from '../../../_shared/op-write.js';
import { errorResponse } from '../../../_shared/api.js';

export async function onRequestPost(ctx) {
  const slug = ctx.params.slug;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid slug');
  }
  return handleReject(ctx.request, ctx.env, slug);
}
