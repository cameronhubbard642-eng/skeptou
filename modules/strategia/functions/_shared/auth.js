/**
 * _shared/auth.js — session validation for phronesis Pages Functions
 *
 * Validates the __skeptou_session HMAC-SHA256 cookie issued by auth.skeptou.com.
 * This is the plain-JS equivalent of @skeptou/auth-client for use in CF Pages
 * Functions without a TypeScript build step.
 *
 * Required env vars (Cloudflare Pages secrets):
 *   HMAC_SECRET  — 32-byte base64url HMAC key (same secret as auth.skeptou.com)
 *   AUTH_DOMAIN  — auth base URL, default "https://auth.skeptou.com"
 *   COOKIE_NAME  — optional override, default "__skeptou_session"
 *
 * If HMAC_SECRET is not set, validation is skipped (dev/test mode).
 *
 * Usage:
 *   import { requireSession } from '../../../_shared/auth.js';
 *   const authRedirect = await requireSession(request, env);
 *   if (authRedirect) return authRedirect;  // 302 to login
 *   // authenticated — proceed
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
 * Validates the session cookie. Returns null if authenticated, or a 302
 * Response redirecting to the auth login page if not authenticated.
 */
export async function requireSession(request, env) {
  if (!env.HMAC_SECRET) return null; /* dev mode — no secret configured */

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

  return null; /* authenticated */
}

/**
 * Validates the session cookie and returns session info without redirecting.
 * Useful when the caller wants to handle auth failure itself.
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

/* ── O&P API authentication (spec/op-d1-migration.md §V) ─────────────────── */

/**
 * Thrown by authenticateRequest() when no valid session or service token
 * is present. Callers map this to a 401 response.
 */
export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

async function sha256Hex(input) {
  const buf = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validates a raw Bearer token against the service_tokens table in D1.
 * Returns an AuthContext or null. Returns null (not an error) when the
 * OP_DB binding is absent so the session path can still be tried.
 */
export async function validateServiceToken(rawToken, env) {
  if (!env.OP_DB || !rawToken) return null;

  const hash = await sha256Hex(rawToken);
  const row = await env.OP_DB.prepare(
    'SELECT role_slug, scopes, expires_at FROM service_tokens WHERE token_hash = ? AND active = 1',
  ).bind(hash).first();

  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;

  return { actor: row.role_slug, mode: 'service_token', scopes: row.scopes };
}

/**
 * Authenticates an /api/* request via one of two paths:
 *   1. session cookie (phronesis UI)  → actor 'cam'
 *   2. Bearer service token (O&P specialists) → actor = role slug
 * Returns an AuthContext { actor, mode, scopes }. Throws AuthError on failure.
 */
export async function authenticateRequest(request, env) {
  const session = await validateSession(request, env);
  if (session.authenticated) {
    return { actor: 'cam', mode: 'session', scopes: null };
  }

  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const ctx = await validateServiceToken(authHeader.slice(7), env);
    if (ctx) return ctx;
  }

  throw new AuthError('No valid session or service token');
}

/**
 * Checks whether an AuthContext is authorised for a route prefix.
 * Session (Cam) has full access. Service tokens are limited to the
 * route prefixes in their scopes JSON array.
 */
export function checkScope(ctx, routePrefix) {
  if (ctx.mode === 'session') return true;
  let scopes;
  try {
    scopes = JSON.parse(ctx.scopes || '[]');
  } catch (_) {
    scopes = [];
  }
  return Array.isArray(scopes) && scopes.some((s) => routePrefix.startsWith(s));
}
