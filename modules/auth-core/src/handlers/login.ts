import type { Env } from '../types';
import { normalizeEmail, getAllowlistEntry } from '../lib/allowlist';
import { generateToken, storeToken } from '../lib/token';
import { sendMagicLink } from '../lib/resend';
import { consumeBucket } from '../lib/ratelimit';
import { appendAudit } from '../lib/audit';
import { renderTemplate, getCookieName } from '../lib/brand';
import { getCookieValue } from '../lib/session';
import { verifyPayload } from '../lib/hmac';

// Simple RFC 5321-compatible email syntax check (no DNS lookup).
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

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

// GET / or GET /login — serve login page (redirect to BRAND_URL if already authed)
export async function serveLoginPage(
  request: Request,
  env: Env,
  templates: Record<string, string>,
): Promise<Response> {
  const cookieName = getCookieName(env.DEPLOYMENT);
  const cookieVal = getCookieValue(request, cookieName);
  if (cookieVal) {
    const payload = await verifyPayload(cookieVal, env.HMAC_SECRET);
    if (payload) {
      return Response.redirect(env.BRAND_URL, 302);
    }
  }
  const url = new URL(request.url);
  const next = url.searchParams.get('next') ?? '';
  const html = renderTemplate(templates['login.html'] ?? '', {
    BRAND_NAME: env.BRAND_NAME,
    BRAND_URL: env.BRAND_URL,
    NEXT: next,
    ERROR: '',
  });
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// POST /login
export async function handleLogin(
  request: Request,
  env: Env,
  templates: Record<string, string>,
): Promise<Response> {
  const contentType = request.headers.get('Content-Type') ?? '';
  const isJson = contentType.includes('application/json');

  let email: string;
  let next: string | null = null;

  if (isJson) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'invalid_json' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (
      typeof body !== 'object' ||
      body === null ||
      typeof (body as Record<string, unknown>).email !== 'string'
    ) {
      return new Response(JSON.stringify({ error: 'email_required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    email = (body as { email: string }).email;
    next = (body as { next?: string }).next ?? null;
  } else {
    // Form-encoded submission
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    email = formData.get('email')?.toString() ?? '';
    next = formData.get('next')?.toString() ?? null;
  }

  if (!isValidEmail(email)) {
    if (isJson) {
      return new Response(JSON.stringify({ error: 'invalid_email' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const html = renderTemplate(templates['login.html'] ?? '', {
      BRAND_NAME: env.BRAND_NAME,
      BRAND_URL: env.BRAND_URL,
      NEXT: next ?? '',
      ERROR: 'Please enter a valid email address.',
    });
    return new Response(html, {
      status: 400,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  const normalizedEmail = normalizeEmail(email);
  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  const ua = request.headers.get('User-Agent') ?? undefined;

  // Rate limit: per-email and per-IP
  const emailCapacity = parseInt(env.RATE_LIMIT_EMAIL_CAPACITY ?? '5', 10);
  const ipCapacity = parseInt(env.RATE_LIMIT_IP_CAPACITY ?? '20', 10);

  const [emailRl, ipRl] = await Promise.all([
    consumeBucket(env.AUTH_KV, `rl:login:email:${normalizedEmail}`, emailCapacity, 1 / 600, 1),
    consumeBucket(env.AUTH_KV, `rl:login:ip:${ip}`, ipCapacity, 1 / 60, 1),
  ]);

  if (!emailRl.allowed || !ipRl.allowed) {
    const retryAfter = Math.max(emailRl.retryAfter ?? 0, ipRl.retryAfter ?? 0);
    await appendAudit(env, { event: 'RATE_LIMIT_HIT', sub: normalizedEmail, ip, ua, meta: { retryAfter } });
    if (isJson) {
      return new Response(JSON.stringify({ error: 'rate_limit_exceeded', retry_after: retryAfter }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) },
      });
    }
    const html = renderTemplate(templates['login.html'] ?? '', {
      BRAND_NAME: env.BRAND_NAME,
      BRAND_URL: env.BRAND_URL,
      NEXT: next ?? '',
      ERROR: `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minute${retryAfter > 60 ? 's' : ''}.`,
    });
    return new Response(html, {
      status: 429,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': String(retryAfter) },
    });
  }

  // Allowlist check — silent fail to prevent enumeration
  const entry = await getAllowlistEntry(env.AUTH_KV, normalizedEmail);
  if (!entry || !entry.active) {
    await appendAudit(env, { event: 'LOGIN_ATTEMPT_BLOCKED', sub: normalizedEmail, ip, ua });
    // Respond identically to success (no enumeration)
    if (isJson) {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return Response.redirect(new URL('/check-email', request.url).toString(), 302);
  }

  // Generate and store magic token
  const token = generateToken();
  await storeToken(env.AUTH_KV, token, normalizedEmail);

  // Send magic link email
  const validatedNext = validateNextUrl(next, env.COOKIE_DOMAIN, env.BRAND_URL);
  try {
    await sendMagicLink(normalizedEmail, token, {
      brandName: env.BRAND_NAME,
      brandUrl: env.BRAND_URL,
      authBaseUrl: new URL(request.url).origin,
      resendFrom: env.RESEND_FROM,
      resendApiKey: env.RESEND_API_KEY,
    }, validatedNext !== env.BRAND_URL ? validatedNext : undefined);
  } catch {
    // Don't expose Resend failures to the client
  }

  await appendAudit(env, { event: 'MAGIC_LINK_ISSUED', sub: normalizedEmail, ip, ua });

  if (isJson) {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return Response.redirect(new URL('/check-email', request.url).toString(), 302);
}
