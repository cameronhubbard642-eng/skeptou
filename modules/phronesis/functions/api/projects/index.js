/**
 * /api/projects — list (GET) + create (POST).
 */

import { handleList } from '../../_shared/op-read.js';
import { handleCreate } from '../../_shared/op-write.js';

export async function onRequestGet(ctx) {
  return handleList(ctx.request, ctx.env, 'projects', '/api/projects');
}

export async function onRequestPost(ctx) {
  return handleCreate(ctx.request, ctx.env, 'projects', '/api/projects');
}
