import type { Env } from './types';
import {
  handlePostShares,
  handleGetShares,
  handleDeleteShare,
  handleGetShareViews,
} from './handlers/shares';
import { handleViewerPage, handleServeShare } from './handlers/serve';

import manageHtml from '../templates/manage.html';

function html(content: string, status = 200): Response {
  return new Response(content, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = url.pathname === '/' ? '/' : url.pathname.replace(/\/$/, '');

    // ── Redirect root to management UI ─────────────────────────────
    if (path === '/') {
      return Response.redirect(`${url.origin}/manage`, 302);
    }

    // ── Cam management UI ───────────────────────────────────────────
    if (path === '/manage' || path.startsWith('/manage/')) {
      if (method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
      return html(manageHtml);
    }

    // ── Management API — Cam session required ───────────────────────

    // POST /api/shares — create share
    if (path === '/api/shares' && method === 'POST') {
      return handlePostShares(request, env);
    }

    // GET /api/shares — list shares
    if (path === '/api/shares' && method === 'GET') {
      return handleGetShares(request, env);
    }

    // DELETE /api/shares/:slug — revoke share
    const deleteShareMatch = path.match(/^\/api\/shares\/([^/]+)$/);
    if (deleteShareMatch && method === 'DELETE') {
      return handleDeleteShare(deleteShareMatch[1], request, env);
    }

    // GET /api/shares/:slug/views — view history drill-down
    const viewsMatch = path.match(/^\/api\/shares\/([^/]+)\/views$/);
    if (viewsMatch && method === 'GET') {
      return handleGetShareViews(viewsMatch[1], request, env);
    }

    // ── Public share API ────────────────────────────────────────────

    // GET /api/share/:slug — serve document (public; sets 7-day cookie; logs view)
    const serveMatch = path.match(/^\/api\/share\/([^/]+)$/);
    if (serveMatch && method === 'GET') {
      return handleServeShare(serveMatch[1], request, env, ctx);
    }

    // ── Public viewer page ──────────────────────────────────────────

    // GET /<slug> — viewer HTML (any single-segment path not matched above)
    const slugMatch = path.match(/^\/([^/]+)$/);
    if (slugMatch && method === 'GET') {
      return handleViewerPage(slugMatch[1], env);
    }

    return new Response('Not Found', { status: 404 });
  },
};
