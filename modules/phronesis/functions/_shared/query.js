/**
 * _shared/query.js — dynamic WHERE/ORDER builder for O&P list endpoints.
 *
 * Per specs/op-d1-migration.md §IV.3. Table names and column names here are
 * a fixed allowlist — never interpolate caller input into SQL identifiers.
 */

/**
 * Per-table query config:
 *   filters    — { param, col, op } applied when the param is present
 *   sorts      — sort-key → column allowlist
 *   defaultSortCol — column used when no/unknown sort given
 *   hideSoftDeleted — WHERE fragment added when no `status` filter is given,
 *                     so soft-deleted rows are excluded by default (§IV.3)
 */
export const TABLES = {
  projects: {
    filters: [
      { param: 'status',   col: 'status',   op: '=' },
      { param: 'area',     col: 'area',     op: '=' },
      { param: 'priority', col: 'priority', op: '<=' },
    ],
    sorts: { due: 'due_date', priority: 'priority', created: 'created_at', updated: 'updated_at' },
    defaultSortCol: 'updated_at',
    hideSoftDeleted: "status != 'archived'",
  },
  opportunities: {
    filters: [
      { param: 'status',       col: 'status',   op: '=' },
      { param: 'opp_type',     col: 'opp_type', op: '=' },
      { param: 'priority',     col: 'priority', op: '<=' },
      { param: 'prestige_min', col: 'prestige', op: '>=' },
    ],
    sorts: { deadline: 'deadline', priority: 'priority', prestige: 'prestige', created: 'created_at', updated: 'updated_at' },
    defaultSortCol: 'updated_at',
    hideSoftDeleted: 'archived_at IS NULL',
  },
  tasks: {
    filters: [
      { param: 'status',       col: 'status',       op: '=' },
      { param: 'project_slug', col: 'project_slug', op: '=' },
      { param: 'priority',     col: 'priority',     op: '<=' },
    ],
    sorts: { due: 'due_date', priority: 'priority', created: 'created_at', updated: 'updated_at' },
    defaultSortCol: 'updated_at',
    hideSoftDeleted: "status != 'cancelled'",
  },
  inventory: {
    filters: [
      { param: 'status',   col: 'status',   op: '=' },
      { param: 'category', col: 'category', op: '=' },
    ],
    sorts: { created: 'created_at', updated: 'updated_at', name: 'name' },
    defaultSortCol: 'updated_at',
    hideSoftDeleted: "status != 'retired'",
  },
};

/**
 * Builds the WHERE clause, ORDER clause, and filter bindings for a list query.
 * `table` must be a key of TABLES (caller-validated). Returns:
 *   { whereClause, orderClause, filterBindings, limit, offset }
 * filterBindings excludes LIMIT/OFFSET so it can be reused for a COUNT query.
 */
export function buildListQuery(table, q) {
  const cfg = TABLES[table];
  const where = [];
  const filterBindings = [];

  for (const f of cfg.filters) {
    const val = q[f.param];
    if (val !== undefined && val !== '') {
      where.push(`${f.col} ${f.op} ?`);
      filterBindings.push(val);
    }
  }

  // Exclude soft-deleted rows unless the caller explicitly filters on status.
  if (q.status === undefined || q.status === '') {
    where.push(cfg.hideSoftDeleted);
  }

  const sortCol = cfg.sorts[q.sort] || cfg.defaultSortCol;
  const order = q.order === 'asc' ? 'ASC' : 'DESC';

  return {
    whereClause: where.length ? `WHERE ${where.join(' AND ')}` : '',
    orderClause: `ORDER BY ${sortCol} ${order}`,
    filterBindings,
    limit: Math.max(1, Math.min(Number(q.limit) || 100, 200)),
    offset: Math.max(0, Number(q.offset) || 0),
  };
}
