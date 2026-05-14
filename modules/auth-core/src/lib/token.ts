import type { MagicTokenEntry } from '../types';

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function storeToken(
  kv: KVNamespace,
  token: string,
  email: string,
): Promise<void> {
  const entry: MagicTokenEntry = {
    email,
    created_at: new Date().toISOString(),
    exp: Math.floor(Date.now() / 1000) + 600,
  };
  await kv.put(`magic:${token}`, JSON.stringify(entry), { expirationTtl: 600 });
}

// Atomically consumes the token (one-time use). Returns null if absent or expired.
export async function consumeToken(
  kv: KVNamespace,
  token: string,
): Promise<MagicTokenEntry | null> {
  const raw = await kv.get(`magic:${token}`, 'text');
  if (!raw) return null;
  await kv.delete(`magic:${token}`);
  const entry = JSON.parse(raw) as MagicTokenEntry;
  if (entry.exp < Math.floor(Date.now() / 1000)) return null;
  return entry;
}

// Returns the HMAC-SHA256 hex of a token for safe inclusion in audit logs.
export async function hmacTokenForLog(token: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}
