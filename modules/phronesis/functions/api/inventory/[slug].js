/**
 * /api/inventory/:slug — single item: get (GET), update (PATCH),
 * soft-delete (DELETE → status='retired').
 */

import { handleGetByKey } from '../../_shared/op-read.js';
import { handlePatch, handleSoftDelete } from '../../_shared/op-write.js';
import { errorResponse } from '../../_shared/api.js';

function slugOf(ctx) {
  const s = ctx.params.slug;
  return s && /^[a-z0-9-]+$/.test(s) ? s : null;
}

export async function onRequestGet(ctx) {
  const s = slugOf(ctx);
  if (!s) return errorResponse(400, 'VALIDATION_ERROR', 'Invalid slug');
  return handleGetByKey(ctx.request, ctx.env, 'inventory', '/api/inventory', 'slug', s);
}

export async function onRequestPatch(ctx) {
  const s = slugOf(ctx);
  if (!s) return errorResponse(400, 'VALIDATION_ERROR', 'Invalid slug');
  return handlePatch(ctx.request, ctx.env, 'inventory', '/api/inventory', 'slug', s);
}

export async function onRequestDelete(ctx) {
  const s = slugOf(ctx);
  if (!s) return errorResponse(400, 'VALIDATION_ERROR', 'Invalid slug');
  return handleSoftDelete(ctx.request, ctx.env, 'inventory', '/api/inventory', 'slug', s);
}
