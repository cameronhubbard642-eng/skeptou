/**
 * GET /api/tasks/:id — single task by integer id (Phase 1).
 */

import { handleGetByKey } from '../../_shared/op-read.js';
import { errorResponse } from '../../_shared/api.js';

export async function onRequestGet(ctx) {
  const id = ctx.params.id;
  if (!id || !/^\d+$/.test(id)) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid task id');
  }
  return handleGetByKey(ctx.request, ctx.env, 'tasks', '/api/tasks', 'id', Number(id));
}
