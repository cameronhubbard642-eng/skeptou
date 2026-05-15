/**
 * _shared/api.js — HTTP response helpers + query parsing for the O&P API.
 *
 * Response envelopes follow specs/op-d1-migration.md §IV.4.
 */

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** Error envelope — { error, code } — for all 4xx/5xx (§IV.4). */
export function errorResponse(status, code, message) {
  return jsonResponse({ error: message, code }, status);
}

/** List envelope — { data, total, limit, offset } (§IV.4). */
export function listResponse(data, total, limit, offset) {
  return jsonResponse({ data, total, limit, offset });
}

/** Single-item envelope — { data } (§IV.4). */
export function itemResponse(data, status = 200) {
  return jsonResponse({ data }, status);
}

/**
 * Parses list-query params from a URL (§IV.2). Returns raw filter values;
 * the query builder decides which apply to a given table. Filter values
 * that fail to parse as numbers are dropped (left undefined).
 */
export function parseListQuery(url) {
  const p = url.searchParams;
  const num = (key) => {
    if (!p.has(key)) return undefined;
    const n = Number(p.get(key));
    return Number.isFinite(n) ? n : undefined;
  };
  const rawLimit = num('limit');
  return {
    status:       p.get('status')   ?? undefined,
    area:         p.get('area')     ?? undefined,
    opp_type:     p.get('opp_type') ?? undefined,
    category:     p.get('category') ?? undefined,
    project_slug: p.get('project_slug') ?? p.get('project') ?? undefined,
    priority:     num('priority'),
    prestige_min: num('prestige_min'),
    sort:         p.get('sort')  ?? undefined,
    order:        (p.get('order') ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc',
    limit:        Math.min(rawLimit !== undefined ? rawLimit : 100, 200),
    offset:       num('offset') ?? 0,
  };
}
