import type { Env } from '../../types';
import { requireAdmin } from '../../middleware/requireAdmin';
import { queryAudit } from '../../lib/audit';

export async function handleAudit(request: Request, env: Env): Promise<Response> {
  const guard = await requireAdmin(request, env);
  if (guard) return guard;

  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);
  const before = url.searchParams.get('before') ?? undefined;
  const email = url.searchParams.get('email') ?? undefined;

  const { entries, count } = await queryAudit(env, { limit, before, email });

  return new Response(JSON.stringify({ entries, count }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
