import type { AuditEntry, AuditEvent, Env } from '../types';
import { newSortableId } from './ulid';
import { hashString, sanitizeIp, truncateUa } from './brand';

interface AppendAuditOptions {
  event: AuditEvent;
  sub?: string;
  ip?: string;
  ua?: string;
  meta?: Record<string, unknown>;
}

export async function appendAudit(env: Env, opts: AppendAuditOptions): Promise<void> {
  const id = newSortableId();
  const ts = new Date().toISOString();
  const piiMinimize = (env.PII_MINIMIZE ?? 'true') !== 'false';

  let sub = opts.sub;
  let ip = opts.ip ? sanitizeIp(opts.ip) : undefined;

  if (piiMinimize) {
    if (sub) sub = await hashString(sub);
    if (ip) ip = await hashString(ip);
  }

  const entry: AuditEntry = {
    id,
    ts,
    event: opts.event,
    deployment: env.DEPLOYMENT,
    ...(sub !== undefined ? { sub } : {}),
    ...(ip !== undefined ? { ip } : {}),
    ...(opts.ua !== undefined ? { ua: truncateUa(opts.ua) } : {}),
    ...(opts.meta !== undefined ? { meta: opts.meta } : {}),
  };

  const date = ts.slice(0, 10);
  await env.AUTH_KV.put(
    `audit:${date}:${id}`,
    JSON.stringify(entry),
    { expirationTtl: 90 * 24 * 3600 },
  );
}

interface QueryAuditOptions {
  limit?: number;
  before?: string;  // ISO date string
  email?: string;   // plaintext filter (note: may not match if PII_MINIMIZE is on)
}

export async function queryAudit(
  env: Env,
  opts: QueryAuditOptions = {},
): Promise<{ entries: AuditEntry[]; count: number }> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const allKeys: string[] = [];
  let cursor: string | undefined;

  do {
    const result = await env.AUTH_KV.list({ prefix: 'audit:', cursor });
    for (const key of result.keys) {
      if (opts.before && key.name > `audit:${opts.before}`) continue;
      allKeys.push(key.name);
    }
    cursor = result.list_complete
      ? undefined
      : result.cursor;
  } while (cursor);

  // Sort descending (most recent first)
  allKeys.sort((a, b) => b.localeCompare(a));

  const entries: AuditEntry[] = [];
  for (const key of allKeys) {
    if (entries.length >= limit) break;
    const raw = await env.AUTH_KV.get(key, 'text');
    if (!raw) continue;
    const entry = JSON.parse(raw) as AuditEntry;
    if (opts.email && entry.sub !== opts.email) continue;
    entries.push(entry);
  }

  return { entries, count: entries.length };
}
