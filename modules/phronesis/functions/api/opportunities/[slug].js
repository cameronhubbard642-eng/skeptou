/**
 * GET /api/opportunities/:slug — single opportunity (Phase 1).
 */

import { handleGetByKey } from '../../_shared/op-read.js';
import { errorResponse } from '../../_shared/api.js';

export async function onRequestGet(ctx) {
  const slug = ctx.params.slug;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid slug');
  }
  return handleGetByKey(ctx.request, ctx.env, 'opportunities', '/api/opportunities', 'slug', slug);
}
