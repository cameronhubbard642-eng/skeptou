import type { Env } from '../types';
import { getCookieValue } from '../lib/session';
import { verifyPayload } from '../lib/hmac';
import { getCookieName } from '../lib/brand';

// Admin routes accept either:
//   - Authorization: Bearer <ADMIN_SECRET> header
//   - A valid session cookie with rol = "admin" (set when ADMIN_EMAIL logs in)
export async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (timingSafeEqual(token, env.ADMIN_SECRET)) return null; // allowed
    return jsonError(403, 'forbidden');
  }

  // Fall back to session cookie with admin role
  const cookieName = getCookieName(env.DEPLOYMENT);
  const cookieVal = getCookieValue(request, cookieName);
  if (cookieVal) {
    const payload = await verifyPayload(cookieVal, env.HMAC_SECRET);
    if (payload?.rol === 'admin') return null; // allowed
  }

  return jsonError(401, 'unauthorized', { 'WWW-Authenticate': 'Bearer' });
}

function jsonError(
  status: number,
  error: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
