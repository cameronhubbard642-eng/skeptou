/**
 * POST /api/tasks/complete/:id — mark a task completed (spec §IV.10).
 */

import { handleCompleteTask } from '../../../_shared/op-write.js';
import { errorResponse } from '../../../_shared/api.js';

export async function onRequestPost(ctx) {
  const id = ctx.params.id;
  if (!id || !/^\d+$/.test(id)) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid task id');
  }
  return handleCompleteTask(ctx.request, ctx.env, Number(id));
}
