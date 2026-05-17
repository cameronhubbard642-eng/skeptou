# specs/phero.md — Phero Document Sharing Interface

**Version:** rev 4
**Status:** ratified — Cam 2026-05-15 (P-1/P-3/P-7 ruled 2026-05-15)
**Author:** Lead Dev / Architect — Sképtou
**Date:** 2026-05-17
**Depends on:** `specs/auth-core.md`, `specs/energeia.md`, `specs/aristeia.md`, `ARCHITECTURE.md`
**Consumers:** DevOps engineer, Phero engineer, Cam

---

## §I — Purpose + scope

### §I.1 — What phero is

`phero.skeptou.com` (Slot 3 — see Q1 in §XIV) is a controlled, outward-facing sharing layer for canonical documents originating from energeia (papers under development or in pipeline) and aristeia (published or archived professional documents). It is **not** a storage system, **not** a CMS, and **not** a general-purpose file host. Phero holds share metadata; it proxies bytes from upstream sources.

The defining characteristic separating phero from all other Sképtou modules: **its audience is external recipients** — colleagues, reviewers, search committees, editors, co-authors — who have no auth-core account and no Cloudflare Access credentials. Phero routes around the Access gate by design: each share URL is publicly accessible and requires no auth-core account or Access credentials. Access is gated only by possession of the 128-bit random share token.

### §I.2 — What phero enables

| Scenario | Share model | Notes |
|---|---|---|
| Sending a paper draft to a reviewer | Anonymous or recipient | "Here's a link to my latest draft" |
| Formal submission to search committee (letter, CV) | Recipient | Identity-tracked; recipient email logged |
| Sharing a published PDF with a colleague | Anonymous | Quick link; no verification needed |
| Distributing a preprint to a reading group | Anonymous | Group-wide link; view count tracked |
| Sending a sensitive document (recommendation letter authored by Cam) | Recipient | Single-recipient; watermark at Phase 3 |

### §I.3 — What phero does not do

- Store documents (bytes live in energeia R2 or aristeia R2; phero proxies, never stores)
- Edit or modify upstream documents
- Grant the recipient write access to anything
- Function as a general file host (only energeia and aristeia documents can be shared)
- Serve teaching materials, reports, or internal notes (those belong to paideia and strategia respectively)

### §I.4 — Downloads are permitted

Unlike strategia and aristeia (where the posture is in-browser only, no download UI), phero explicitly permits downloads. Sharing implies the external reader may need the file — a reviewer needs to annotate, a committee member needs to forward, a colleague needs to cite. Phero's viewer provides a download button alongside the in-browser reader. There is no policy prohibition on saving the document.

---

## §II — Architecture overview

```
phero.skeptou.com/<token>        ← Public (no Cloudflare Access gate)
  /<token>                       ← Share landing page / viewer
  /                              ← Optional: Cam management UI (Access-gated sub-path)

phero.skeptou.com/api/*          ← Cloudflare Worker (phero-worker)
  POST   /api/shares             ← Create share (Cam session only)
  GET    /api/shares             ← List Cam's shares (Cam session only)
  DELETE /api/shares/:token      ← Revoke (Cam session only)
  GET    /api/share/:token       ← Validate + proxy document; issue 7-day scoped cookie (public)
```

**Access gate note:** `phero.skeptou.com/*` is **not** covered by a blanket Cloudflare Access policy. The public share path (`/<token>`) must be reachable by external recipients without Access credentials. Cam's management UI is handled at the Worker level (session auth check), not at the CF Access layer. This is the only Sképtou module where the Access gate is intentionally not blanket.

**Alternative considered:** a sub-path at `phero.skeptou.com/manage/*` could be Access-gated while `phero.skeptou.com/<token>` is public. This is the recommended pattern — DevOps configures Access to bypass on the token path pattern and apply only to `/manage/*` and `/api/shares*`.

**Storage:**

```
D1 (skeptou-phero)               ← Share metadata, event log, audit log
                                 ← NO R2 — phero stores nothing
```

**Upstream proxying:**

```
phero-worker
  ├─ Calls energeia-worker /api/papers/:slug/content    → with ENERGEIA_SERVICE_TOKEN
  └─ Calls aristeia-worker  /api/publications/:slug/content → with ARISTEIA_SERVICE_TOKEN
```

**Worker bindings (wrangler.toml):**

```toml
[[d1_databases]]
binding = "PHERO_DB"
database_name = "skeptou-phero"
database_id = "<uuid>"

[vars]
ENERGEIA_BASE_URL = "https://energeia.skeptou.com"
ARISTEIA_BASE_URL  = "https://aristeia.skeptou.com"
SHARE_COOKIE_TTL_DAYS = "7"

# Secrets (set via wrangler secret put):
# ENERGEIA_SERVICE_TOKEN
# ARISTEIA_SERVICE_TOKEN
# COOKIE_SIGNING_KEY  (HMAC key for scoped session cookie signing)
```

---

## §III — Sharing model

### §III.1 — Single model: shareable link + scoped session cookie

Phero uses one sharing model. There is no anonymous-vs-recipient distinction.

**How it works:**
- Cam generates a share URL (`phero.skeptou.com/<token>`) and distributes it manually — via email, clipboard, or message. Phero never sends the share URL itself.
- A recipient visits the URL. The Worker validates the token, sets a **7-day scoped session cookie**, and serves the document immediately.
- On subsequent visits within the 7-day window, the cookie is present → document served without any prompt.
- After 7 days (or if the cookie is cleared), the next visit issues a fresh 7-day cookie — provided the share itself has not expired or been revoked.

The share token is the access credential. Possession of the URL = access. No OTP, no email verification, no identity enforcement.

**Default expiry:** 45 days (Cam 2026-05-15). Overridable per share at creation time.

### §III.2 — Share slug (URL segment)

The share slug is the URL segment and the primary key for a share. It is either:

- **Random (default):** 128 bits from `crypto.getRandomValues()`, base64url-encoded → 22-character URL-safe string. Used when Cam does not specify a custom slug.
- **Custom (opt-in):** Cam sets a human-meaningful slug at create time (e.g., `dossier-2026-fall`). Must be unique. Format: alphanumeric + hyphens, 4–64 characters, must start and end with alphanumeric.

**URL form:** `phero.skeptou.com/<slug>` — e.g.:
- Random: `phero.skeptou.com/aBcDeFgHiJkLmNoPqRsTuV`
- Custom: `phero.skeptou.com/dossier-2026-fall`

**Human-readable label** (separate from slug, Cam-facing only): stored in `label` column. E.g., label = "Fall 2026 dossier for Smith." Never appears in the URL. Used in Cam's management UI for quick recognition without leaking recipient details in the URL.

**Slug validation:**
- Regex: `/^[a-z0-9][a-z0-9-]{2,62}[a-z0-9]$/` (lowercase; hyphens allowed in middle only)
- Length: 4–64 characters
- Reserved words (rejected): `api`, `share`, `manage`, `admin`, `static`, `assets`, `health`, `robots`, `favicon`, `sitemap`, `login`, `logout`
- Uniqueness: `UNIQUE` constraint on `slug` column in D1; `409 Conflict` if slug already in use

```typescript
const RESERVED_SLUGS = new Set([
  'api', 'share', 'manage', 'admin', 'static', 'assets',
  'health', 'robots', 'favicon', 'sitemap', 'login', 'logout',
]);

function validateCustomSlug(slug: string): { valid: boolean; error?: string } {
  if (slug.length < 4 || slug.length > 64)
    return { valid: false, error: 'slug must be 4–64 characters' };
  if (!/^[a-z0-9][a-z0-9-]{2,62}[a-z0-9]$/.test(slug))
    return { valid: false, error: 'slug must be lowercase alphanumeric with hyphens (not at start/end)' };
  if (RESERVED_SLUGS.has(slug))
    return { valid: false, error: 'slug is reserved' };
  return { valid: true };
}

function generateRandomSlug(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
```

**Multi-access:** the slug is permanent until expiry/revocation; multiple visits are permitted.

---

## §IV — Snapshot vs. live

### §IV.1 — The choice

When Cam creates a share for "Paper X," the share can resolve to:

- **Live (recommended default):** always fetch the current canonical from upstream. If Cam promotes Paper X from v1.3 to v1.4 after share creation, the recipient gets v1.4. The share always shows the latest version.
- **Snapshot:** the share is pinned to the upstream version at creation time (e.g., `source_version = "v1.3"`). If v1.4 is promoted later, the share still serves v1.3.

### §IV.2 — Per-share toggle

Recommendation: per-share toggle with **live as default**. Snapshot mode is appropriate for formal submissions (e.g., "here is the version I submitted to Philosophical Review on 2026-05-15"). Cam checks a "Pin to current version" checkbox at share creation time; if checked, the Worker records `source_version` from the upstream metadata at creation time.

The Worker implements this by:
- `source_version = NULL` → call upstream with no version parameter → get current canonical
- `source_version = "v1.3"` → call `GET /api/papers/:slug/content?version=v1.3` → get pinned version

This is open question Q1 in §XIV.

---

## §V — D1 schema

### §V.1 — Migration files

Location: `modules/phero/migrations/`

```
0001_initial_schema.sql
0002_indexes.sql
```

Applied via `wrangler d1 migrations apply skeptou-phero`.

### §V.2 — `0001_initial_schema.sql`

**Table vs JSON trade-off for view history:** `share_views` is a dedicated table (not a JSON column on `shares`). The management UI drill-down requires date-range filtering, pagination, and per-column ordering (`ORDER BY occurred_at DESC LIMIT ? OFFSET ?`). A JSON column would make all of this awkward in SQLite and would grow unbounded for active shares. The table approach is the clear choice.

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

-- Per-access view log — richer than view_count alone; supports per-share history drill-down
CREATE TABLE IF NOT EXISTS share_views (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  share_slug     TEXT    NOT NULL REFERENCES shares(slug),
  event_type     TEXT    NOT NULL CHECK (event_type IN ('view','download')),
  ip_hash        TEXT,          -- SHA-256(CF-Connecting-IP)
  cf_country     TEXT,          -- CF-IPCountry header (2-letter ISO code; 'XX' if unknown)
  user_agent     TEXT,
  referrer       TEXT,          -- HTTP Referer header (truncated to 256 chars)
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

**Design notes:**

- `slug` is the primary key and the URL segment. Custom slugs (Cam-chosen) are validated at create time; random slugs are the fallback. Both use the same column.
- `label` is a separate Cam-facing display name — distinct from `slug`. Cam can set a meaningful label without exposing it in the URL.
- `recipient_email` is a Cam-side annotation only; subject to P-9 ruling (§XIV).
- `view_count` and `last_viewed_at` are denormalized on `shares` for fast list rendering (avoid JOIN on every list request). They are updated atomically alongside the `share_views` INSERT in `ctx.waitUntil()`.
- `share_views.cf_country`: derived from the `CF-IPCountry` header (set by Cloudflare on every request). Not PII; country-level granularity only.
- `share_views.referrer`: truncated to 256 chars to bound column size. HTTP Referer is often empty on direct link visits (email clients strip it).

### §V.3 — `0002_indexes.sql`

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

### §V.4 — Active shares view

```sql
CREATE VIEW IF NOT EXISTS active_shares AS
  SELECT * FROM shares
  WHERE revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%SZ','now'));
```

The public share validation path queries `active_shares`, not `shares` directly.

---

## §VI — API surface

### §VI.1 — `POST /api/shares` — Create share

Cam-only. Creates a share record and returns the share URL.

**Auth:** session cookie only.

**Request body (JSON):**

```typescript
interface CreateShareBody {
  source_module:    'energeia' | 'aristeia';
  source_slug:      string;
  slug?:            string;            // custom URL slug (optional; random 22-char fallback)
  label?:           string;            // human-readable Cam-facing label; separate from slug
  recipient_email?: string;            // optional annotation; never enforced
  expires_at?:      string | null;     // ISO 8601; null = no expiry; omit = 45-day default
  snapshot_mode?:   boolean;           // default false (live)
}
```

**Behavior:**
1. Validate: `source_module` in (`energeia`,`aristeia`); `source_slug` non-empty; if `slug` provided: validate format + reserved-words check + D1 uniqueness (return `409` if taken)
2. If `snapshot_mode = true`: call upstream metadata endpoint to retrieve current `version` tag; store in `source_version`
3. Generate share token (§III.3)
4. Insert into `shares` and `audit_log` in one `PHERO_DB.batch()`
5. Return share URL and metadata

**Response `201`:**
```json
{
  "data": {
    "slug":        "aBcDeFgHiJkLmNoPqRsTuV",
    "share_url":  "https://phero.skeptou.com/aBcDeFgHiJkLmNoPqRsTuV",
    "source_module": "aristeia",
    "source_slug":   "consciousness-2026-phil-review",
    "source_version": null,
    "expires_at":   "2026-08-14T00:00:00Z",
    "created_at":   "2026-05-16T10:00:00Z"
  }
}
```

**Handler sketch:**

```typescript
async function createShare(body: CreateShareBody, actor: string, env: Env): Promise<Response> {
  let sourceVersion: string | null = null;
  if (body.snapshot_mode) {
    const base  = body.source_module === 'energeia' ? env.ENERGEIA_BASE_URL : env.ARISTEIA_BASE_URL;
    const token = body.source_module === 'energeia' ? env.ENERGEIA_SERVICE_TOKEN : env.ARISTEIA_SERVICE_TOKEN;
    const path  = body.source_module === 'energeia' ? 'papers' : 'publications';
    const meta  = await fetch(`${base}/api/${path}/${body.source_slug}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!meta.ok) return Response.json({ error: 'upstream document not found' }, { status: 404 });
    const metaJson = await meta.json() as { data: { source_version?: string; version?: string } };
    sourceVersion = metaJson.data.source_version ?? metaJson.data.version ?? null;
  }

  // Resolve slug: custom if provided and valid, else random
  let shareSlug: string;
  if (body.slug) {
    const check = validateCustomSlug(body.slug);
    if (!check.valid) return Response.json({ error: check.error }, { status: 400 });
    shareSlug = body.slug;
    // Uniqueness enforced by D1 UNIQUE constraint — catch constraint error → 409
  } else {
    shareSlug = generateRandomSlug();
  }

  const now        = new Date().toISOString();
  const expiresAt  = body.expires_at !== undefined
    ? body.expires_at
    : new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString();

  await env.PHERO_DB.batch([
    env.PHERO_DB.prepare(
      `INSERT INTO shares (slug, source_module, source_slug, source_version, label, recipient_email, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(shareToken, body.source_module, body.source_slug, sourceVersion,
           body.recipient_email ?? null, body.label ?? null, expiresAt),
    env.PHERO_DB.prepare(
      `INSERT INTO audit_log (row_key, action, actor, snapshot) VALUES (?, 'CREATE', ?, ?)`
    ).bind(shareToken, actor, JSON.stringify({ ...body, source_version: sourceVersion })),
  ]);

  return Response.json({
    data: {
      slug:    shareToken,
      share_url:      `https://phero.skeptou.com/${shareToken}`,
      source_module:  body.source_module,
      source_slug:    body.source_slug,
      source_version: sourceVersion,
      expires_at:     expiresAt,
      created_at:     now,
    }
  }, { status: 201 });
}
```

---

### §VI.2 — `GET /api/shares` — List Cam's shares

Cam-only. Returns all shares (active + revoked) with view counts.

**Auth:** session cookie only.

**Query parameters:**

| Param | Description |
|---|---|
| `source_module` | Filter: `energeia` or `aristeia` |
| `active` | `true` = active only (non-revoked, non-expired); `false` = all |
| `limit` / `offset` | Pagination |

**Response `200`:** list of share rows including `view_count`, `last_viewed_at`, `revoked_at`.

---

### §VI.3 — `DELETE /api/shares/:token` — Revoke share

Cam-only. Instantly kills the share link.

**Auth:** session cookie only.

**Behavior:**
1. Verify share exists and belongs to Cam (all shares belong to Cam; check token exists)
2. Set `revoked_at = now()` on D1 row
3. Write `audit_log` REVOKE row
4. Return `204`

After revocation, `GET /api/share/:token` returns the revocation response (configurable — see Q5 in §XIV).

---

### §VI.4 — `GET /api/share/:token` — Public share access

**Auth:** None. Public endpoint. Cookie-gated after first visit.

**Rate limiting:** 30 requests/minute per IP. Prevents token enumeration.

**Validation + cookie flow:**

```
1. Look up share_token in active_shares view
   → NOT FOUND (invalid or expired):  → 404 (never distinguish invalid from expired)
   → FOUND, revoked_at IS NOT NULL:   → 410 Gone ("This link has been revoked")

2. Check for valid scoped share cookie: phero-session-<slug>
   → PRESENT + VALID:   → skip to step 4 (serve document)
   → ABSENT or INVALID: → issue new 7-day scoped cookie, then serve document

3. Issue scoped cookie:
   Set-Cookie: phero-session-<slug>=<HMAC-signed>; HttpOnly; Secure; SameSite=Lax;
               Max-Age=604800; Path=/<slug>
   HMAC value: HMAC-SHA256(share_token + created_at + COOKIE_SIGNING_KEY)

4. Fetch upstream document:
   → source_module = 'energeia': GET energeia /api/papers/:slug/content[?version=...]
   → source_module = 'aristeia':  GET aristeia  /api/publications/:slug/content[?version=...]

5. Update D1 (non-blocking — ctx.waitUntil()):
   → INCREMENT view_count, SET last_viewed_at
   → INSERT share_views row (event_type = 'view')

6. Stream upstream response:
   → Content-Type: <from upstream>
   → Content-Disposition: attachment; filename="<slug>.pdf"
   → Cache-Control: private, no-store
```

`Content-Disposition: attachment` enables the browser save-file dialog. Downloads are permitted for shared documents (phero explicitly allows downloads; unlike strategia/aristeia).

**Handler sketch:**

```typescript
async function serveShare(token: string, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // 1. Validate token
  const share = await env.PHERO_DB.prepare(
    `SELECT * FROM active_shares WHERE slug = ?`
  ).bind(token).first<ShareRow | null>();

  if (!share) return new Response(null, { status: 404 });
  if (share.revoked_at) return revokedResponse(); // 410

  // 2. Check cookie
  const cookieName = `phero-session-${slug}`;
  const existingCookie = getCookie(request, cookieName);
  const cookieValid = existingCookie && validateShareCookie(existingCookie, token, env);

  // 3. Fetch from upstream
  const base   = share.source_module === 'energeia' ? env.ENERGEIA_BASE_URL : env.ARISTEIA_BASE_URL;
  const svcTok = share.source_module === 'energeia' ? env.ENERGEIA_SERVICE_TOKEN : env.ARISTEIA_SERVICE_TOKEN;
  const path   = share.source_module === 'energeia' ? 'papers' : 'publications';
  const vParam = share.source_version ? `?version=${share.source_version}` : '';

  const upstream = await fetch(`${base}/api/${path}/${share.source_slug}/content${vParam}`, {
    headers: { Authorization: `Bearer ${svcTok}` },
  });
  if (!upstream.ok) return Response.json({ error: 'upstream unavailable' }, { status: 502 });

  // 4. Non-blocking analytics — update denormalized counts + insert rich view row
  const ip     = request.headers.get('CF-Connecting-IP') ?? '';
  const now    = new Date().toISOString();
  ctx.waitUntil(env.PHERO_DB.batch([
    env.PHERO_DB.prepare(
      `UPDATE shares SET view_count = view_count + 1, last_viewed_at = ? WHERE slug = ?`
    ).bind(now, slug),
    env.PHERO_DB.prepare(
      `INSERT INTO share_views (share_slug, event_type, ip_hash, cf_country, user_agent, referrer)
       VALUES (?, 'view', ?, ?, ?, ?)`
    ).bind(
      slug,
      await sha256(ip),
      request.headers.get('CF-IPCountry') ?? 'XX',
      (request.headers.get('User-Agent') ?? '').slice(0, 256),
      (request.headers.get('Referer') ?? '').slice(0, 256),
    ),
  ]));

  // 5. Build response headers
  const contentType = upstream.headers.get('Content-Type') ?? 'application/octet-stream';
  const ext         = contentType.includes('pdf') ? 'pdf' : 'bin';
  const headers: Record<string, string> = {
    'Content-Type':           contentType,
    'Content-Disposition':    `attachment; filename="${share.source_slug}.${ext}"`,
    'Cache-Control':          'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  };

  // 6. Issue or refresh cookie if needed
  if (!cookieValid) {
    const cookieValue = signShareCookie(token, env.COOKIE_SIGNING_KEY);
    headers['Set-Cookie'] = `${cookieName}=${cookieValue}; HttpOnly; Secure; SameSite=Lax; Max-Age=604800; Path=/${token}`;
  }

  return new Response(upstream.body, { headers });
}
```

---

## §VII — Share access flow

### §VII.1 — Full flow for a visitor

1. Cam creates a share → receives `share_url` (e.g. `phero.skeptou.com/aBcDeFgHiJkLmNoPqRsTuV`)
2. Cam distributes the URL manually (email, clipboard, etc.)
3. Visitor clicks the URL
4. Worker validates the token → valid and not revoked/expired → issues 7-day scoped cookie → streams document
5. Visitor's browser receives the document with `Content-Disposition: attachment` → browser offers save-file dialog (or opens inline if the user's browser is configured to do so)
6. On subsequent visits within 7 days: cookie present → document served immediately, no prompt
7. After 7 days (or cleared cookies): next visit issues a fresh 7-day cookie (if share still active)

### §VII.2 — Expired / revoked link page

- **Expired share** (`expires_at` in the past): `404` response with styled "This link is no longer available" page. No distinction between invalid token and expired token (prevents enumeration).
- **Revoked share** (`revoked_at` is set): `410 Gone` with styled "This link has been revoked" page.

The 404 / 410 distinction is intentional: revocation is an active Cam action and warrants a distinct, informative response. Expiry is passive and not distinguished from invalid.

---

## §VIII — In-browser viewer

### §VIII.1 — Public viewer

The share landing page at `/<token>` renders the document in-browser **and** provides a download button. Unlike strategia and aristeia (which suppress download), phero's viewer is a sharing surface — the point is for the recipient to have the document.

| MIME type | Renderer | Download button |
|---|---|---|
| `application/pdf` | PDF.js | ✓ |
| `text/markdown` | marked.js + DOMPurify | ✓ (download as .md) |
| `text/plain` | `<pre>` | ✓ |

The viewer has no Cam-side affordances (no delete, no manage, no navigation to other documents). The only UI elements are: the rendered document, a document title header (from share `label` or upstream document title), and a download button.

### §VIII.2 — Share metadata displayed to recipient

The viewer header displays:
- Document title (from upstream metadata, fetched at page load via `GET /api/share/:token` metadata endpoint)
- `expires_at` if set: "This link expires on [date]"
- Nothing about share_token, recipient_email, source_module, or internal identifiers

### §VIII.3 — Expired / revoked link page

When a token is invalid, expired, or revoked, the Worker returns a styled page (not a raw 404 JSON response). Recommended text: "This link is no longer available." (open question Q5 in §XIV — revoked vs expired vs invalid may warrant different messages).

---

## §IX — Cam management UI

### §IX.1 — Scope

A simple management interface at `phero.skeptou.com/manage` (behind session auth gate in the Worker, not a CF Access gate). Lists all of Cam's shares with:

| Column | Source |
|---|---|
| Label / Document | `label` (if set) or `source_slug` |
| Slug | `slug` (monospace; copy-link button) |
| Source | `source_module` badge |
| Recipient | `recipient_email` annotation (blank if not set) |
| Created | `created_at` |
| Expires | `expires_at` or "No expiry" |
| Views | `view_count` |
| Last viewed | `last_viewed_at` (relative) |
| Status | Active / Expired / Revoked |
| Actions | Copy link, View history, Revoke |

### §IX.2 — Create share form

A form at `/manage/new` that maps to `POST /api/shares`:
- Source module dropdown (energeia / aristeia)
- Source document dropdown (fetched from upstream paper/publication list)
- Label (optional free-text annotation; e.g., "search committee — Smith College"; displayed in management list view)
- Custom slug field (optional; leave blank to auto-generate a 22-char random slug; validated client-side: 4–64 chars, `^[a-z0-9][a-z0-9-]{2,62}[a-z0-9]$`, reserved words rejected)
- Recipient annotation (optional; "Shared with" note for Cam's reference only; not enforced for access)
- Expiry picker (defaults to 45 days; can be set to no expiry)
- Pin to current version checkbox (snapshot mode)

### §IX.3 — Per-share view history

Each share row has a "View history" action that opens a drill-down panel showing the `share_views` log for that slug. The panel surfaces:

| Column | Source |
|---|---|
| # | row order (most-recent first) |
| Time | `occurred_at` |
| Event | `event_type` badge (`view` / `download`) |
| Country | `cf_country` (ISO-3166-1 alpha-2 from CF-IPCountry; `XX` if unknown) |
| Referrer | `referrer` (truncated to 256 chars; blank if absent) |
| User agent | `user_agent` (truncated to 256 chars; collapsed by default) |

The panel is paginated (25 rows/page). This data is live from Phase 1 — the `share_views` table is populated from first access and requires no additional Phase 2 work.

---

## §X — Watermarking (Phase 3)

### §X.1 — Scope

Optional PDF overlay for recipient-model shares. At serve time, the Worker uses a PDF manipulation library (`pdf-lib` compiled to WASM, or a lightweight overlay approach) to stamp recipient-identifying text onto each page before streaming.

Watermark content:
```
Shared with: reviewer@university.edu
Link: phero.skeptou.com/<first-8-chars-of-token>
Date: 2026-05-16
```

Placed as a semi-transparent footer on each page. Does not modify the upstream R2 object; generated in-memory per request.

### §X.2 — Practical constraints

- PDF manipulation in a Worker adds latency and memory pressure. For large PDFs (50–80MB), this may approach Worker memory limits.
- Recommendation: implement watermarking only for PDFs under 20MB in Phase 3; surface a "watermark not applied — document too large" note in the management UI for larger files.
- Watermarking is opt-in per share (Cam checks "Watermark this share" at creation time). Not all recipient-model shares need it.

This is open question Q3 in §XIV.

---

## §XI — Auth + scopes

### §XI.1 — Cam session (write operations)

`POST /api/shares`, `GET /api/shares`, `DELETE /api/shares/:token`, `/manage/*` all require a session cookie. The Worker's `requireCamSession()` check is the same as aristeia (§IX.1 of the aristeia spec). No service tokens for Cam-facing write operations.

### §XI.2 — Public access (share serving)

`GET /api/share/:token` and the viewer page (`/<token>`) are publicly accessible — no auth-core session, no Access challenge. This is the intentional architectural departure from all other Sképtou modules.

### §XI.3 — Worker-to-Worker service tokens

`ENERGEIA_SERVICE_TOKEN` and `ARISTEIA_SERVICE_TOKEN` are Worker secrets used only in the server-side upstream fetch. Never returned in any API response. Scoped for read-only access to the respective module's content endpoints.

---

## §XII — Security posture

### §XII.1 — Random slug entropy

When Cam does not supply a custom slug, the auto-generated slug encodes 128 bits of CSPRNG output as a 22-char base64url string (16 bytes × 8 bits / 6 bits-per-char ≈ 22 chars). At the 30 req/min rate limit per IP, exhaustive enumeration of the 2^128 space is computationally infeasible. Generation uses `crypto.getRandomValues()`. Custom slugs are human-chosen and short; their security comes from the 7-day cookie (not slug entropy) — per-slug rate limiting is the mitigation for guessing short custom slugs.

### §XII.2 — Brute-force protection

- **Token validation** (`GET /api/share/:token`): CF Rate Limiting at 30 req/min per IP. Invalid tokens always return `404` — no distinction between invalid, expired, or unrecognized.

### §XII.3 — Revocation propagation

Revocation is immediate. The Worker queries `active_shares` (which filters on `revoked_at IS NULL`) on every request — there is no caching of share validity. A revoked share becomes inaccessible on the next request after revocation, within D1 read consistency guarantees.

### §XII.4 — No OTP infrastructure

OTP and email-based recipient verification were considered and ruled out per Cam ruling 2026-05-15. The share token itself is the access credential. No Resend integration, no OTP endpoints, no email enumeration concern.

### §XII.5 — Cookie scoping

The scoped share cookie is:
- `HttpOnly` — not accessible to JavaScript on the page
- `Secure` — HTTPS only
- `SameSite=Lax` — not sent on cross-site requests (prevents CSRF)
- Scoped to `Path=/<slug>` — no other share or path inherits this cookie
- `Max-Age=604800` (7 days; issues fresh cookie on re-visit after expiry if share still active)

### §XII.6 — No Cloudflare Access blanket gate

`phero.skeptou.com/*` is intentionally not behind a blanket Access policy. The management paths (`/manage/*` and `/api/shares*`) are protected by the Worker's session auth check. This is a deliberate deviation from the standard Sképtou private-subdomain pattern; DevOps and QA must verify that the management API cannot be reached without a valid session even though CF Access is not covering it.

### §XII.7 — Upstream document availability

If the upstream energeia or aristeia document is deleted or becomes unavailable after a share is created, `GET /api/share/:token` returns `502 Bad Gateway` (not 404 — the share is still valid, the upstream is the problem). Cam should be able to see in the management UI that a share's upstream document is no longer available (Phase 2+ feature).

---

## §XIII — Phasing

### Phase 1 — D1 schema + create/list/revoke + share serving + viewer + view history

**Scope:** D1 schema applied. Share model fully functional (single model — shareable link + 7-day cookie). Cam can create, list, and revoke shares. Custom slugs and auto-generated random slugs both supported. Per-link view tracking live from day one. Public viewer at `/<slug>`.

**Pre-condition:** energeia `GET /api/papers/:slug/content` and aristeia `GET /api/publications/:slug/content` live (see `brief-energeia-content-endpoint.md`).

**Deliverables:**
- D1 migrations applied; `wrangler d1 info skeptou-phero` shows 3 tables + 1 view
- `POST /api/shares` — create share; custom or auto-generated slug; `label` and `recipient_email` optional annotations; 45-day default expiry
- `GET /api/shares` — list with slug, label, view_count, last_viewed_at
- `DELETE /api/shares/:slug` — revocation (sets `revoked_at`)
- `GET /api/share/:slug` — public serve; issues 7-day scoped cookie; logs to `share_views` (ip_hash, cf_country, user_agent, referrer)
- `validateCustomSlug()` and `generateRandomSlug()` implemented; reserved words rejected at API layer
- CF Rate Limiting on share validation path
- Public viewer at `/<slug>` with PDF.js, download button, expired/revoked pages
- Cam management UI at `/manage` (create + list + revoke + per-share view-history drill-down)
- `ENERGEIA_SERVICE_TOKEN` and `ARISTEIA_SERVICE_TOKEN` provisioned

**Verification:**
- Create share for seeded aristeia publication → visit URL → cookie set → PDF served → download works
- Create share for energeia paper → same
- Create share with custom slug `my-paper-2026` → URL is `phero.skeptou.com/my-paper-2026` → works
- Attempt custom slug `admin` → rejected with validation error ("slug is reserved")
- Attempt custom slug `ab` (too short) → rejected ("slug must be 4–64 characters")
- Create share without custom slug → auto-generated 22-char base64url slug in URL
- Create share with `label = "Search committee — Smith 2026"` → label appears in management list
- Revisit within 7 days → served immediately (cookie present)
- Revoke share → same URL → `410` revoked page
- Share with `expires_at = now + 1 minute` → after expiry → `404` "no longer available"
- View history drill-down: visit share URL → "View history" in management UI shows event row with occurred_at, event_type, cf_country
- Rate limit: 31st request from same IP within a minute → `429`
- Unauthenticated `POST /api/shares` → `403`
- Unauthenticated `GET /api/shares` → `403`

### Phase 2 — Watermarking

**Scope:** Optional per-share PDF watermarking stamped at serve time.

**Deliverables:**
- PDF watermark overlay using `pdf-lib` WASM (for PDFs under 20 MB)
- "Watermark this share" checkbox in create-share form; stored in `shares.metadata`
- Management UI: "watermark applied" or "watermark not applied (document too large)" badge per share
- Optional: Resend notification to Cam when a share is 7 days from expiry

### Phase 3 — Extended analytics (if needed)

**Scope:** Aggregated view-event analytics over the `share_views` table — date-range queries, country breakdowns, referrer grouping. Surfaced as a summary panel in the management UI (distinct from the raw per-event drill-down live in Phase 1).

---

## §XIV — Open questions for Cam

All rev 1 + rev 2 open questions resolved as of 2026-05-15. P-9 and P-10 are new follow-on Qs surfaced by the P-7 ruling.

### Resolved (full history)

| # | Decision | Resolution |
|---|---|---|
| P-1 | **Share model + URL slugs + per-link tracking** | Collapsed to single model: shareable link + 7-day scoped cookie. No anonymous-vs-recipient distinction. Cam-set custom slugs (4–64 chars, reserved-word blocked) or auto-generated 22-char random slugs. `label` annotation field added. Per-link view tracking via `share_views` table (`ip_hash`, `cf_country`, `user_agent`, `referrer`, `occurred_at`); all Phase 1. |
| P-2 | **Snapshot vs. live default** | Live default; snapshot opt-in per share at creation time. |
| P-3 | **Default expiry** | **45 days** (revised twice: 90d → 30d → 45d; Cam ruling 2026-05-15). Overridable per share. |
| P-4 | **View count + last_viewed** | Both displayed in Cam's management UI per share. |
| P-5 | **Revoked link response** | `410 Gone` with styled "This link has been revoked" page (not a generic 404). |
| P-6 | **Watermarking** | Phase 2 only; opt-in per share. No watermarking in Phase 1. |
| P-7 | **OTP / session TTL** | **OTP dropped entirely.** First click → 7-day scoped cookie issued. Re-click after cookie expiry → new 7-day cookie (if share still active). No email verification, no OTP, no Resend integration. |
| P-8 | **URL distribution** | Cam distributes share URL manually. Phero sends nothing — no share URL email, no OTP email in Phase 1. |

### Open (pending Cam ruling)

| # | Question | Blocks | Recommendation |
|---|---|---|---|
| P-9 | **`recipient_email` as optional annotation:** Now that there is no OTP enforcement, `recipient_email` can remain as a Cam-side annotation field — a note to himself ("shared with reviewer@univ.edu on 2026-05-15"). Not enforced for access control; never read during share serving. Keep or drop entirely? | Schema (minor) | Keep as optional annotation; not enforced |
| P-10 | **Future identified-recipient mode:** If Cam later wants identity enforcement for sensitive shares (recommendation letters, search committee dossiers), is that a future phase (building on the existing share infrastructure) or permanently out of scope? | Future | Leave open; don't preemptively build |

---

## §XV — Out of scope

- Storage of any document bytes (phero proxies only; no R2 bucket)
- Generating or editing upstream documents
- Sharing documents from modules other than energeia and aristeia (no strategia reports, no paideia materials, no arbitrary uploads via phero)
- Public index or gallery of Cam's shared documents (each share is a point-to-point link; no discovery surface)
- Analytics visible to recipients (view count is Cam-side only)
- Collaborative annotation or commenting
- Bulk share creation or programmatic slug assignment at scale (individual custom slugs are supported; no batch API)

---

## §XVI — Definition of done

**Phase 1:**
- [ ] D1 `skeptou-phero` created; migrations applied; 3 tables + 1 view verified (`shares`, `share_views`, `audit_log`, `active_shares`)
- [ ] `POST /api/shares` creates share; random or custom slug; `label` and `recipient_email` accepted; 45-day default expiry applied
- [ ] Custom slug validation: `admin` and other reserved words rejected (`409`); slug shorter than 4 chars rejected (`400`); duplicate slug rejected (`409`)
- [ ] Auto-generated slug is 22-char base64url (128-bit CSPRNG); custom slug stored as-is (lowercased, validated)
- [ ] `GET /api/shares` returns shares with slug, label, view_count, last_viewed_at
- [ ] `DELETE /api/shares/:slug` sets `revoked_at`; subsequent `GET /api/share/:slug` returns 410
- [ ] `GET /api/share/:slug` with valid slug: fetches upstream content; streams with `Content-Disposition: attachment`; 7-day scoped cookie (`phero-session-<slug>`) set; `share_views` row inserted with `ip_hash`, `cf_country`, `user_agent` (≤256), `referrer` (≤256)
- [ ] Expired share (`expires_at` in the past) → "no longer available" page; not served
- [ ] Rate limiting: 31st request from same IP in 60s → `429`
- [ ] Unauthenticated `POST /api/shares` → `403`
- [ ] Unauthenticated `GET /api/shares` → `403`
- [ ] Cam management UI lists shares with label, slug (copy-link button), views, last_viewed; revoke button works
- [ ] View-history drill-down: click "View history" → paginated `share_views` panel shows occurred_at, event_type, cf_country, referrer
- [ ] PDF.js viewer renders document in-browser; download button triggers file download with correct filename

**Phase 2:**
- [ ] Watermark checkbox in create-share form; stored in `shares.metadata`
- [ ] PDF ≤ 20 MB: watermark overlay rendered via `pdf-lib` WASM; visible in served PDF
- [ ] PDF > 20 MB: watermark skipped; management UI shows "watermark not applied (document too large)" badge
- [ ] Management UI shows watermark status badge per share
