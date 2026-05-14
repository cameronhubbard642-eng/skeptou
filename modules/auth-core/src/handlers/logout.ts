import type { Env } from '../types';
import { getCookieValue, clearSessionCookie } from '../lib/session';
import { verifyPayload } from '../lib/hmac';
import { getCookieName } from '../lib/brand';
import { appendAudit } from '../lib/audit';

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const cookieName = getCookieName(env.DEPLOYMENT);
  const cookieVal = getCookieValue(request, cookieName);
  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  const ua = request.headers.get('User-Agent') ?? undefined;

  if (cookieVal) {
    const payload = await verifyPayload(cookieVal, env.HMAC_SECRET);
    if (payload) {
      // Write revocation entry so /session validates against it
      await env.AUTH_KV.put(
        `revoke:${payload.jti}`,
        JSON.stringify({ revoked_at: new Date().toISOString() }),
        { expirationTtl: 90 * 24 * 3600 },
      );
      await appendAudit(env, {
        event: 'SESSION_REVOKED',
        sub: payload.sub,
        ip,
        ua,
      });
    }
  }

  const clearCookie = clearSessionCookie(cookieName, env.COOKIE_DOMAIN);

  return new Response(null, {
    status: 302,
    headers: {
      Location: env.BRAND_URL,
      'Set-Cookie': clearCookie,
    },
  });
}
