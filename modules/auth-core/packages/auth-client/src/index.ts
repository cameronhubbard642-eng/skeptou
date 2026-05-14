export type { SessionInfo, AuthClientConfig } from './types';
import type { SessionInfo, AuthClientConfig, SessionPayload } from './types';

// ── HMAC helpers (duplicated from auth Worker; auth-client has no shared dep) ──

function base64urlEncode(input: string | ArrayBuffer | Uint8Array): string {
  let bytes: Uint8Array;
  if (typeof input === 'string') {
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    bytes = input;
  }
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlDecode(input: string): ArrayBuffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const base64 = padded + '='.repeat(padLen);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer as ArrayBuffer;
}

async function verifyPayload(
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
    payload = JSON.parse(new TextDecoder().decode(base64urlDecode(data))) as SessionPayload;
  } catch {
    return null;
  }

  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function getCookieValue(request: Request, cookieName: string): string | null {
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

// ── AuthRedirectResponse ──────────────────────────────────────────────────────

export class AuthRedirectResponse extends Response {
  constructor(authBaseUrl: string, next: string) {
    const url = `${authBaseUrl}/login?next=${encodeURIComponent(next)}`;
    super(null, {
      status: 302,
      headers: { Location: url },
    });
  }
}

// ── validateSession ───────────────────────────────────────────────────────────

/**
 * Validates the session cookie from an incoming Request.
 * Pure HMAC validation — no network call.
 * Returns null if cookie is absent, invalid, or expired.
 */
export async function validateSession(
  request: Request,
  config: AuthClientConfig,
): Promise<SessionInfo | null> {
  const cookieVal = getCookieValue(request, config.cookieName);
  if (!cookieVal) return null;

  const payload = await verifyPayload(cookieVal, config.hmacSecret);
  if (!payload) return null;

  return {
    sub: payload.sub,
    rol: payload.rol,
    iat: payload.iat,
    exp: payload.exp,
    jti: payload.jti,
  };
}

// ── requireAuth ───────────────────────────────────────────────────────────────

export interface RequireAuthResult {
  session: SessionInfo;
  response?: Response; // present if the sliding window was renewed
}

/**
 * Validates the session and throws AuthRedirectResponse if invalid.
 * With { refresh: true }, proactively calls the auth Worker's /session endpoint
 * to renew the sliding window when under the threshold.
 *
 * Usage:
 *   const { session, response } = await requireAuth(request, config, { refresh: true });
 *   // If renewal happened, forward Set-Cookie from `response` to the client.
 */
export async function requireAuth(
  request: Request,
  config: AuthClientConfig,
  options?: { refresh?: boolean },
): Promise<RequireAuthResult> {
  const session = await validateSession(request, config);
  if (!session) {
    throw new AuthRedirectResponse(config.authBaseUrl, request.url);
  }

  if (!options?.refresh) {
    return { session };
  }

  // Proactive renewal: call the auth Worker /session endpoint to refresh
  // the sliding window if under threshold. We forward the original Cookie header.
  const thresholdDays = config.refreshThresholdDays ?? 15;
  const thresholdSec = thresholdDays * 24 * 3600;
  const now = Math.floor(Date.now() / 1000);
  const slidingExpiry = session.iat + 30 * 24 * 3600;
  const remaining = slidingExpiry - now;

  if (remaining >= thresholdSec) {
    return { session };
  }

  // Under threshold — call /session to get a renewed cookie
  const authSessionUrl = `${config.authBaseUrl}/session`;
  const sessionRes = await fetch(authSessionUrl, {
    headers: { Cookie: request.headers.get('Cookie') ?? '' },
    credentials: 'include',
  });

  if (!sessionRes.ok) {
    // Renewal failed — session is still valid locally; proceed without renewing
    return { session };
  }

  const setCookie = sessionRes.headers.get('Set-Cookie');
  if (!setCookie) {
    return { session };
  }

  // Return a minimal Response carrying the Set-Cookie so the sub-app can forward it
  const renewalResponse = new Response(null, {
    headers: { 'Set-Cookie': setCookie },
  });

  return { session, response: renewalResponse };
}
