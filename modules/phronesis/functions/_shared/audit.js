/**
 * _shared/audit.js — audit_log helper for O&P write handlers.
 *
 * Per specs/op-d1-migration.md rev 3 §VII.2. auditInsert returns a prepared
 * statement that is always batched atomically with the data write it records.
 */

/**
 * Builds an audit_log INSERT statement.
 *   table  — table name the change applies to
 *   rowId  — slug (projects/opportunities/commitments/inventory) or id (tasks)
 *   op     — 'INSERT' | 'UPDATE' | 'DELETE'
 *   actor  — 'cam' (session) or specialist role slug (service token)
 *   before/after — row state, JSON-serialised into the diff column
 */
export function auditInsert(env, table, rowId, op, actor, before, after) {
  return env.OP_DB.prepare(
    `INSERT INTO audit_log (table_name, row_id, operation, actor, diff)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(table, String(rowId), op, actor, JSON.stringify({ before, after }));
}
