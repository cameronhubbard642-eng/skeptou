# specs/brief-phero-phase1.md — Phero Engineer Brief, Phase 1

**Version:** rev 2
**Status:** ready for implementation
**Author:** Lead Dev / Architect — Sképtou
**Date:** 2026-05-17
**Spec:** `specs/phero.md` rev 4
**Phase:** 1 of 3
**Tier:** Sonnet

---

## Mission

Build `phero.skeptou.com` Phase 1: D1 schema, share create/list/revoke endpoints (Cam-only), public share-serving endpoint with 7-day scoped cookie, PDF.js viewer, Cam management UI with per-share view-history drill-down. Single sharing model — shareable link + cookie. Custom slugs (Cam-set) or auto-generated 22-char random slugs. Per-link view tracking via `share_views` table (cf_country, user_agent, referrer). No OTP, no Resend, no watermarking.

**Phase 2 (watermarking) is separate. Phase 1 ships as described here.**

---

## Pre-conditions (must be live before Phase 1 can complete verification)

- `GET /api/papers/:slug/content` live on energeia (see `brief-energeia-content-endpoint.md`)
- `GET /api/publications/:slug/content` live on aristeia (aristeia Phase 1 complete)

Phase 1 can be built and deployed in parallel with energeia/aristeia; end-to-end verification requires both upstream endpoints live.

---

## Deliverables

1. D1 database `skeptou-phero` created; migrations applied (3 tables + 1 view)
2. Worker: `POST /api/shares`, `GET /api/shares`, `DELETE /api/shares/:slug`
3. Worker: `GET /api/share/:slug` — public serve with 7-day scoped cookie; `share_views` row logged per request
4. CF Rate Limiting on `GET /api/share/:slug` (30 req/min per IP)
5. Public viewer at `/<slug>`: PDF.js + download button + expired/revoked pages
6. Cam management UI at `/manage`: create form, share list (with label + slug), per-share view-history drill-down, revoke

---

## Repo layout

```
modules/phero/
  wrangler.toml
  package.json
  src/
    index.ts
    handlers/
      shares.ts       ← POST/GET/DELETE /api/shares (Cam session)
      serve.ts        ← GET /api/share/:slug (public)
      auth.ts
    lib/
      slug.ts         ← generateRandomSlug(), validateCustomSlug()
      cookie.ts       ← signShareCookie(), validateShareCookie()
    types.ts
  migrations/
    0001_initial_schema.sql
    0002_indexes.sql
  public/
    index.html        ← redirect to /manage
    manage/
      index.html      ← Cam management UI
    share/
      viewer.html     ← public viewer template
      expired.html    ← expired/not-found page
      revoked.html    ← revoked 410 page
    viewer.css
    viewer.js
```

---

## D1 schema — `0001_initial_schema.sql`

```sql
-- ============================================================
-- Phero share metadata — skeptou-phero D1 database
-- Sképtou / specs/phero.md rev 4
-- ============================================================

CREATE TABLE IF NOT EXISTS shares (
  slug               TEXT    PRIMARY KEY,                -- URL segment; random 22-char or custom (4–64 chars)
  source_module      TEXT    NOT NULL CHECK (source_module IN ('energeia','aristeia')),
  source_slug        TEXT    NOT NULL,
  source_version     TEXT,                               -- NULL = live; set = snapshot at creation
  label              TEXT,                               -- human-readable Cam-facing name; never in URL
  recipient_email    TEXT,                               -- optional Cam annotation; NOT enforced for access
  expires_at         TEXT,                               -- NULL = no expiry; default 45 days from creation
  view_count         INTEGER NOT NULL DEFAULT 0,         -- denormalized for fast list rendering
  last_viewed_at     TEXT,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  revoked_at         TEXT,
  metadata           TEXT    NOT NULL DEFAULT '{}'
);

-- Per-access view log — supports per-share history drill-down in management UI
CREATE TABLE IF NOT EXISTS share_views (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  share_slug     TEXT    NOT NULL REFERENCES shares(slug),
  event_type     TEXT    NOT NULL CHECK (event_type IN ('view','download')),
  ip_hash        TEXT,          -- SHA-256(CF-Connecting-IP)
  cf_country     TEXT,          -- CF-IPCountry header (2-letter ISO; 'XX' if unknown)
  user_agent     TEXT,          -- truncated to 256 chars
  referrer       TEXT,          -- HTTP Referer (truncated to 256 chars)
  occurred_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Cam-action audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  row_key      TEXT    NOT NULL,
  action       TEXT    NOT NULL CHECK (action IN ('CREATE','REVOKE','UPDATE')),
  actor        TEXT    NOT NULL DEFAULT 'cam',
  snapshot     TEXT    NOT NULL DEFAULT '{}',
  occurred_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
```

## D1 schema — `0002_indexes.sql`

```sql
CREATE INDEX IF NOT EXISTS idx_shares_source     ON shares(source_module, source_slug);
CREATE INDEX IF NOT EXISTS idx_shares_created    ON shares(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shares_expires    ON shares(expires_at);
CREATE INDEX IF NOT EXISTS idx_views_slug        ON share_views(share_slug);
CREATE INDEX IF NOT EXISTS idx_views_occurred    ON share_views(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_views_country     ON share_views(cf_country);

CREATE VIEW IF NOT EXISTS active_shares AS
  SELECT * FROM shares
  WHERE revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%SZ','now'));
```

---

## wrangler.toml

```toml
name = "phero-worker"
main = "src/index.ts"
compatibility_date = "2025-01-01"
pages_build_output_dir = "public"

[[d1_databases]]
binding = "PHERO_DB"
database_name = "skeptou-phero"
database_id = "FILL_AFTER_CREATE"

[vars]
ENERGEIA_BASE_URL      = "https://energeia.skeptou.com"
ARISTEIA_BASE_URL      = "https://aristeia.skeptou.com"
SHARE_COOKIE_TTL_DAYS  = "7"

# Secrets (wrangler secret put):
# ENERGEIA_SERVICE_TOKEN
# ARISTEIA_SERVICE_TOKEN
# COOKIE_SIGNING_KEY       ← HMAC key for scoped cookie signing
```

---

## Slug generation and validation

```typescript
// src/lib/slug.ts

const RESERVED_SLUGS = new Set([
  'api', 'share', 'manage', 'admin', 'static', 'assets',
  'health', 'robots', 'favicon', 'sitemap', 'login', 'logout',
]);

export function generateRandomSlug(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  // Result: 22-char base64url string encoding 128 bits of CSPRNG output
}

export function validateCustomSlug(slug: string): { valid: boolean; error?: string } {
  if (slug.length < 4 || slug.length > 64) {
    return { valid: false, error: 'slug must be 4–64 characters' };
  }
  if (!/^[a-z0-9][a-z0-9-]{2,62}[a-z0-9]$/.test(slug)) {
    return { valid: false, error: 'slug must be lowercase alphanumeric with hyphens; must start and end with alphanumeric' };
  }
  if (RESERVED_SLUGS.has(slug)) {
    return { valid: false, error: `'${slug}' is a reserved slug` };
  }
  return { valid: true };
}
```

## Cookie signing

```typescript
// src/lib/cookie.ts
export async function signShareCookie(slug: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(slug));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function validateShareCookie(
  cookieValue: string, slug: string, key: string
): Promise<boolean> {
  const expected = await signShareCookie(slug, key);
  if (cookieValue.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < cookieValue.length; i++) diff |= cookieValue.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
```

---

## Handler: `POST /api/shares` (Cam session only)

Request body:
```typescript
interface CreateShareBody {
  source_module:    'energeia' | 'aristeia';
  source_slug:      string;
  slug?:            string;          // custom slug; omit to auto-generate
  label?:           string;          // Cam-facing annotation; shown in management UI
  recipient_email?: string;          // optional annotation only; NOT enforced for access
  expires_at?:      string | null;   // ISO 8601; null = no expiry; omit = 45-day default
  snapshot_mode?:   boolean;         // default false (live)
}
```

Slug resolution logic:
```typescript
let slug: string;
if (body.slug) {
  const validation = validateCustomSlug(body.slug);
  if (!validation.valid) return new Response(JSON.stringify({ error: validation.error }), { status: 400 });
  // Check uniqueness
  const existing = await env.PHERO_DB.prepare('SELECT slug FROM shares WHERE slug = ?').bind(body.slug).first();
  if (existing) return new Response(JSON.stringify({ error: 'slug already in use' }), { status: 409 });
  slug = body.slug;
} else {
  slug = generateRandomSlug();
  // Collision check (astronomically rare but correct)
  while (await env.PHERO_DB.prepare('SELECT slug FROM shares WHERE slug = ?').bind(slug).first()) {
    slug = generateRandomSlug();
  }
}
```

Default `expires_at`: `new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString()`

If `snapshot_mode = true`: fetch upstream metadata to get current version tag; store in `source_version`.

Response `201`:
```json
{
  "slug":          "my-paper-2026",
  "share_url":     "https://phero.skeptou.com/my-paper-2026",
  "source_module": "aristeia",
  "source_slug":   "hubbard-2024-grounding",
  "label":         "Search committee — Smith College",
  "source_version": null,
  "expires_at":    "2026-07-01T00:00:00Z",
  "created_at":    "2026-05-17T10:00:00Z"
}
```

---

## Handler: `GET /api/shares` (Cam session only)

Query params: `source_module`, `limit` (default 50), `offset`.

Returns all shares (including revoked/expired) ordered by `created_at DESC`, with `slug`, `label`, `view_count`, `last_viewed_at`, `revoked_at`, `expires_at`. Cam needs to see expired/revoked shares to understand history.

---

## Handler: `DELETE /api/shares/:slug` (Cam session only)

Sets `revoked_at = now()` and appends to `audit_log`. Does not delete the row. Returns `200`.

---

## Handler: `GET /api/share/:slug` (public)

**Rate limit:** 30 req/min per IP at CF layer.

```
1. Look up slug in shares table directly (need both active and revoked state)
   → NOT FOUND:           404 — serve expired.html
   → revoked_at IS NOT NULL: 410 — serve revoked.html
   → expires_at in past:  404 — serve expired.html

2. Check scoped cookie: phero-session-<slug>
   → valid HMAC:    skip to step 4
   → absent/invalid: issue new cookie (step 3), continue

3. Set-Cookie: phero-session-<slug>=<HMAC>; HttpOnly; Secure; SameSite=Lax;
               Max-Age=604800; Path=/<slug>

4. Fetch from upstream:
   energeia: GET {ENERGEIA_BASE_URL}/api/papers/{source_slug}/content[?version=...]
   aristeia:  GET {ARISTEIA_BASE_URL}/api/publications/{source_slug}/content[?version=...]
   Authorization: Bearer {SERVICE_TOKEN}

5. ctx.waitUntil(env.PHERO_DB.batch([
     env.PHERO_DB.prepare(
       `UPDATE shares SET view_count = view_count + 1, last_viewed_at = ? WHERE slug = ?`
     ).bind(now, slug),
     env.PHERO_DB.prepare(
       `INSERT INTO share_views (share_slug, event_type, ip_hash, cf_country, user_agent, referrer)
        VALUES (?, 'view', ?, ?, ?, ?)`
     ).bind(slug, await sha256(ip),
       request.headers.get('CF-IPCountry') ?? 'XX',
       (request.headers.get('User-Agent') ?? '').slice(0, 256),
       (request.headers.get('Referer') ?? '').slice(0, 256)),
   ]));

6. Stream with:
   Content-Type:        <from upstream>
   Content-Disposition: attachment; filename="<source_slug>.pdf"
   Cache-Control:       private, no-store
   Set-Cookie:          (from step 3, if new cookie issued)
```

Helper:
```typescript
async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
```

---

## Handler: `GET /api/shares/:slug/views` (Cam session only)

Returns paginated `share_views` log for a given slug.

Query params: `limit` (default 25, max 100), `offset`, `event_type` (optional filter).

Response:
```json
{
  "slug": "my-paper-2026",
  "total": 42,
  "rows": [
    {
      "id": 42,
      "event_type": "view",
      "occurred_at": "2026-05-17T14:23:00Z",
      "cf_country": "US",
      "referrer": "",
      "user_agent": "Mozilla/5.0 ..."
    }
  ]
}
```

This endpoint powers the view-history drill-down panel in the management UI.

---

## Viewer UI

**`/<slug>` — viewer (`share/viewer.html`):**
- On load: the document is already streaming (the Worker served it via `Content-Disposition: attachment`)
- The viewer page is for in-browser reading alongside the download. Render with PDF.js.
- Download button: triggers file download (PDF.js download affordance or `<a>` pointing to `/<slug>/download`)
- No Sképtou branding on this page — external recipients should not see internal infrastructure names.

**`/expired` — expired.html:** "This link is no longer available." Minimal styling.

**`/revoked` — revoked.html (410):** "This link has been revoked." Minimal styling.

**`/manage` — management UI:**
- **Create share form** (`/manage/new`): source_module dropdown, source_slug input, label input, custom slug field (optional; placeholder "Leave blank to auto-generate"), recipient_email (optional annotation), expires_at picker (default 45 days), snapshot_mode checkbox
- **Share list** (`/manage`): label (or source_slug if blank), slug (monospace, copy-link button), source module badge, view_count, last_viewed_at (relative), expires_at, status badge (Active/Expired/Revoked), revoke button
- **View history panel**: triggered by "View history" action per share; fetches `GET /api/shares/:slug/views`; renders paginated table: occurred_at, event_type badge, cf_country, referrer, user_agent (collapsed); most-recent first; 25 rows/page

---

## Access gate — management only

`phero.skeptou.com/*` is **not** behind a blanket CF Access policy. Management paths only:

DevOps configures CF Access to apply only to:
- `phero.skeptou.com/manage/*`
- `phero.skeptou.com/api/shares*` (management API)

Public paths bypass Access:
- `phero.skeptou.com/<slug>` (custom or random slug path)
- `phero.skeptou.com/api/share/*`

Worker's `requireCamSession()` check provides the auth layer for management API even though CF Access is also on it (defence in depth).

---

## Wrangler setup commands

```bash
wrangler d1 create skeptou-phero
# Paste database_id into wrangler.toml

wrangler d1 migrations apply skeptou-phero --remote
# No R2 bucket needed — phero has no object storage

# Verify schema
wrangler d1 info skeptou-phero
# Expect: shares, share_views, audit_log, active_shares

# Provision secrets
echo "<energeia-service-token>" | wrangler secret put ENERGEIA_SERVICE_TOKEN
echo "<aristeia-service-token>" | wrangler secret put ARISTEIA_SERVICE_TOKEN
openssl rand -hex 32 | wrangler secret put COOKIE_SIGNING_KEY
```

---

## Phase 1 definition of done

- [ ] `wrangler d1 info skeptou-phero` shows `shares`, `share_views`, `audit_log`, `active_shares`
- [ ] `POST /api/shares` with no `slug` → creates share with 22-char auto-generated random slug; response includes `share_url`
- [ ] `POST /api/shares` with `slug = "my-paper-2026"` → custom slug stored; `share_url` uses it
- [ ] `POST /api/shares` with `slug = "admin"` → `400` "slug is reserved"
- [ ] `POST /api/shares` with `slug = "ab"` → `400` "slug must be 4–64 characters"
- [ ] `POST /api/shares` with duplicate slug → `409`
- [ ] `POST /api/shares` with `label = "Search committee"` → label stored; appears in `GET /api/shares` response
- [ ] `GET /api/shares` returns created shares with `slug`, `label`, `view_count = 0`, `last_viewed_at = null`
- [ ] `GET /api/share/<slug>` (energeia source): fetches from energeia; `phero-session-<slug>` cookie set; `share_views` row inserted; view_count incremented; PDF streams with Content-Disposition: attachment
- [ ] `GET /api/share/<slug>` (aristeia source): same
- [ ] `GET /api/shares/<slug>/views` → returns view row with `event_type = "view"`, `cf_country`, `occurred_at`
- [ ] Return visit within 7 days: cookie present; served immediately; new view row still logged
- [ ] Cookie expired / cleared: new 7-day cookie issued on next visit (if share still active)
- [ ] `DELETE /api/shares/:slug`: sets `revoked_at`; subsequent `GET /api/share/:slug` → 410 revoked page
- [ ] Share with `expires_at = now + 1 minute`: after expiry → 404 expired page
- [ ] Rate limit: 31st request from same IP within 60s → 429
- [ ] Unauthenticated `POST /api/shares` → 403
- [ ] Unauthenticated `GET /api/shares` → 403
- [ ] Management UI: create share (custom + auto slug), copy link, view-history drill-down, revoke — all work end-to-end
- [ ] View-history panel: shows per-event rows with occurred_at, event_type, cf_country, referrer
- [ ] Public viewer renders PDF in-browser alongside download button
- [ ] CF Access gate on `/manage/*` verified by QA (desktop, mobile, incognito)

---

## Out of scope (Phase 1)

- Watermarking — Phase 2
- Aggregated analytics (date-range summaries, country breakdowns) — Phase 3 (raw view history is Phase 1)
- Identified-recipient mode (P-10) — future / open Q
- Resend integration — not planned (OTP ruled out per P-7)
