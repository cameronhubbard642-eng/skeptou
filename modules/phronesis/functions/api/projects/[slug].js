/**
 * GET /api/projects/:slug — single project with embedded tasks (Phase 1).
 */

import { handleGetProject } from '../../_shared/op-read.js';
import { errorResponse } from '../../_shared/api.js';

export async function onRequestGet(ctx) {
  const slug = ctx.params.slug;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid slug');
  }
  return handleGetProject(ctx.request, ctx.env, slug);
}
