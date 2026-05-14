import type { Env } from '../types';
import { getCookieValue, buildSessionCookie, SESSION_TTL_SLIDING_SEC, SESSION_RENEWAL_THRESHOLD_SEC } from '../lib/session';
import { verifyPayload, signPayload } from '../lib/hmac';
import { getCookieName } from '../lib/brand';
import { corsHeaders } from '../middleware/cors';
import { appendAudit } from '../lib/audit';

export async function handleSession(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(request, env.COOKIE_DOMAIN);
  const cookieName = getCookieName(env.DEPLOYMENT);
  const cookieVal = getCookieValue(request, cookieName);

  if (!cookieVal) {
    return jsonResponse({ ok: false, reason: 'invalid' }, 401, cors);
  }

  const payload = await verifyPayload(cookieVal, env.HMAC_SECRET);

  if (!payload) {
    await appendAudit(env, {
      event: 'SESSION_EXPIRED',
      ip: request.headers.get('CF-Connecting-IP') ?? '',
    });
    return jsonResponse({ ok: false, reason: 'expired' }, 401, cors);
  }

  // Check revocation list
  const revoked = await env.AUTH_KV.get(`revoke:${payload.jti}`);
  if (revoked) {
    return jsonResponse({ ok: false, reason: 'revoked' }, 401, cors);
  }

  const now = Math.floor(Date.now() / 1000);
  const slidingExpiresAt = payload.iat + SESSION_TTL_SLIDING_SEC;
  const slidingRemaining = slidingExpiresAt - now;
  const shouldRenew = slidingRemaining < SESSION_RENEWAL_THRESHOLD_SEC;

  const responseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...cors,
  };

  if (shouldRenew) {
    const newCookieVal = await signPayload(payload, env.HMAC_SECRET);
    const setCookie = buildSessionCookie(
      cookieName,
      newCookieVal,
      env.COOKIE_DOMAIN,
      SESSION_TTL_SLIDING_SEC,
    );
    responseHeaders['Set-Cookie'] = setCookie;
    await appendAudit(env, {
      event: 'SESSION_RENEWED',
      sub: payload.sub,
      ip: request.headers.get('CF-Connecting-IP') ?? '',
    });
  }

  return new Response(
    JSON.stringify({
      ok: true,
      sub: payload.sub,
      rol: payload.rol,
      exp: payload.exp,
      renewed: shouldRenew,
    }),
    { status: 200, headers: responseHeaders },
  );
}

function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
