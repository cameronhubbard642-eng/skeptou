/**
 * GET /api/audit/since/:timestamp — audit rows newer than an ISO 8601 ts.
 * Used by O&P specialists on activation to catch up on changes (Phase 1).
 */

import { handleAuditSince } from '../../../_shared/op-read.js';

export async function onRequestGet(ctx) {
  return handleAuditSince(ctx.request, ctx.env, ctx.params.timestamp);
}
