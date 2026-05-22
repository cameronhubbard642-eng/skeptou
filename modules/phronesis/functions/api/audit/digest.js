/**
 * GET /api/audit/digest?since=<iso> — planner-shaped audit digest.
 *
 * Returns audit rows newer than `since` (default: 7d ago) categorised into
 * planner-useful buckets (tasks_completed with completed_at, tasks_created,
 * status flips, INSERT/DELETE events per table) plus a small current-state
 * snapshot (open task count, completed-in-window, active projects, open
 * opportunities). Re-uses the /api/audit scope, so existing audit-scoped
 * service tokens work without re-issuance.
 */

import { handleAuditDigest } from '../../_shared/op-read.js';

export async function onRequestGet(ctx) {
  return handleAuditDigest(ctx.request, ctx.env);
}
