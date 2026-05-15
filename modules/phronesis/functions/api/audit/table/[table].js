/**
 * GET /api/audit/table/:table — all audit rows for one table name (Phase 1).
 */

import { handleAuditTable } from '../../../_shared/op-read.js';

export async function onRequestGet(ctx) {
  return handleAuditTable(ctx.request, ctx.env, ctx.params.table);
}
