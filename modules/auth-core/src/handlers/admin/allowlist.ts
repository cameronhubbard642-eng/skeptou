import type { Env } from '../../types';
import { requireAdmin } from '../../middleware/requireAdmin';
import {
  listAllowlistEntries,
  putAllowlistEntry,
  deleteAllowlistEntry,
  normalizeEmail,
} from '../../lib/allowlist';
import { appendAudit } from '../../lib/audit';

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

export async function handleAllowlistList(request: Request, env: Env): Promise<Response> {
  const guard = await requireAdmin(request, env);
  if (guard) return guard;

  const entries = await listAllowlistEntries(env.AUTH_KV);
  return json({ entries });
}

export async function handleAllowlistPut(request: Request, env: Env): Promise<Response> {
  const guard = await requireAdmin(request, env);
  if (guard) return guard;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  if (typeof body !== 'object' || body === null) return json({ error: 'invalid_body' }, 400);
  const { email, note, active } = body as Record<string, unknown>;

  if (typeof email !== 'string' || !isValidEmail(email)) {
    return json({ error: 'invalid_email' }, 400);
  }

  const normalizedEmail = normalizeEmail(email);
  const resolvedActive = typeof active === 'boolean' ? active : true;
  const resolvedNote = typeof note === 'string' ? note : undefined;

  const { existed } = await putAllowlistEntry(
    env.AUTH_KV,
    normalizedEmail,
    resolvedNote,
    resolvedActive,
  );

  await appendAudit(env, {
    event: existed ? 'ADMIN_ALLOWLIST_UPDATED' : 'ADMIN_ALLOWLIST_CREATED',
    meta: { email: normalizedEmail },
  });

  return json({ ok: true, email: normalizedEmail, action: existed ? 'updated' : 'created' });
}

export async function handleAllowlistDelete(
  request: Request,
  env: Env,
  emailParam: string,
): Promise<Response> {
  const guard = await requireAdmin(request, env);
  if (guard) return guard;

  const email = decodeURIComponent(emailParam);
  if (!isValidEmail(email)) return json({ error: 'invalid_email' }, 400);

  const deleted = await deleteAllowlistEntry(env.AUTH_KV, email);
  if (!deleted) return json({ ok: false, reason: 'not_found' }, 404);

  await appendAudit(env, {
    event: 'ADMIN_ALLOWLIST_DELETED',
    meta: { email: normalizeEmail(email) },
  });

  return json({ ok: true, email: normalizeEmail(email) });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
