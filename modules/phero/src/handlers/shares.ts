import type { Env, ShareRow, CreateShareBody } from '../types.ts';
import { generateRandomSlug, validateCustomSlug } from '../lib/slug.ts';

const DEFAULT_EXPIRY_DAYS = 45;

export async function handleCreateShare(request: Request, env: Env): Promise<Response> {
  let body: CreateShareBody;
  try {
    body = await request.json() as CreateShareBody;
  } catch {
    return jsonError(400, 'invalid JSON body');
  }

  if (!body.source_module || !['energeia', 'aristeia'].includes(body.source_module)) {
    return jsonError(400, 'source_module must be energeia or aristeia');
  }
  if (!body.source_slug || typeof body.source_slug !== 'string') {
    return jsonError(400, 'source_slug is required');
  }

  // Resolve slug
  let slug: string;
  if (body.slug) {
    const validation = validateCustomSlug(body.slug);
    if (!validation.valid) return jsonError(400, validation.error ?? 'invalid slug');
    const existing = await env.PHERO_DB.prepare('SELECT slug FROM shares WHERE slug = ?')
      .bind(body.slug).first();
    if (existing) return jsonError(409, 'slug already in use');
    slug = body.slug;
  } else {
    slug = generateRandomSlug();
    while (await env.PHERO_DB.prepare('SELECT slug FROM shares WHERE slug = ?').bind(slug).first()) {
      slug = generateRandomSlug();
    }
  }

  // Snapshot mode: fetch upstream version tag
  let sourceVersion: string | null = null;
  if (body.snapshot_mode) {
    const base = body.source_module === 'energeia' ? env.ENERGEIA_BASE_URL : env.ARISTEIA_BASE_URL;
    const token = body.source_module === 'energeia' ? env.ENERGEIA_SERVICE_TOKEN : env.ARISTEIA_SERVICE_TOKEN;
    const path = body.source_module === 'energeia' ? 'papers' : 'publications';
    const meta = await fetch(`${base}/api/${path}/${body.source_slug}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!meta.ok) return jsonError(404, 'upstream document not found');
    const metaJson = await meta.json() as { data?: { source_version?: string; version?: string } };
    sourceVersion = metaJson.data?.source_version ?? metaJson.data?.version ?? null;
  }

  const expiresAt: string | null =
    body.expires_at !== undefined
      ? body.expires_at
      : new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const now = new Date().toISOString();

  await env.PHERO_DB.batch([
    env.PHERO_DB.prepare(
      `INSERT INTO shares
         (slug, source_module, source_slug, source_version, label, recipient_email, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      slug,
      body.source_module,
      body.source_slug,
      sourceVersion,
      body.label ?? null,
      body.recipient_email ?? null,
      expiresAt,
    ),
    env.PHERO_DB.prepare(
      `INSERT INTO audit_log (row_key, action, actor, snapshot) VALUES (?, 'CREATE', 'cam', ?)`,
    ).bind(slug, JSON.stringify({ ...body, source_version: sourceVersion })),
  ]);

  return new Response(
    JSON.stringify({
      slug,
      share_url: `https://phero.skeptou.com/${slug}`,
      source_module: body.source_module,
      source_slug: body.source_slug,
      label: body.label ?? null,
      source_version: sourceVersion,
      expires_at: expiresAt,
      created_at: now,
    }),
    { status: 201, headers: { 'Content-Type': 'application/json' } },
  );
}

export async function handleListShares(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const sourceModule = url.searchParams.get('source_module');
  const limitParam = parseInt(url.searchParams.get('limit') ?? '50', 10);
  const offsetParam = parseInt(url.searchParams.get('offset') ?? '0', 10);
  const limit = Math.min(Math.max(1, isNaN(limitParam) ? 50 : limitParam), 200);
  const offset = Math.max(0, isNaN(offsetParam) ? 0 : offsetParam);

  let query = 'SELECT * FROM shares';
  const params: (string | number)[] = [];

  if (sourceModule === 'energeia' || sourceModule === 'aristeia') {
    query += ' WHERE source_module = ?';
    params.push(sourceModule);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const result = await env.PHERO_DB.prepare(query).bind(...params).all<ShareRow>();

  return new Response(
    JSON.stringify({ rows: result.results ?? [], limit, offset }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

export async function handleRevokeShare(slug: string, env: Env): Promise<Response> {
  const share = await env.PHERO_DB.prepare('SELECT slug, revoked_at FROM shares WHERE slug = ?')
    .bind(slug).first<{ slug: string; revoked_at: string | null }>();

  if (!share) return jsonError(404, 'share not found');
  if (share.revoked_at) return jsonError(409, 'share already revoked');

  const now = new Date().toISOString();
  await env.PHERO_DB.batch([
    env.PHERO_DB.prepare('UPDATE shares SET revoked_at = ? WHERE slug = ?').bind(now, slug),
    env.PHERO_DB.prepare(
      `INSERT INTO audit_log (row_key, action, actor, snapshot) VALUES (?, 'REVOKE', 'cam', ?)`,
    ).bind(slug, JSON.stringify({ revoked_at: now })),
  ]);

  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}

export async function handleGetShareViews(
  slug: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const share = await env.PHERO_DB.prepare('SELECT slug FROM shares WHERE slug = ?')
    .bind(slug).first();
  if (!share) return jsonError(404, 'share not found');

  const url = new URL(request.url);
  const limitParam = parseInt(url.searchParams.get('limit') ?? '25', 10);
  const offsetParam = parseInt(url.searchParams.get('offset') ?? '0', 10);
  const eventType = url.searchParams.get('event_type');
  const limit = Math.min(Math.max(1, isNaN(limitParam) ? 25 : limitParam), 100);
  const offset = Math.max(0, isNaN(offsetParam) ? 0 : offsetParam);

  let query = 'SELECT * FROM share_views WHERE share_slug = ?';
  const params: (string | number)[] = [slug];

  if (eventType === 'view' || eventType === 'download') {
    query += ' AND event_type = ?';
    params.push(eventType);
  }

  const [viewsResult, totalResult] = await env.PHERO_DB.batch([
    env.PHERO_DB.prepare(query + ' ORDER BY occurred_at DESC LIMIT ? OFFSET ?')
      .bind(...params, limit, offset),
    env.PHERO_DB.prepare(
      `SELECT COUNT(*) as count FROM share_views WHERE share_slug = ?${eventType === 'view' || eventType === 'download' ? ' AND event_type = ?' : ''}`,
    ).bind(...(eventType === 'view' || eventType === 'download' ? [slug, eventType] : [slug])),
  ]);

  const total = (totalResult.results?.[0] as { count: number } | undefined)?.count ?? 0;

  return new Response(
    JSON.stringify({ slug, total, rows: viewsResult.results ?? [], limit, offset }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
