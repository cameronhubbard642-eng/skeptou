export function getCookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    if (trimmed.slice(0, eqIdx) === name) return trimmed.slice(eqIdx + 1);
  }
  return null;
}

export async function signShareCookie(slug: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(slug));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function validateShareCookie(
  cookieValue: string,
  slug: string,
  key: string,
): Promise<boolean> {
  const expected = await signShareCookie(slug, key);
  if (cookieValue.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < cookieValue.length; i++) {
    diff |= cookieValue.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export function buildShareCookieHeader(slug: string, value: string, maxAgeSec: number): string {
  return [
    `phero-session-${slug}=${value}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
    `Path=/${slug}`,
  ].join('; ');
}
