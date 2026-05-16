# specs/pharo.md — Pharo Document Sharing Interface

**Version:** rev 1
**Status:** draft — awaiting Cam review
**Author:** Lead Dev / Architect — Sképtou
**Date:** 2026-05-16
**Depends on:** `specs/auth-core.md`, `specs/energeia.md`, `specs/arestia.md`, `ARCHITECTURE.md`
**Consumers:** DevOps engineer, Pharo engineer, Cam

---

## §I — Purpose + scope

### §I.1 — What pharo is

`pharo.skeptou.com` (Slot 3 — see Q1 in §XIV) is a controlled, outward-facing sharing layer for canonical documents originating from energeia (papers under development or in pipeline) and arestia (published or archived professional documents). It is **not** a storage system, **not** a CMS, and **not** a general-purpose file host. Pharo holds share metadata; it proxies bytes from upstream sources.

The defining characteristic separating pharo from all other Sképtou modules: **its audience is external recipients** — colleagues, reviewers, search committees, editors, co-authors — who have no auth-core account and no Cloudflare Access credentials. Pharo routes around the Access gate by design: each share URL is either publicly accessible (anonymous model) or gated by a lightweight per-recipient OTP flow (recipient model), neither of which requires an auth-core account.

### §I.2 — What pharo enables

| Scenario | Share model | Notes |
|---|---|---|
| Sending a paper draft to a reviewer | Anonymous or recipient | "Here's a link to my latest draft" |
| Formal submission to search committee (letter, CV) | Recipient | Identity-tracked; recipient email logged |
| Sharing a published PDF with a colleague | Anonymous | Quick link; no verification needed |
| Distributing a preprint to a reading group | Anonymous | Group-wide link; view count tracked |
| Sending a sensitive document (recommendation letter authored by Cam) | Recipient | Single-recipient; watermark at Phase 3 |

### §I.3 — What pharo does not do

- Store documents (bytes live in energeia R2 or arestia R2; pharo proxies, never stores)
- Edit or modify upstream documents
- Grant the recipient write access to anything
- Function as a general file host (only energeia and arestia documents can be shared)
- Serve teaching materials, reports, or internal notes (those belong to paideia and strategia respectively)

### §I.4 — Downloads are permitted

Unlike strategia and arestia (where the posture is in-browser only, no download UI), pharo explicitly permits downloads. Sharing implies the external reader may need the file — a reviewer needs to annotate, a committee member needs to forward, a colleague needs to cite. Pharo's viewer provides a download button alongside the in-browser reader. There is no policy prohibition on saving the document.

---

## §II — Architecture overview

```
pharo.skeptou.com/<token>        ← Public (no Cloudflare Access gate)
  /<token>                       ← Share landing page / viewer
  /<token>/verify                ← Recipient OTP verification page (recipient model only)
  /                              ← Optional: Cam management UI (Access-gated sub-path)

pharo.skeptou.com/api/*          ← Cloudflare Worker (pharo-worker)
  POST   /api/shares             ← Create share (Cam session only)
  GET    /api/shares             ← List Cam's shares (Cam session only)
  DELETE /api/shares/:token      ← Revoke (Cam session only)
  GET    /api/share/:token       ← Validate + proxy document (public or recipient-scoped)
  POST   /api/share/:token/otp   ← Request OTP for recipient model (public)
  POST   /api/share/:token/verify ← Submit OTP, receive scoped cookie (public)
```

**Access gate note:** `pharo.skeptou.com/*` is **not** covered by a blanket Cloudflare Access policy. The public share path (`/<token>`) must be reachable by external recipients without Access credentials. Cam's management UI is handled at the Worker level (session auth check), not at the CF Access layer. This is the only Sképtou module where the Access gate is intentionally not blanket.

**Alternative considered:** a sub-path at `pharo.skeptou.com/manage/*` could be Access-gated while `pharo.skeptou.com/<token>` is public. This is the recommended pattern — DevOps configures Access to bypass on the token path pattern and apply only to `/manage/*` and `/api/shares*`.

**Storage:**

```
D1 (skeptou-pharo)               ← Share metadata, event log, audit log
                                 ← NO R2 — pharo stores nothing
```

**Upstream proxying:**

```
pharo-worker
  ├─ Calls energeia-worker /api/papers/:slug/content    → with ENERGEIA_SERVICE_TOKEN
  └─ Calls arestia-worker  /api/publications/:slug/content → with ARESTIA_SERVICE_TOKEN
```

**Worker bindings (wrangler.toml):**

```toml
[[d1_databases]]
binding = "PHARO_DB"
database_name = "skeptou-pharo"
database_id = "<uuid>"

[vars]
ENERGEIA_BASE_URL = "https://energeia.skeptou.com"
ARESTIA_BASE_URL  = "https://arestia.skeptou.com"
OTP_TTL_MINUTES   = "15"
SHARE_COOKIE_TTL_HOURS = "24"

# Secrets (set via wrangler secret put):
# ENERGEIA_SERVICE_TOKEN
# ARESTIA_SERVICE_TOKEN
# OTP_SIGNING_KEY   (HMAC key for OTP generation — reuse auth-core pattern)
```

---

## §III — Sharing model

### §III.1 — Two models

**Anonymous:** Cam generates a token URL. Anyone with the URL can access the document until the token expires or is revoked. Recipient identity is not verified. View count and timestamps are tracked (no identity). Simplest; appropriate for most informal sharing.

**Recipient:** Cam specifies a `recipient_email` at share creation time. The URL is publicly routable, but accessing it triggers an OTP challenge: the visitor must submit their email, receive a one-time code, and verify it. If the submitted email matches the `recipient_email` on the share record, a scoped cookie is issued and the document is served. Identity is tracked. Appropriate for formal submissions, sensitive documents, search committee materials.

### §III.2 — Recommended default: both, per-share

Recommendation: implement both models; Cam selects at share creation time. The UI defaults to **anonymous** (lower friction; covers 80% of use cases). The recipient toggle is available for items where identity matters.

This is open question Q1 in §XIV.

### §III.3 — Share token

The share token is the sole access credential for a share. Properties:

- **Entropy:** 128 bits from `crypto.getRandomValues()`, base64url-encoded → 22-character URL-safe string
- **Not guessable:** URL-safe random, not derived from document slug or user identity
- **URL form:** `pharo.skeptou.com/<token>` — e.g. `pharo.skeptou.com/aBcDeFgHiJkLmNoPqRsTuV`
- **Single-use for OTP; multi-access for content:** the token itself is permanent until expiry/revocation; the OTP is single-use

```typescript
function generateShareToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}
```

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

This is open question Q2 in §XIV.

---

## §V — D1 schema

### §V.1 — Migration files

Location: `modules/pharo/migrations/`

```
0001_initial_schema.sql
0002_indexes.sql
```

Applied via `wrangler d1 migrations apply skeptou-pharo`.

### §V.2 — `0001_initial_schema.sql`

```sql
-- ============================================================
-- Pharo share metadata — skeptou-pharo D1 database
-- Sképtou / specs/pharo.md rev 1
-- ============================================================

CREATE TABLE IF NOT EXISTS shares (
  share_token        TEXT    PRIMARY KEY,            -- 22-char base64url random; the public URL segment
  source_module      TEXT    NOT NULL CHECK (source_module IN ('energeia','arestia')),
  source_slug        TEXT    NOT NULL,               -- paper/publication slug in upstream module
  source_version     TEXT,                           -- NULL = live; set = snapshot at creation
  share_model        TEXT    NOT NULL DEFAULT 'anonymous'
                             CHECK (share_model IN ('anonymous','recipient')),
  recipient_email    TEXT,                           -- NULL for anonymous; set for recipient model
  label              TEXT,                           -- optional Cam-friendly name for the share in the list view
  expires_at         TEXT,                           -- NULL = no expiry; ISO 8601 timestamp
  view_count         INTEGER NOT NULL DEFAULT 0,
  last_viewed_at     TEXT,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  revoked_at         TEXT,                           -- NULL = active; set on revocation
  metadata           TEXT    NOT NULL DEFAULT '{}'
);

-- OTP records for recipient model (short-lived; auto-purged after use or expiry)
CREATE TABLE IF NOT EXISTS otp_challenges (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  share_token    TEXT    NOT NULL REFERENCES shares(share_token),
  email_hash     TEXT    NOT NULL,       -- SHA-256 of the submitted email (not plaintext)
  code_hash      TEXT    NOT NULL,       -- SHA-256 of the OTP code (not plaintext)
  issued_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at     TEXT    NOT NULL,       -- issued_at + OTP_TTL_MINUTES
  used_at        TEXT,                   -- NULL = unused; set when code is consumed
  attempt_count  INTEGER NOT NULL DEFAULT 0
);

-- Per-view event log (analytics; recipient-model only stores email_hash not plaintext)
CREATE TABLE IF NOT EXISTS share_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  share_token    TEXT    NOT NULL REFERENCES shares(share_token),
  event_type     TEXT    NOT NULL CHECK (event_type IN ('view','download','otp_sent','otp_verified','otp_failed')),
  recipient_hash TEXT,                   -- SHA-256(recipient_email) for recipient model; NULL for anonymous
  ip_hash        TEXT,                   -- SHA-256(CF-Connecting-IP); for rate limiting audit only
  user_agent     TEXT,
  occurred_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Cam-action audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  row_key      TEXT    NOT NULL,          -- share_token
  action       TEXT    NOT NULL CHECK (action IN ('CREATE','REVOKE','UPDATE')),
  actor        TEXT    NOT NULL DEFAULT 'cam',
  snapshot     TEXT    NOT NULL DEFAULT '{}',
  occurred_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
```

**Design notes:**

- `share_token` is the full URL-safe token — also the primary key. No separate `id` column.
- `recipient_email` is stored as plaintext in the `shares` row (Cam created the share; he knows the email). The `share_events` table stores only `SHA-256(email)` for analytics to avoid redundant PII proliferation.
- `otp_challenges.email_hash` — stores `SHA-256(submitted_email)` so the OTP verification can check `submitted_email == share.recipient_email` without a separate lookup by plaintext.
- `otp_challenges.code_hash` — OTP code is never stored as plaintext; HMAC-SHA256 of the code is stored; the Worker HMACs the submitted code and compares.
- `otp_challenges.attempt_count` — incremented on each failed verification; Worker rejects after 5 attempts and issues a new challenge.
- `share_events` logs every access event for analytics (Q5 in §XIV — view_count and last_viewed visible to Cam).
- `shares.revoked_at` — instant revocation; Worker checks this on every request (no caching of share validity state).

### §V.3 — `0002_indexes.sql`

```sql
CREATE INDEX IF NOT EXISTS idx_shares_source        ON shares(source_module, source_slug);
CREATE INDEX IF NOT EXISTS idx_shares_created_at    ON shares(created_at);
CREATE INDEX IF NOT EXISTS idx_shares_expires_at    ON shares(expires_at);
CREATE INDEX IF NOT EXISTS idx_shares_revoked_at    ON shares(revoked_at);
CREATE INDEX IF NOT EXISTS idx_otp_share_token      ON otp_challenges(share_token);
CREATE INDEX IF NOT EXISTS idx_otp_expires_at       ON otp_challenges(expires_at);
CREATE INDEX IF NOT EXISTS idx_events_share_token   ON share_events(share_token);
CREATE INDEX IF NOT EXISTS idx_events_occurred_at   ON share_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_row_key        ON audit_log(row_key);
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
  source_module:    'energeia' | 'arestia';
  source_slug:      string;             // paper/publication slug in upstream
  share_model:      'anonymous' | 'recipient';
  recipient_email?: string;             // required if share_model = 'recipient'
  label?:           string;             // optional human-readable label for Cam's list
  expires_at?:      string | null;      // ISO 8601; null = no expiry; default: now + 90 days
  snapshot_mode?:   boolean;            // false = live (default); true = pin to current version
}
```

**Behavior:**
1. Validate: `recipient_email` must be present if `share_model = 'recipient'`
2. If `snapshot_mode = true`: call upstream metadata endpoint to retrieve current `version` tag; store in `source_version`
3. Generate share token (§III.3)
4. Insert into `shares` and `audit_log` in one `PHARO_DB.batch()`
5. Return share URL and metadata

**Response `201`:**
```json
{
  "data": {
    "share_token": "aBcDeFgHiJkLmNoPqRsTuV",
    "share_url":   "https://pharo.skeptou.com/aBcDeFgHiJkLmNoPqRsTuV",
    "source_module": "arestia",
    "source_slug":   "consciousness-2026-phil-review",
    "source_version": null,
    "share_model":  "anonymous",
    "expires_at":   "2026-08-14T00:00:00Z",
    "created_at":   "2026-05-16T10:00:00Z"
  }
}
```

**Handler sketch:**

```typescript
async function createShare(body: CreateShareBody, actor: string, env: Env): Promise<Response> {
  if (body.share_model === 'recipient' && !body.recipient_email) {
    return Response.json({ error: 'recipient_email required for recipient model' }, { status: 400 });
  }

  let sourceVersion: string | null = null;
  if (body.snapshot_mode) {
    const base  = body.source_module === 'energeia' ? env.ENERGEIA_BASE_URL : env.ARESTIA_BASE_URL;
    const token = body.source_module === 'energeia' ? env.ENERGEIA_SERVICE_TOKEN : env.ARESTIA_SERVICE_TOKEN;
    const path  = body.source_module === 'energeia' ? 'papers' : 'publications';
    const meta  = await fetch(`${base}/api/${path}/${body.source_slug}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!meta.ok) return Response.json({ error: 'upstream document not found' }, { status: 404 });
    const metaJson = await meta.json() as { data: { source_version?: string; version?: string } };
    sourceVersion = metaJson.data.source_version ?? metaJson.data.version ?? null;
  }

  const shareToken = generateShareToken();
  const now        = new Date().toISOString();
  const expiresAt  = body.expires_at !== undefined
    ? body.expires_at
    : new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

  await env.PHARO_DB.batch([
    env.PHARO_DB.prepare(
      `INSERT INTO shares (share_token, source_module, source_slug, source_version, share_model, recipient_email, label, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(shareToken, body.source_module, body.source_slug, sourceVersion,
           body.share_model, body.recipient_email ?? null, body.label ?? null, expiresAt),
    env.PHARO_DB.prepare(
      `INSERT INTO audit_log (row_key, action, actor, snapshot) VALUES (?, 'CREATE', ?, ?)`
    ).bind(shareToken, actor, JSON.stringify({ ...body, source_version: sourceVersion })),
  ]);

  return Response.json({
    data: {
      share_token:    shareToken,
      share_url:      `https://pharo.skeptou.com/${shareToken}`,
      source_module:  body.source_module,
      source_slug:    body.source_slug,
      source_version: sourceVersion,
      share_model:    body.share_model,
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
| `source_module` | Filter: `energeia` or `arestia` |
| `active` | `true` = active only (non-revoked, non-expired); `false` = all |
| `share_model` | Filter: `anonymous` or `recipient` |
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

After revocation, `GET /api/share/:token` returns the revocation response (configurable — see Q6 in §XIV).

---

### §VI.4 — `GET /api/share/:token` — Public share access

**Auth:** No auth-core required. Public endpoint. For recipient model: requires scoped share cookie.

This is the primary endpoint hit when a recipient visits `pharo.skeptou.com/<token>`.

**Rate limiting:** enforced at the Cloudflare layer. Recommended: 30 requests/minute per IP on this path; `429` on breach. This prevents token enumeration.

**Validation sequence:**

```
1. Look up share_token in active_shares view
   → NOT FOUND (invalid or expired):  → 404 (never distinguish invalid vs expired)
   → FOUND, revoked_at IS NOT NULL:   → 410 Gone (or 404 — Q6 in §XIV)

2. If share_model = 'recipient':
   → Check for valid scoped share cookie (HMAC-signed: share_token + recipient_email hash)
   → NOT PRESENT:          → redirect to /<token>/verify (OTP challenge page)
   → PRESENT + VALID:      → continue
   → PRESENT + INVALID:    → redirect to /<token>/verify

3. Fetch upstream document:
   → source_module = 'energeia': GET energeia /api/papers/:slug/content[?version=...]
   → source_module = 'arestia':  GET arestia  /api/publications/:slug/content[?version=...]

4. Update D1 (non-blocking — use ctx.waitUntil()):
   → INCREMENT view_count, SET last_viewed_at
   → INSERT share_events row

5. Stream upstream response to recipient with adjusted headers:
   → Content-Type: <from upstream>
   → Content-Disposition: attachment; filename="<slug>.pdf"  (download permitted)
   → Cache-Control: private, no-store
   → X-Share-Token: <first 8 chars of token> (audit aid, not secret)
```

Note: `Content-Disposition: attachment` (vs `inline` in strategia/arestia) enables the browser's save-file dialog. Cam wants downloads permitted for shared documents.

**Handler sketch (simplified):**

```typescript
async function serveShare(token: string, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // 1. Validate token
  const share = await env.PHARO_DB.prepare(
    `SELECT * FROM active_shares WHERE share_token = ?`
  ).bind(token).first<ShareRow | null>();

  if (!share) return notFoundResponse(); // 404 — no enumeration

  // 2. Recipient model gate
  if (share.share_model === 'recipient') {
    const cookie = getCookie(request, `pharo-session-${token}`);
    if (!cookie || !validateShareCookie(cookie, token, share.recipient_email!, env)) {
      return Response.redirect(`https://pharo.skeptou.com/${token}/verify`, 302);
    }
  }

  // 3. Fetch from upstream
  const base    = share.source_module === 'energeia' ? env.ENERGEIA_BASE_URL : env.ARESTIA_BASE_URL;
  const svcTok  = share.source_module === 'energeia' ? env.ENERGEIA_SERVICE_TOKEN : env.ARESTIA_SERVICE_TOKEN;
  const path    = share.source_module === 'energeia' ? 'papers' : 'publications';
  const vParam  = share.source_version ? `?version=${share.source_version}` : '';

  const upstream = await fetch(`${base}/api/${path}/${share.source_slug}/content${vParam}`, {
    headers: { Authorization: `Bearer ${svcTok}` },
  });

  if (!upstream.ok) {
    return Response.json({ error: 'upstream document unavailable' }, { status: 502 });
  }

  const contentType = upstream.headers.get('Content-Type') ?? 'application/octet-stream';
  const ext         = contentType.includes('pdf') ? 'pdf' : contentType.includes('markdown') ? 'md' : 'bin';
  const filename    = `${share.source_slug}.${ext}`;

  // 4. Non-blocking analytics update
  ctx.waitUntil(
    env.PHARO_DB.batch([
      env.PHARO_DB.prepare(
        `UPDATE shares SET view_count = view_count + 1, last_viewed_at = ? WHERE share_token = ?`
      ).bind(new Date().toISOString(), token),
      env.PHARO_DB.prepare(
        `INSERT INTO share_events (share_token, event_type, ip_hash, user_agent)
         VALUES (?, 'view', ?, ?)`
      ).bind(token, sha256(request.headers.get('CF-Connecting-IP') ?? ''), request.headers.get('User-Agent')),
    ])
  );

  // 5. Stream
  return new Response(upstream.body, {
    headers: {
      'Content-Type':           contentType,
      'Content-Disposition':    `attachment; filename="${filename}"`,
      'Cache-Control':          'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
```

---

### §VI.5 — `POST /api/share/:token/otp` — Request OTP (recipient model)

**Auth:** none. Public endpoint.

**Rate limiting:** 5 OTP requests per IP per 10-minute window (prevents recipient_email enumeration via timing).

**Request body:**
```json
{ "email": "reviewer@university.edu" }
```

**Behavior:**
1. Look up share in `active_shares`; if not found → `404`
2. If `share_model != 'recipient'` → `400`
3. **Always respond:** `{ "message": "If that email matches, a code has been sent" }` — never reveal whether the email matched. If the email does NOT match `share.recipient_email`, the Worker still returns the same message and does nothing (email enumeration protection)
4. If email matches: generate 6-digit OTP → HMAC-SHA256(code + share_token + OTP_SIGNING_KEY) → insert `otp_challenges` row → send code via Resend to `recipient_email`
5. Log `otp_sent` event in `share_events`

**Response `200`:**
```json
{ "message": "If that email matches, a code has been sent." }
```

---

### §VI.6 — `POST /api/share/:token/verify` — Submit OTP

**Auth:** none. Public endpoint.

**Request body:**
```json
{ "email": "reviewer@university.edu", "code": "847291" }
```

**Behavior:**
1. Look up share in `active_shares`; if not found → `404`
2. Look up most recent active (unused, unexpired) `otp_challenges` row for `(share_token, SHA-256(email))`
3. Verify: HMAC-SHA256(submitted_code + share_token + OTP_SIGNING_KEY) == `code_hash`
4. If mismatch: increment `attempt_count`; if `attempt_count >= 5` mark challenge as used (force re-issue); return `401`
5. If match: mark challenge `used_at = now()` → issue scoped share cookie → log `otp_verified` event

**Scoped share cookie:**
```
Set-Cookie: pharo-session-<token>=<HMAC-signed-value>; HttpOnly; Secure; SameSite=Lax; Max-Age=86400; Path=/<token>
```

The cookie is scoped to the `/<token>` path — it grants access only to this specific share, not to any other share or any other part of the site. TTL: 24 hours (configurable).

**Response `200`:**
```json
{ "message": "verified", "redirect": "https://pharo.skeptou.com/<token>" }
```

Client-side JS on the verify page reads `redirect` and navigates there.

---

## §VII — Recipient model UX flow

### §VII.1 — Full flow for a recipient

1. Cam creates a recipient share → receives `share_url`
2. Cam sends the URL to the recipient via email (pharo does not auto-email the share URL to the recipient — Cam distributes it manually)
3. Recipient visits `pharo.skeptou.com/<token>`
4. Worker checks for valid scoped cookie → none found → redirects to `/<token>/verify`
5. Verify page renders: "Enter your email to access this document"
6. Recipient types their email → `POST /api/share/<token>/otp` → "If that email matches, a code has been sent"
7. Resend delivers OTP to `recipient_email`
8. Recipient enters 6-digit code → `POST /api/share/<token>/verify` → scoped cookie set → redirect to `/<token>`
9. Worker validates scoped cookie → serves document
10. On subsequent visits within 24h: scoped cookie present → serve immediately (no OTP re-challenge)

### §VII.2 — Verify page UX

The verify page is a minimal, cleanly styled static form. No Sképtou branding that would expose Cam's infrastructure to external viewers. Consider a neutral design (black text, white background, no Borges fonts — those require the Access-gated subdomain context).

Recommended text:
> "A link has been shared with you. Enter your email address to receive a verification code."

Error states: "That email does not match the share record." (shown only after N failed attempts, not on first try — preserves email enumeration protection at the UX level).

---

## §VIII — In-browser viewer

### §VIII.1 — Public viewer

The share landing page at `/<token>` renders the document in-browser **and** provides a download button. Unlike strategia and arestia (which suppress download), pharo's viewer is a sharing surface — the point is for the recipient to have the document.

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

When a token is invalid, expired, or revoked, the Worker returns a styled page (not a raw 404 JSON response). Recommended text: "This link is no longer available." (open question Q6 in §XIV — revoked vs expired vs invalid may warrant different messages).

---

## §IX — Cam management UI

### §IX.1 — Scope

A simple management interface at `pharo.skeptou.com/manage` (behind session auth gate in the Worker, not a CF Access gate). Lists all of Cam's shares with:

| Column | Source |
|---|---|
| Label / Document | `label` or `source_slug` |
| Source | `source_module` badge |
| Model | `anonymous` or `recipient` badge; recipient shows email |
| Created | `created_at` |
| Expires | `expires_at` or "No expiry" |
| Views | `view_count` |
| Last viewed | `last_viewed_at` (relative) |
| Status | Active / Expired / Revoked |
| Actions | Copy link, Revoke |

### §IX.2 — Create share form

A form at `/manage/new` that maps to `POST /api/shares`:
- Source module dropdown (energeia / arestia)
- Source document dropdown (fetched from upstream paper/publication list)
- Share model toggle (Anonymous / Recipient)
- Recipient email (shown only when Recipient selected)
- Label (optional)
- Expiry picker (defaults to 90 days; can be set to no expiry)
- Pin to current version checkbox (snapshot mode)

---

## §X — Watermarking (Phase 3)

### §X.1 — Scope

Optional PDF overlay for recipient-model shares. At serve time, the Worker uses a PDF manipulation library (`pdf-lib` compiled to WASM, or a lightweight overlay approach) to stamp recipient-identifying text onto each page before streaming.

Watermark content:
```
Shared with: reviewer@university.edu
Link: pharo.skeptou.com/<first-8-chars-of-token>
Date: 2026-05-16
```

Placed as a semi-transparent footer on each page. Does not modify the upstream R2 object; generated in-memory per request.

### §X.2 — Practical constraints

- PDF manipulation in a Worker adds latency and memory pressure. For large PDFs (50–80MB), this may approach Worker memory limits.
- Recommendation: implement watermarking only for PDFs under 20MB in Phase 3; surface a "watermark not applied — document too large" note in the management UI for larger files.
- Watermarking is opt-in per share (Cam checks "Watermark this share" at creation time). Not all recipient-model shares need it.

This is open question Q4 in §XIV.

---

## §XI — Auth + scopes

### §XI.1 — Cam session (write operations)

`POST /api/shares`, `GET /api/shares`, `DELETE /api/shares/:token`, `/manage/*` all require a session cookie. The Worker's `requireCamSession()` check is the same as arestia (§IX.1 of the arestia spec). No service tokens for Cam-facing write operations.

### §XI.2 — Public access (share serving)

`GET /api/share/:token`, `POST /api/share/:token/otp`, `POST /api/share/:token/verify`, and the viewer pages (`/<token>`, `/<token>/verify`) are publicly accessible — no auth-core session, no Access challenge. This is the intentional architectural departure from all other Sképtou modules.

### §XI.3 — Worker-to-Worker service tokens

`ENERGEIA_SERVICE_TOKEN` and `ARESTIA_SERVICE_TOKEN` are Worker secrets used only in the server-side upstream fetch. Never returned in any API response. Scoped for read-only access to the respective module's content endpoints.

---

## §XII — Security posture

### §XII.1 — Token entropy

128-bit random token (§III.3). At 30 requests/minute rate limit per IP, exhaustive enumeration of the 2^128 token space is computationally infeasible. Token generation uses `crypto.getRandomValues()` (CSPRNG).

### §XII.2 — Brute-force protection

- **Token validation** (`GET /api/share/:token`): CF Rate Limiting at 30 req/min per IP. Invalid tokens always return `404` — no distinction between invalid, expired, or unrecognized.
- **OTP requests** (`POST /api/share/:token/otp`): 5 requests per IP per 10 minutes.
- **OTP verification** (`POST /api/share/:token/verify`): 5 attempts per challenge; lockout forces re-issue.

### §XII.3 — Revocation propagation

Revocation is immediate. The Worker queries `active_shares` (which filters on `revoked_at IS NULL`) on every request — there is no caching of share validity. A revoked share becomes inaccessible on the next request after revocation, within D1 read consistency guarantees.

### §XII.4 — Email enumeration protection

The OTP request endpoint (`POST /api/share/:token/otp`) always returns `200` with the same message regardless of whether the submitted email matched the share's `recipient_email`. Response timing must be consistent — if there is no email match (no Resend call), the Worker should insert a short artificial delay to prevent timing-based enumeration. Recommended: `await new Promise(r => setTimeout(r, 200))` before responding when no match.

### §XII.5 — Cookie scoping

The scoped share cookie is:
- `HttpOnly` — not accessible to JavaScript on the page
- `Secure` — HTTPS only
- `SameSite=Lax` — not sent on cross-site requests (prevents CSRF)
- Scoped to `Path=/<token>` — no other share or path inherits this cookie
- `Max-Age=86400` (24 hours, configurable)

### §XII.6 — No Cloudflare Access blanket gate

`pharo.skeptou.com/*` is intentionally not behind a blanket Access policy. The management paths (`/manage/*` and `/api/shares*`) are protected by the Worker's session auth check. This is a deliberate deviation from the standard Sképtou private-subdomain pattern; DevOps and QA must verify that the management API cannot be reached without a valid session even though CF Access is not covering it.

### §XII.7 — Upstream document availability

If the upstream energeia or arestia document is deleted or becomes unavailable after a share is created, `GET /api/share/:token` returns `502 Bad Gateway` (not 404 — the share is still valid, the upstream is the problem). Cam should be able to see in the management UI that a share's upstream document is no longer available (Phase 2+ feature).

---

## §XIII — Phasing

### Phase 1 — D1 schema + create/list/revoke + anonymous share + viewer

**Scope:** D1 schema applied. Anonymous share model fully functional. Cam can create, list, and revoke shares. Public viewer at `/<token>` serves and downloads documents. View tracking live.

**Deliverables:**
- D1 migrations applied; `wrangler d1 info skeptou-pharo` shows 4 tables + 1 view
- `POST /api/shares` (anonymous model only in Phase 1)
- `GET /api/shares` list with filters
- `DELETE /api/shares/:token` revocation
- `GET /api/share/:token` public serve + view tracking (anonymous model)
- CF Rate Limiting rules on token validation path
- Public viewer at `/<token>` with PDF.js, download button
- Expired/revoked page
- Cam management UI at `/manage` (create + list + revoke)
- `ENERGEIA_SERVICE_TOKEN` and `ARESTIA_SERVICE_TOKEN` provisioned + validated

**Pre-condition:** energeia and arestia read endpoints (`GET /api/papers/:slug/content`, `GET /api/publications/:slug/content`) must be live.

**Verification:**
- Create anonymous share for a seeded arestia publication → share URL returns PDF → download works
- Create anonymous share for an energeia paper → same
- Revoke share → same URL returns "no longer available" page
- Share with `expires_at = now + 1 minute` → after expiry, URL returns "no longer available"
- Rate limit: 31st request from same IP within a minute → `429`
- Unauthenticated `GET /api/shares` → `403`

### Phase 2 — Recipient model + OTP flow

**Scope:** Recipient share model with email OTP verification. Scoped session cookie. Resend integration for OTP delivery.

**Pre-condition:** Resend API key provisioned; auth-core OTP infrastructure reusable or adapted.

**Deliverables:**
- `POST /api/shares` extended to accept `share_model = 'recipient'` + `recipient_email`
- `POST /api/share/:token/otp` + `POST /api/share/:token/verify` endpoints
- OTP generation, hashing, storage, validation
- Scoped share cookie issuance
- Verify page UI at `/<token>/verify`
- Rate limiting on OTP endpoints
- `share_events` table populated with `otp_sent`, `otp_verified`, `otp_failed` events
- Management UI: recipient model badge + email display on share list

**Verification:**
- Create recipient share for `reviewer@test.com` → visit URL → redirected to verify page
- Submit wrong email → "If that email matches, a code has been sent" (same response as correct email)
- Submit correct email → OTP delivered to `recipient_email` → enter code → redirect to viewer → document served
- 5 failed OTP attempts → challenge locked; re-submit email to get new code
- Valid scoped cookie on subsequent visit → document served without OTP re-challenge
- Expired cookie (max-age elapsed) → redirected to verify page again

### Phase 3 — Watermarking + analytics

**Scope:** Optional per-share PDF watermarking (recipient model). View analytics in management UI (per-share event log). Share expiry notifications (email Cam when a share is about to expire — optional).

**Deliverables:**
- PDF watermark overlay using `pdf-lib` WASM (PDFs under 20MB)
- "Watermark" checkbox in create-share form (recipient model only)
- Per-share analytics page in management UI showing view events timeline
- Optional: Resend notification to Cam 7 days before share expiry

### Phase 4 — Per-recipient view dashboards (if useful)

**Scope:** Extended analytics. Per-share breakdown of view events by recipient hash, date, approximate geography (from CF request metadata). Surfaced in management UI as a detail panel.

---

## §XIV — Open questions for Cam

| # | Question | Blocks | Recommendation |
|---|---|---|---|
| Q1 | **Module name / slot:** Cam uses "pharo" — possible root φαρός (pharos = lighthouse/beacon). The CLAUDE.md module roster at Slot 3 has `phero.skeptou.com` (φέρω = to carry/bear). Is "pharo" the correct name for this module? Or is the subdomain `phero.skeptou.com`? | DNS / module wiring | Use Cam's "pharo" spelling; update CLAUDE.md Slot 3 to match |
| Q2 | **Anonymous vs. recipient vs. both as default:** Recommendation is both, with anonymous as default in the create UI. Confirm. | Phase 1 scope | Both; anonymous default |
| Q3 | **Snapshot vs. live default:** Recommendation is live (share resolves to current canonical). Snapshot opt-in via checkbox at create time. Confirm. | Phase 1 schema | Live default; snapshot opt-in |
| Q4 | **Default expiry duration:** Recommendation is 90 days default (close to auth-core service token TTL). Options: 30 days, 90 days, 1 year, no expiry. Cam can override per share. | Phase 1 create-share form | 90-day default |
| Q5 | **View count + last_viewed visible to Cam:** management UI should show view_count and last_viewed_at per share. Confirm. | Phase 1 management UI | Yes — show both |
| Q6 | **Revoked link response:** when a recipient visits a revoked share, return (a) `410 Gone` with a styled "This link has been revoked" page, or (b) same `404`-style "no longer available" page (no distinction). Recommendation: (a) — distinct revocation page is more informative and professionally appropriate. | Phase 1 revocation handler | (a) distinct 410 page |
| Q7 | **Watermarking opt-in:** watermarking is Phase 3 and opt-in per share. Confirm this is acceptable; no expectation of watermarking in Phase 1 or 2. | Phase 3 scope | Phase 3; opt-in per share |
| Q8 | **OTP TTL:** recommendation is 15 minutes for the OTP code and 24 hours for the scoped session cookie. Confirm. | Phase 2 OTP flow | 15 min OTP; 24h cookie |
| Q9 | **Cam distributes share URL manually:** pharo does not send the share URL to the recipient — Cam copies and pastes or emails it himself. Pharo only sends the OTP email (for recipient model) and that only after the recipient visits the URL. Confirm this is the intended UX. | Phase 1 create-share response | Yes — Cam distributes URL manually |

---

## §XV — Out of scope

- Storage of any document bytes (pharo proxies only; no R2 bucket)
- Generating or editing upstream documents
- Sharing documents from modules other than energeia and arestia (no strategia reports, no paideia materials, no arbitrary uploads via pharo)
- Public index or gallery of Cam's shared documents (each share is a point-to-point link; no discovery surface)
- Analytics visible to recipients (view count is Cam-side only)
- Collaborative annotation or commenting
- Bulk share creation or programmatic share API (no service tokens on the write side)
- Short-URL / vanity URL customization (token is random; no `pharo.skeptou.com/my-paper`)

---

## §XVI — Definition of done

**Phase 1:**
- [ ] D1 `skeptou-pharo` created; migrations applied; 4 tables + 1 view verified
- [ ] `POST /api/shares` creates anonymous share; returns share URL with valid token
- [ ] `GET /api/shares` returns created shares with view_count and last_viewed_at
- [ ] `DELETE /api/shares/:token` sets `revoked_at`; subsequent `GET /api/share/:token` returns 410/404
- [ ] `GET /api/share/:token` with valid anonymous token: fetches from energeia and arestia respectively; streams PDF with `Content-Disposition: attachment`; increments view_count
- [ ] Expired share (`expires_at` in the past) → "no longer available" page; not served
- [ ] Rate limiting: 31st request from same IP in 60s → `429`
- [ ] Unauthenticated `POST /api/shares` → `403`
- [ ] Cam management UI lists shares; copy-link works; revoke button works
- [ ] PDF.js viewer renders document in-browser; download button triggers file download

**Phase 2:**
- [ ] Recipient share created with `recipient_email`; management UI shows recipient email badge
- [ ] Visiting recipient share URL without cookie → redirected to verify page
- [ ] Submitting wrong email → same "If that email matches" response as correct email (timing consistent)
- [ ] Submitting correct email → OTP delivered via Resend to `recipient_email`
- [ ] Valid OTP → scoped cookie set; redirected to viewer; document served
- [ ] Invalid OTP × 5 → challenge locked; new email submission required
- [ ] Valid scoped cookie on return visit → document served without re-challenge
- [ ] `share_events` table shows otp_sent, otp_verified rows for the flow

**Phase 3:**
- [ ] Watermark checkbox in create form (recipient model only)
- [ ] PDF ≤ 20MB: watermark overlay visible on page bottom of served PDF
- [ ] PDF > 20MB: watermark skipped; management UI notes "watermark not applied"
- [ ] Per-share view timeline in management UI detail panel
