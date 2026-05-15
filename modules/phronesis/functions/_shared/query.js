/**
 * _shared/query.js — dynamic WHERE/ORDER builder for O&P list endpoints.
 *
 * Per specs/op-d1-migration.md rev 3 §IV.3. Table names and column names here
 * are a fixed allowlist — never interpolate caller input into SQL identifiers.
 */

/**
 * Per-table query config:
 *   filters        — { param, col, op } applied when the param is present
 *   sorts          — sort-key → column allowlist
 *   defaultSortCol — column used when no/unknown sort given
 *   defaultScope   — { unlessParam, clause } — `clause` is added to WHERE unless
 *                    the caller passed `unlessParam`, so soft-deleted / archived
 *                    rows are excluded by default.
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
    defaultScope: { unlessParam: 'status', clause: "status != 'archived'" },
  },
  opportunities: {
    filters: [
      { param: 'opp_type',     col: 'opp_type', op: '=' },
      { param: 'priority',     col: 'priority', op: '<=' },
      { param: 'prestige_min', col: 'prestige', op: '>=' },
    ],
    sorts: { deadline: 'deadline', priority: 'priority', prestige: 'prestige', created: 'created_at', updated: 'updated_at' },
    defaultSortCol: 'updated_at',
    defaultScope: { unlessParam: 'include_archived', clause: 'archived = 0' },
  },
  tasks: {
    filters: [
      { param: 'status',      col: 'status',      op: '=' },
      { param: 'parent_kind', col: 'parent_kind', op: '=' },
      { param: 'parent_id',   col: 'parent_id',   op: '=' },
      { param: 'priority',    col: 'priority',    op: '<=' },
    ],
    sorts: { due: 'due_date', priority: 'priority', created: 'created_at', updated: 'updated_at' },
    defaultSortCol: 'updated_at',
    defaultScope: { unlessParam: 'status', clause: "status != 'cancelled'" },
  },
  inventory: {
    filters: [
      { param: 'status',   col: 'status',   op: '=' },
      { param: 'category', col: 'category', op: '=' },
    ],
    sorts: { created: 'created_at', updated: 'updated_at', name: 'name' },
    defaultSortCol: 'updated_at',
    defaultScope: { unlessParam: 'status', clause: "status != 'retired'" },
  },
  commitments: {
    filters: [
      { param: 'status', col: 'status', op: '=' },
      { param: 'kind',   col: 'kind',   op: '=' },
    ],
    sorts: { start: 'start_date', created: 'created_at', updated: 'updated_at', name: 'title' },
    defaultSortCol: 'updated_at',
    defaultScope: { unlessParam: 'status', clause: "status != 'archived'" },
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

  // Exclude soft-deleted / archived rows unless the caller opts in.
  if (cfg.defaultScope && !q[cfg.defaultScope.unlessParam]) {
    where.push(cfg.defaultScope.clause);
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
