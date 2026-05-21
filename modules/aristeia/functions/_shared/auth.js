/**
 * _shared/auth.js — session validation for aristeia Pages Functions
 *
 * Validates the __skeptou_session HMAC-SHA256 cookie issued by auth.skeptou.com.
 *
 * Required env vars (Cloudflare Pages secrets):
 *   HMAC_SECRET  — 32-byte base64url HMAC key (same secret as auth.skeptou.com)
 *   AUTH_DOMAIN  — auth base URL, default "https://auth.skeptou.com"
 *   COOKIE_NAME  — optional override, default "__skeptou_session"
 *
 * If HMAC_SECRET is not set, validation is skipped (dev/test mode).
 */

const COOKIE_NAME_DEFAULT = '__skeptou_session';
const AUTH_DOMAIN_DEFAULT = 'https://auth.skeptou.com';

function base64urlDecode(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const base64 = padded + '='.repeat(padLen);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function getCookieValue(request, cookieName) {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    if (trimmed.slice(0, eqIdx) === cookieName) return trimmed.slice(eqIdx + 1);
  }
  return null;
}

async function verifySessionCookie(cookieVal, hmacSecret) {
  const dotIdx = cookieVal.indexOf('.');
  if (dotIdx === -1) return null;
  const data = cookieVal.slice(0, dotIdx);
  const sig  = cookieVal.slice(dotIdx + 1);
  if (!data || !sig) return null;

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      base64urlDecode(hmacSecret),
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
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(data)));
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    return { email: payload.sub, exp: payload.exp, jti: payload.jti, rol: payload.rol };
  } catch (_) {
    return null;
  }
}

/**
 * Returns null if authenticated, or a 302 Response redirecting to login.
 */
export async function requireSession(request, env) {
  if (!env.HMAC_SECRET) return null; /* dev mode */

  const cookieName = env.COOKIE_NAME || COOKIE_NAME_DEFAULT;
  const authDomain = env.AUTH_DOMAIN || AUTH_DOMAIN_DEFAULT;
  const next = encodeURIComponent(request.url);

  const cookieVal = getCookieValue(request, cookieName);
  if (!cookieVal) {
    return Response.redirect(`${authDomain}/login?next=${next}`, 302);
  }

  const session = await verifySessionCookie(cookieVal, env.HMAC_SECRET);
  if (!session) {
    return Response.redirect(`${authDomain}/login?next=${next}`, 302);
  }

  return null;
}

/**
 * Returns { authenticated: false } or { authenticated: true, email, exp, jti, rol }.
 */
export async function validateSession(request, env) {
  if (!env.HMAC_SECRET) {
    return { authenticated: true, email: 'dev@localhost', exp: 0, jti: '', rol: 'user' };
  }

  const cookieName = env.COOKIE_NAME || COOKIE_NAME_DEFAULT;
  const cookieVal = getCookieValue(request, cookieName);
  if (!cookieVal) return { authenticated: false };

  const session = await verifySessionCookie(cookieVal, env.HMAC_SECRET);
  if (!session) return { authenticated: false };

  return { authenticated: true, ...session };
}
