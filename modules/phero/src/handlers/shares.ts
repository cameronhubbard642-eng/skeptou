import type { Env, CreateShareBody, ShareRow } from '../types';
import { requireCamSession } from '../lib/auth';
import { generateRandomSlug, validateCustomSlug } from '../lib/slug';

export async function handlePostShares(request: Request, env: Env): Promise<Response> {
  const authResp = await requireCamSession(request, env);
  if (authResp) return authResp;

  let body: CreateShareBody;
  try {
    body = (await request.json()) as CreateShareBody;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (!body.source_module || !['energeia', 'aristeia'].includes(body.source_module)) {
    return Response.json({ error: 'source_module must be energeia or aristeia' }, { status: 400 });
  }
  if (!body.source_slug || typeof body.source_slug !== 'string' || !body.source_slug.trim()) {
    return Response.json({ error: 'source_slug is required' }, { status: 400 });
  }

  // Resolve slug: custom if provided and valid, else random
  let slug: string;
  if (body.slug) {
    const v = validateCustomSlug(body.slug);
    if (!v.valid) return Response.json({ error: v.error }, { status: 400 });
    const existing = await env.PHERO_DB.prepare('SELECT slug FROM shares WHERE slug = ?')
      .bind(body.slug)
      .first();
    if (existing) return Response.json({ error: 'slug already in use' }, { status: 409 });
    slug = body.slug;
  } else {
    slug = generateRandomSlug();
    // Collision check (astronomically rare with 128-bit tokens but correct)
    while (
      await env.PHERO_DB.prepare('SELECT slug FROM shares WHERE slug = ?').bind(slug).first()
    ) {
      slug = generateRandomSlug();
    }
  }

  // Snapshot mode: fetch current version from upstream
  let sourceVersion: string | null = null;
  if (body.snapshot_mode) {
    const base =
      body.source_module === 'energeia' ? env.ENERGEIA_BASE_URL : env.ARISTEIA_BASE_URL;
    const token =
      body.source_module === 'energeia'
        ? env.ENERGEIA_SERVICE_TOKEN
        : env.ARISTEIA_SERVICE_TOKEN;
    const path = body.source_module === 'energeia' ? 'papers' : 'publications';
    const meta = await fetch(`${base}/api/${path}/${body.source_slug}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!meta.ok) {
      return Response.json({ error: 'upstream document not found' }, { status: 404 });
    }
    const metaJson = (await meta.json()) as {
      data: { source_version?: string; version?: string };
    };
    sourceVersion = metaJson.data.source_version ?? metaJson.data.version ?? null;
  }

  const now = new Date().toISOString();
  const expiresAt =
    body.expires_at !== undefined
      ? body.expires_at
      : new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString();

  await env.PHERO_DB.batch([
    env.PHERO_DB.prepare(
      `INSERT INTO shares (slug, source_module, source_slug, source_version, label, recipient_email, expires_at)
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
    ).bind(slug, JSON.stringify({ ...body, source_version: sourceVersion, resolved_slug: slug })),
  ]);

  return Response.json(
    {
      slug,
      share_url: `https://phero.skeptou.com/${slug}`,
      source_module: body.source_module,
      source_slug: body.source_slug,
      label: body.label ?? null,
      source_version: sourceVersion,
      expires_at: expiresAt,
      created_at: now,
    },
    { status: 201 },
  );
}

export async function handleGetShares(request: Request, env: Env): Promise<Response> {
  const authResp = await requireCamSession(request, env);
  if (authResp) return authResp;

  const url = new URL(request.url);
  const sourceModule = url.searchParams.get('source_module');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

  const whereClauses: string[] = [];
  const params: unknown[] = [];

  if (sourceModule && ['energeia', 'aristeia'].includes(sourceModule)) {
    whereClauses.push('source_module = ?');
    params.push(sourceModule);
  }

  const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const query = `SELECT slug, source_module, source_slug, source_version, label, recipient_email,
                        expires_at, view_count, last_viewed_at, created_at, revoked_at
                 FROM shares ${where}
                 ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const result = await env.PHERO_DB.prepare(query)
    .bind(...params)
    .all<ShareRow>();

  return Response.json({ shares: result.results ?? [] });
}

export async function handleDeleteShare(
  slug: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const authResp = await requireCamSession(request, env);
  if (authResp) return authResp;

  const existing = await env.PHERO_DB.prepare('SELECT slug FROM shares WHERE slug = ?')
    .bind(slug)
    .first();
  if (!existing) return Response.json({ error: 'share not found' }, { status: 404 });

  const now = new Date().toISOString();
  await env.PHERO_DB.batch([
    env.PHERO_DB.prepare('UPDATE shares SET revoked_at = ? WHERE slug = ?').bind(now, slug),
    env.PHERO_DB.prepare(
      `INSERT INTO audit_log (row_key, action, actor, snapshot) VALUES (?, 'REVOKE', 'cam', ?)`,
    ).bind(slug, JSON.stringify({ revoked_at: now })),
  ]);

  return Response.json({ revoked: true });
}

export async function handleGetShareViews(
  slug: string,
  request: Request,
  env: Env,
): Promise<Response> {
  const authResp = await requireCamSession(request, env);
  if (authResp) return authResp;

  const shareExists = await env.PHERO_DB.prepare('SELECT slug FROM shares WHERE slug = ?')
    .bind(slug)
    .first();
  if (!shareExists) return Response.json({ error: 'share not found' }, { status: 404 });

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '25', 10), 100);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
  const eventType = url.searchParams.get('event_type');

  const params: unknown[] = [slug];
  let viewSql =
    'SELECT id, event_type, occurred_at, cf_country, referrer, user_agent FROM share_views WHERE share_slug = ?';
  const countParams: unknown[] = [slug];
  let countSql = 'SELECT COUNT(*) as total FROM share_views WHERE share_slug = ?';

  if (eventType && ['view', 'download'].includes(eventType)) {
    viewSql += ' AND event_type = ?';
    countSql += ' AND event_type = ?';
    params.push(eventType);
    countParams.push(eventType);
  }

  viewSql += ' ORDER BY occurred_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const [viewsResult, countResult] = await env.PHERO_DB.batch([
    env.PHERO_DB.prepare(viewSql).bind(...params),
    env.PHERO_DB.prepare(countSql).bind(...countParams),
  ]);

  const total =
    ((countResult.results?.[0] as { total?: number } | undefined)?.total) ?? 0;

  return Response.json({ slug, total, rows: viewsResult.results ?? [] });
}
