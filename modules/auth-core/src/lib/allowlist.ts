import type { AllowlistEntry } from '../types';

export async function getAllowlistEntry(
  kv: KVNamespace,
  email: string,
): Promise<AllowlistEntry | null> {
  const raw = await kv.get(`allow:${normalizeEmail(email)}`, 'text');
  if (!raw) return null;
  return JSON.parse(raw) as AllowlistEntry;
}

export async function listAllowlistEntries(kv: KVNamespace): Promise<AllowlistEntry[]> {
  const entries: AllowlistEntry[] = [];
  let cursor: string | undefined;
  do {
    const result = await kv.list({ prefix: 'allow:', cursor });
    for (const key of result.keys) {
      const raw = await kv.get(key.name, 'text');
      if (raw) entries.push(JSON.parse(raw) as AllowlistEntry);
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);
  return entries.sort((a, b) => a.added_at.localeCompare(b.added_at));
}

export async function putAllowlistEntry(
  kv: KVNamespace,
  email: string,
  note: string | undefined,
  active: boolean,
): Promise<{ existed: boolean }> {
  const normalized = normalizeEmail(email);
  const existing = await getAllowlistEntry(kv, normalized);
  const entry: AllowlistEntry = {
    email: normalized,
    added_at: existing?.added_at ?? new Date().toISOString(),
    ...(note !== undefined ? { note } : {}),
    active,
  };
  await kv.put(`allow:${normalized}`, JSON.stringify(entry));
  return { existed: existing !== null };
}

export async function deleteAllowlistEntry(kv: KVNamespace, email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  const existing = await getAllowlistEntry(kv, normalized);
  if (!existing) return false;
  await kv.delete(`allow:${normalized}`);
  return true;
}

export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}
