import type { Env } from '../types.ts';
import { getCookieValue } from '../lib/cookie.ts';

// ── HMAC helpers (inlined from auth-client pattern; no shared dep) ──────────

function base64urlDecode(input: string): ArrayBuffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const base64 = padded + '='.repeat(padLen);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer as ArrayBuffer;
}

interface SessionPayload {
  sub: string;
  rol: string;
  iat: number;
  exp: number;
  jti: string;
}

async function verifySessionPayload(
  token: string,
  secret: string,
): Promise<SessionPayload | null> {
  const dotIdx = token.indexOf('.');
  if (dotIdx === -1) return null;
  const data = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  if (!data || !sig) return null;

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'raw',
      base64urlDecode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  } catch {
    return null;
  }

  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    base64urlDecode(sig),
    new TextEncoder().encode(data),
  );
  if (!valid) return null;

  let payload: SessionPayload;
  try {
    const padded = data.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (padded.length % 4)) % 4;
    payload = JSON.parse(atob(padded + '='.repeat(padLen))) as SessionPayload;
  } catch {
    return null;
  }

  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// ── requireCamSession ─────────────────────────────────────────────────────────

export async function requireCamSession(request: Request, env: Env): Promise<Response | null> {
  const cookieVal = getCookieValue(request, '__skeptou_session');
  if (!cookieVal) return forbidden();

  const payload = await verifySessionPayload(cookieVal, env.AUTH_HMAC_SECRET);
  if (!payload) return forbidden();

  if (payload.sub !== env.ADMIN_EMAIL && payload.rol !== 'admin') return forbidden();
  return null;
}

function forbidden(): Response {
  return new Response(JSON.stringify({ error: 'forbidden' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}
