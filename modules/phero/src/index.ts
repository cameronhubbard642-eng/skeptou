import type { Env } from './types.ts';
import { requireCamSession } from './handlers/auth.ts';
import {
  handleCreateShare,
  handleListShares,
  handleRevokeShare,
  handleGetShareViews,
} from './handlers/shares.ts';
import { handleServeViewer, handleServeShare } from './handlers/serve.ts';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = url.pathname === '/' ? '/' : url.pathname.replace(/\/$/, '');

    // ── Cam management API (auth required) ───────────────────────────────────

    if (path === '/api/shares' && method === 'POST') {
      const authErr = await requireCamSession(request, env);
      if (authErr) return authErr;
      return handleCreateShare(request, env);
    }

    if (path === '/api/shares' && method === 'GET') {
      const authErr = await requireCamSession(request, env);
      if (authErr) return authErr;
      return handleListShares(request, env);
    }

    // DELETE /api/shares/:slug
    if (path.startsWith('/api/shares/') && method === 'DELETE') {
      const authErr = await requireCamSession(request, env);
      if (authErr) return authErr;
      const slug = path.slice('/api/shares/'.length);
      if (!slug) return jsonError(400, 'slug required');
      return handleRevokeShare(slug, env);
    }

    // GET /api/shares/:slug/views
    if (path.startsWith('/api/shares/') && path.endsWith('/views') && method === 'GET') {
      const authErr = await requireCamSession(request, env);
      if (authErr) return authErr;
      const slug = path.slice('/api/shares/'.length, -'/views'.length);
      if (!slug) return jsonError(400, 'slug required');
      return handleGetShareViews(slug, request, env);
    }

    // ── Public share endpoints ────────────────────────────────────────────────

    // GET /api/share/:slug -- serves raw document bytes; PDF.js in viewer calls this
    if (path.startsWith('/api/share/') && method === 'GET') {
      const slug = path.slice('/api/share/'.length);
      if (!slug) return jsonError(404, 'not found');
      return handleServeShare(slug, request, env, ctx);
    }

    // ── Viewer page: GET /:slug ───────────────────────────────────────────────
    // Matches any single-segment path that doesn't start with /api/, /manage, /static
    const slugMatch = path.match(/^\/([^/]+)$/);
    if (slugMatch && method === 'GET') {
      const segment = slugMatch[1];
      if (!['api', 'manage', 'admin', 'static', 'assets', 'favicon.ico', 'robots.txt'].includes(segment)) {
        return handleServeViewer(segment, env);
      }
    }

    // Root: redirect to manage
    if (path === '/' && method === 'GET') {
      return Response.redirect('https://phero.skeptou.com/manage/', 302);
    }

    return jsonError(404, 'not found');
  },
};

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
