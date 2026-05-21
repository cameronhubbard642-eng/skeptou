import type { Env, ShareRow } from '../types.ts';
import { getCookieValue, signShareCookie, validateShareCookie, buildShareCookieHeader } from '../lib/cookie.ts';
import { sha256 } from '../lib/sha256.ts';

import expiredHtml from '../../templates/expired.html';
import revokedHtml from '../../templates/revoked.html';
import viewerHtml from '../../templates/viewer.html';

export async function handleServeViewer(slug: string, env: Env): Promise<Response> {
  const share = await env.PHERO_DB.prepare('SELECT * FROM shares WHERE slug = ?')
    .bind(slug).first<ShareRow>();

  if (!share) {
    return new Response(expiredHtml, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  if (share.revoked_at) {
    return new Response(revokedHtml, { status: 410, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const now = new Date().toISOString();
  if (share.expires_at && share.expires_at <= now) {
    return new Response(expiredHtml, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const label = share.label ?? share.source_slug;
  const expiryLine = share.expires_at
    ? `This link expires on ${new Date(share.expires_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}.`
    : '';

  const html = viewerHtml
    .replace(/{{SLUG}}/g, slug)
    .replace(/{{LABEL}}/g, escapeHtml(label))
    .replace(/{{EXPIRY_LINE}}/g, escapeHtml(expiryLine));

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export async function handleServeShare(
  slug: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const share = await env.PHERO_DB.prepare('SELECT * FROM shares WHERE slug = ?')
    .bind(slug).first<ShareRow>();

  if (!share) {
    return new Response(expiredHtml, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  if (share.revoked_at) {
    return new Response(revokedHtml, { status: 410, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  const now = new Date().toISOString();
  if (share.expires_at && share.expires_at <= now) {
    return new Response(expiredHtml, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  // Cookie management
  const cookieName = `phero-session-${slug}`;
  const existingCookie = getCookieValue(request, cookieName);
  let newCookieHeader: string | null = null;

  if (!existingCookie || !(await validateShareCookie(existingCookie, slug, env.COOKIE_SIGNING_KEY))) {
    const cookieValue = await signShareCookie(slug, env.COOKIE_SIGNING_KEY);
    const ttlDays = parseInt(env.SHARE_COOKIE_TTL_DAYS, 10) || 7;
    newCookieHeader = buildShareCookieHeader(slug, cookieValue, ttlDays * 86400);
  }

  // Fetch from upstream
  const base = share.source_module === 'energeia' ? env.ENERGEIA_BASE_URL : env.ARISTEIA_BASE_URL;
  const svcToken = share.source_module === 'energeia' ? env.ENERGEIA_SERVICE_TOKEN : env.ARISTEIA_SERVICE_TOKEN;
  const path = share.source_module === 'energeia' ? 'papers' : 'publications';
  const vParam = share.source_version ? `?version=${encodeURIComponent(share.source_version)}` : '';

  const upstream = await fetch(`${base}/api/${path}/${share.source_slug}/content${vParam}`, {
    headers: { Authorization: `Bearer ${svcToken}` },
  });

  if (!upstream.ok) {
    return new Response(JSON.stringify({ error: 'upstream document unavailable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const contentType = upstream.headers.get('Content-Type') ?? 'application/octet-stream';
  const ext = contentType.includes('pdf') ? 'pdf'
    : contentType.includes('markdown') ? 'md'
    : 'bin';
  const filename = `${share.source_slug}.${ext}`;

  // Non-blocking analytics
  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  const country = request.headers.get('CF-IPCountry') ?? 'XX';
  const ua = (request.headers.get('User-Agent') ?? '').slice(0, 256);
  const referrer = (request.headers.get('Referer') ?? '').slice(0, 256);
  const occurredAt = new Date().toISOString();

  ctx.waitUntil(
    env.PHERO_DB.batch([
      env.PHERO_DB.prepare(
        'UPDATE shares SET view_count = view_count + 1, last_viewed_at = ? WHERE slug = ?',
      ).bind(occurredAt, slug),
      env.PHERO_DB.prepare(
        `INSERT INTO share_views (share_slug, event_type, ip_hash, cf_country, user_agent, referrer)
         VALUES (?, 'view', ?, ?, ?, ?)`,
      ).bind(slug, await sha256(ip), country, ua, referrer),
    ]),
  );

  const responseHeaders: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (newCookieHeader) responseHeaders['Set-Cookie'] = newCookieHeader;

  return new Response(upstream.body, { headers: responseHeaders });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
