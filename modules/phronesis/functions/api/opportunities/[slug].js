/**
 * /api/opportunities/:slug — single opportunity: get (GET), update (PATCH).
 * Opportunities are consumed via accept/reject, not DELETE.
 */

import { handleGetByKey } from '../../_shared/op-read.js';
import { handlePatch } from '../../_shared/op-write.js';
import { errorResponse } from '../../_shared/api.js';

function slugOf(ctx) {
  const s = ctx.params.slug;
  return s && /^[a-z0-9-]+$/.test(s) ? s : null;
}

export async function onRequestGet(ctx) {
  const s = slugOf(ctx);
  if (!s) return errorResponse(400, 'VALIDATION_ERROR', 'Invalid slug');
  return handleGetByKey(ctx.request, ctx.env, 'opportunities', '/api/opportunities', 'slug', s);
}

export async function onRequestPatch(ctx) {
  const s = slugOf(ctx);
  if (!s) return errorResponse(400, 'VALIDATION_ERROR', 'Invalid slug');
  return handlePatch(ctx.request, ctx.env, 'opportunities', '/api/opportunities', 'slug', s);
}
