import type { Env } from './types';
import { serveLoginPage, handleLogin } from './handlers/login';
import { handleVerify } from './handlers/verify';
import { handleLogout } from './handlers/logout';
import { handleSession } from './handlers/session';
import {
  handleAllowlistList,
  handleAllowlistPut,
  handleAllowlistDelete,
} from './handlers/admin/allowlist';
import { handleAudit } from './handlers/admin/audit';
import { corsHeaders } from './middleware/cors';
import { renderTemplate } from './lib/brand';

import loginHtml from '../templates/login.html';
import checkEmailHtml from '../templates/check-email.html';
import verifySuccessHtml from '../templates/verify-success.html';
import verifyErrorHtml from '../templates/verify-error.html';
import logoutHtml from '../templates/logout.html';

const TEMPLATES: Record<string, string> = {
  'login.html': loginHtml,
  'check-email.html': checkEmailHtml,
  'verify-success.html': verifySuccessHtml,
  'verify-error.html': verifyErrorHtml,
  'logout.html': logoutHtml,
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    // Normalize path: strip trailing slash except root
    const path = url.pathname === '/' ? '/' : url.pathname.replace(/\/$/, '');

    // CORS preflight
    if (method === 'OPTIONS') {
      const cors = corsHeaders(request, env.COOKIE_DOMAIN);
      if (Object.keys(cors).length > 0) {
        return new Response(null, { status: 204, headers: cors });
      }
      return new Response(null, { status: 204 });
    }

    // ── Login page ────────────────────────────────────────────────
    if ((path === '/' || path === '/login') && method === 'GET') {
      return serveLoginPage(request, env, TEMPLATES);
    }

    if (path === '/login' && method === 'POST') {
      return handleLogin(request, env, TEMPLATES);
    }

    // ── Check-email confirmation page ────────────────────────────
    if (path === '/check-email' && method === 'GET') {
      const html = renderTemplate(checkEmailHtml, {
        BRAND_NAME: env.BRAND_NAME,
        BRAND_URL: env.BRAND_URL,
      });
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // ── Magic link verification ───────────────────────────────────
    if (path === '/verify' && method === 'GET') {
      return handleVerify(request, env, TEMPLATES);
    }

    // ── Session API ───────────────────────────────────────────────
    if (path === '/session' && method === 'GET') {
      return handleSession(request, env);
    }

    // ── Logout ────────────────────────────────────────────────────
    if (path === '/logout' && method === 'GET') {
      const html = renderTemplate(logoutHtml, {
        BRAND_NAME: env.BRAND_NAME,
        BRAND_URL: env.BRAND_URL,
      });
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (path === '/logout' && method === 'POST') {
      return handleLogout(request, env);
    }

    // ── Admin: allowlist ──────────────────────────────────────────
    if (path === '/admin/allowlist') {
      if (method === 'GET') return handleAllowlistList(request, env);
      if (method === 'PUT') return handleAllowlistPut(request, env);
    }

    if (path.startsWith('/admin/allowlist/') && method === 'DELETE') {
      const emailParam = path.slice('/admin/allowlist/'.length);
      return handleAllowlistDelete(request, env, emailParam);
    }

    // ── Admin: audit log ─────────────────────────────────────────
    if (path === '/admin/audit' && method === 'GET') {
      return handleAudit(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },
};
