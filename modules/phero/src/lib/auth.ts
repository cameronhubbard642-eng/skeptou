import type { Env } from '../types';

function base64urlDecode(input: string): ArrayBuffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const b64 = padded + '='.repeat(padLen);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export function getCookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

async function verifySessionToken(value: string, secret: string): Promise<boolean> {
  const dot = value.indexOf('.');
  if (dot === -1) return false;
  const data = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!data || !sig) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      base64urlDecode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      base64urlDecode(sig),
      new TextEncoder().encode(data),
    );
    if (!valid) return false;
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(data))) as { exp: number };
    return payload.exp >= Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export async function requireCamSession(request: Request, env: Env): Promise<Response | null> {
  if (!env.HMAC_SECRET) return null; // dev mode — no secret configured
  const cookieName = env.COOKIE_NAME ?? '__skeptou_session';
  const val = getCookieValue(request, cookieName);
  if (!val || !(await verifySessionToken(val, env.HMAC_SECRET))) {
    return Response.json({ error: 'Unauthorized' }, { status: 403 });
  }
  return null;
}
