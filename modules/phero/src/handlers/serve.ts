import type { Env, ShareRow } from '../types';
import { getCookieValue } from '../lib/auth';
import { signShareCookie, validateShareCookie } from '../lib/cookie';

import viewerHtml from '../../templates/viewer.html';
import expiredHtml from '../../templates/expired.html';
import revokedHtml from '../../templates/revoked.html';

async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function html(content: string, status = 200): Response {
  return new Response(content, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/** GET /<slug> — serve viewer HTML (or expired/revoked page) */
export async function handleViewerPage(slug: string, env: Env): Promise<Response> {
  const share = await env.PHERO_DB.prepare('SELECT * FROM shares WHERE slug = ?')
    .bind(slug)
    .first<ShareRow>();

  if (!share) return html(expiredHtml, 404);
  if (share.revoked_at) return html(revokedHtml, 410);
  if (share.expires_at && share.expires_at < new Date().toISOString()) {
    return html(expiredHtml, 404);
  }

  const title = share.label ?? share.source_slug;
  const expiresLine = share.expires_at
    ? `<p class="expires">This link expires on ${new Date(share.expires_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}.</p>`
    : '';

  const page = viewerHtml
    .replace(/{{SLUG}}/g, slug)
    .replace(/{{TITLE}}/g, escapeHtml(title))
    .replace(/{{EXPIRES_LINE}}/g, expiresLine);

  return html(page);
}

/** GET /api/share/:slug — public document serve with cookie + view tracking */
export async function handleServeShare(
  slug: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Look up share (need revoked state separate from active_shares view)
  const share = await env.PHERO_DB.prepare('SELECT * FROM shares WHERE slug = ?')
    .bind(slug)
    .first<ShareRow>();

  if (!share) return html(expiredHtml, 404);
  if (share.revoked_at) return html(revokedHtml, 410);
  if (share.expires_at && share.expires_at < new Date().toISOString()) {
    return html(expiredHtml, 404);
  }

  // Check scoped session cookie
  const cookieName = `phero-session-${slug}`;
  const existingCookie = getCookieValue(request, cookieName);
  const cookieValid =
    existingCookie !== null &&
    (await validateShareCookie(existingCookie, slug, env.COOKIE_SIGNING_KEY));

  // Fetch document from upstream
  const base =
    share.source_module === 'energeia' ? env.ENERGEIA_BASE_URL : env.ARISTEIA_BASE_URL;
  const svcTok =
    share.source_module === 'energeia'
      ? env.ENERGEIA_SERVICE_TOKEN
      : env.ARISTEIA_SERVICE_TOKEN;
  const path = share.source_module === 'energeia' ? 'papers' : 'publications';
  const vParam = share.source_version
    ? `?version=${encodeURIComponent(share.source_version)}`
    : '';

  const upstream = await fetch(
    `${base}/api/${path}/${encodeURIComponent(share.source_slug)}/content${vParam}`,
    { headers: { Authorization: `Bearer ${svcTok}` } },
  );

  if (!upstream.ok) {
    return Response.json({ error: 'upstream document unavailable' }, { status: 502 });
  }

  // Non-blocking analytics: increment view_count + insert share_views row
  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  const now = new Date().toISOString();
  ctx.waitUntil(
    env.PHERO_DB.batch([
      env.PHERO_DB.prepare(
        'UPDATE shares SET view_count = view_count + 1, last_viewed_at = ? WHERE slug = ?',
      ).bind(now, slug),
      env.PHERO_DB.prepare(
        `INSERT INTO share_views (share_slug, event_type, ip_hash, cf_country, user_agent, referrer)
         VALUES (?, 'view', ?, ?, ?, ?)`,
      ).bind(
        slug,
        await sha256(ip),
        request.headers.get('CF-IPCountry') ?? 'XX',
        (request.headers.get('User-Agent') ?? '').slice(0, 256),
        (request.headers.get('Referer') ?? '').slice(0, 256),
      ),
    ]),
  );

  // Build response headers
  const contentType = upstream.headers.get('Content-Type') ?? 'application/octet-stream';
  const ext = contentType.includes('pdf') ? 'pdf' : contentType.includes('markdown') ? 'md' : 'bin';
  const filename = `${share.source_slug}.${ext}`;

  const respHeaders: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  };

  // Issue or refresh 7-day scoped cookie if absent/invalid
  if (!cookieValid) {
    const ttlDays = parseInt(env.SHARE_COOKIE_TTL_DAYS ?? '7', 10);
    const cookieValue = await signShareCookie(slug, env.COOKIE_SIGNING_KEY);
    respHeaders[
      'Set-Cookie'
    ] = `${cookieName}=${cookieValue}; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttlDays * 86400}; Path=/${slug}`;
  }

  return new Response(upstream.body, { headers: respHeaders });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
