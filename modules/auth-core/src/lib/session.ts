export const SESSION_TTL_SLIDING_SEC = 30 * 24 * 3600;   // 30 days
export const SESSION_TTL_ABSOLUTE_SEC = 90 * 24 * 3600;  // 90 days
export const SESSION_RENEWAL_THRESHOLD_SEC = 15 * 24 * 3600; // 15 days

export function buildSessionCookie(
  cookieName: string,
  value: string,
  domain: string,
  maxAge: number,
): string {
  return [
    `${cookieName}=${value}`,
    `Domain=${domain}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ].join('; ');
}

export function clearSessionCookie(cookieName: string, domain: string): string {
  return [
    `${cookieName}=`,
    `Domain=${domain}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0',
  ].join('; ');
}

export function getCookieValue(request: Request, cookieName: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    if (key === cookieName) return trimmed.slice(eqIdx + 1);
  }
  return null;
}

export function generateJti(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Returns how many seconds remain on the sliding window from a given Set-Cookie Max-Age.
// We infer this from iat vs now: remaining = (iat + sliding_ttl) - now.
export function slidingSecondsRemaining(iat: number): number {
  const expiresAt = iat + SESSION_TTL_SLIDING_SEC;
  return Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
}
