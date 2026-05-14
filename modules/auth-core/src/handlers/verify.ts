import type { Env, SessionPayload } from '../types';
import { consumeToken } from '../lib/token';
import { getAllowlistEntry } from '../lib/allowlist';
import { signPayload } from '../lib/hmac';
import {
  buildSessionCookie,
  SESSION_TTL_SLIDING_SEC,
  SESSION_TTL_ABSOLUTE_SEC,
  generateJti,
} from '../lib/session';
import { getCookieName } from '../lib/brand';
import { appendAudit } from '../lib/audit';
import { renderTemplate } from '../lib/brand';

function validateNextUrl(next: string | null, cookieDomain: string, brandUrl: string): string {
  if (!next) return brandUrl;
  if (next.startsWith('/') && !next.startsWith('//')) return next;
  try {
    const domain = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
    const { hostname } = new URL(next);
    if (hostname === domain || hostname.endsWith('.' + domain)) return next;
  } catch {}
  return brandUrl;
}

export async function handleVerify(
  request: Request,
  env: Env,
  templates: Record<string, string>,
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const next = url.searchParams.get('next');
  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  const ua = request.headers.get('User-Agent') ?? undefined;

  const errorPage = (message: string) => {
    const html = renderTemplate(templates['verify-error.html'] ?? '', {
      BRAND_NAME: env.BRAND_NAME,
      BRAND_URL: env.BRAND_URL,
      ERROR_MESSAGE: message,
    });
    return new Response(html, {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  };

  if (!token) {
    return errorPage('No token provided.');
  }

  const tokenEntry = await consumeToken(env.AUTH_KV, token);
  if (!tokenEntry) {
    await appendAudit(env, { event: 'MAGIC_LINK_EXPIRED', ip, ua });
    return errorPage('This link has expired or has already been used. Please request a new one.');
  }

  // Re-check allowlist (may have changed during 10-minute window)
  const allowlistEntry = await getAllowlistEntry(env.AUTH_KV, tokenEntry.email);
  if (!allowlistEntry || !allowlistEntry.active) {
    await appendAudit(env, { event: 'MAGIC_LINK_EXPIRED', sub: tokenEntry.email, ip, ua });
    return errorPage('Access has been revoked. Please contact the administrator.');
  }

  await appendAudit(env, { event: 'MAGIC_LINK_VERIFIED', sub: tokenEntry.email, ip, ua });

  const now = Math.floor(Date.now() / 1000);
  const isAdmin = env.ADMIN_EMAIL
    ? tokenEntry.email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase()
    : false;

  const payload: SessionPayload = {
    sub: tokenEntry.email,
    iat: now,
    exp: now + SESSION_TTL_ABSOLUTE_SEC,
    rol: isAdmin ? 'admin' : 'user',
    jti: generateJti(),
  };

  const cookieValue = await signPayload(payload, env.HMAC_SECRET);
  const cookieName = getCookieName(env.DEPLOYMENT);
  const cookieHeader = buildSessionCookie(
    cookieName,
    cookieValue,
    env.COOKIE_DOMAIN,
    SESSION_TTL_SLIDING_SEC,
  );

  await appendAudit(env, { event: 'SESSION_ISSUED', sub: tokenEntry.email, ip, ua });

  const redirectTarget = validateNextUrl(next, env.COOKIE_DOMAIN, env.BRAND_URL);

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectTarget,
      'Set-Cookie': cookieHeader,
    },
  });
}
