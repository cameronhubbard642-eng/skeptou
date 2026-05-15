/**
 * /api/tasks/:id — single task: get (GET), update (PATCH),
 * soft-delete (DELETE → status='cancelled').
 */

import { handleGetByKey } from '../../_shared/op-read.js';
import { handlePatch, handleSoftDelete } from '../../_shared/op-write.js';
import { errorResponse } from '../../_shared/api.js';

function idOf(ctx) {
  const id = ctx.params.id;
  return id && /^\d+$/.test(id) ? Number(id) : null;
}

export async function onRequestGet(ctx) {
  const id = idOf(ctx);
  if (id === null) return errorResponse(400, 'VALIDATION_ERROR', 'Invalid task id');
  return handleGetByKey(ctx.request, ctx.env, 'tasks', '/api/tasks', 'id', id);
}

export async function onRequestPatch(ctx) {
  const id = idOf(ctx);
  if (id === null) return errorResponse(400, 'VALIDATION_ERROR', 'Invalid task id');
  return handlePatch(ctx.request, ctx.env, 'tasks', '/api/tasks', 'id', id);
}

export async function onRequestDelete(ctx) {
  const id = idOf(ctx);
  if (id === null) return errorResponse(400, 'VALIDATION_ERROR', 'Invalid task id');
  return handleSoftDelete(ctx.request, ctx.env, 'tasks', '/api/tasks', 'id', id);
}
