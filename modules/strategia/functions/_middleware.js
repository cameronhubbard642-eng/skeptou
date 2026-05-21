import { requireSession } from './_shared/auth.js';

export async function onRequest(ctx) {
  const url = new URL(ctx.request.url);
  if (url.pathname.startsWith('/api/')) {
    return ctx.next();
  }
  const authRedirect = await requireSession(ctx.request, ctx.env);
  if (authRedirect) return authRedirect;
  return ctx.next();
}
