import type { RateLimitBucket } from '../types';

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
}

export async function consumeBucket(
  kv: KVNamespace,
  key: string,
  capacity: number,
  refillRatePerSec: number,
  cost: number,
): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const raw = (await kv.get(key, 'json')) as RateLimitBucket | null;
  let { tokens, last_refill } = raw ?? { tokens: capacity, last_refill: now };

  const elapsed = now - last_refill;
  tokens = Math.min(capacity, tokens + elapsed * refillRatePerSec);

  if (tokens < cost) {
    const retryAfter = Math.ceil((cost - tokens) / refillRatePerSec);
    return { allowed: false, retryAfter };
  }

  tokens -= cost;
  await kv.put(key, JSON.stringify({ tokens, last_refill: now }), { expirationTtl: 3600 });
  return { allowed: true };
}
