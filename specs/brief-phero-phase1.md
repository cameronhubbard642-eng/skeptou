# specs/brief-phero-phase1.md — Phero Engineer Brief, Phase 1

**Version:** rev 1
**Status:** ready for implementation
**Author:** Lead Dev / Architect — Sképtou
**Date:** 2026-05-17
**Spec:** `specs/phero.md` rev 3
**Phase:** 1 of 3
**Tier:** Sonnet

---

## Mission

Build `phero.skeptou.com` Phase 1: D1 schema, share create/list/revoke endpoints (Cam-only), public share-serving endpoint with 7-day scoped cookie, PDF.js viewer, Cam management UI. Single sharing model — shareable link + cookie. No OTP, no Resend, no watermarking.

**Phase 2 (watermarking + analytics) waits on P-9 ruling. Phase 1 ships as described here.**

---

## Pre-conditions (must be live before Phase 1 can complete verification)

- `GET /api/papers/:slug/content` live on energeia (see `brief-energeia-content-endpoint.md`)
- `GET /api/publications/:slug/content` live on aristeia (aristeia Phase 1 complete)

Phase 1 can be built and deployed in parallel with energeia/aristeia; end-to-end verification requires both upstream endpoints live.

---

## Deliverables

1. D1 database `skeptou-phero` created; migrations applied (3 tables + 1 view)
2. Worker: `POST /api/shares`, `GET /api/shares`, `DELETE /api/shares/:token`
3. Worker: `GET /api/share/:token` — public serve with 7-day scoped cookie
4. CF Rate Limiting on `GET /api/share/:token` (30 req/min per IP)
5. Public viewer at `/<token>`: PDF.js + download button + expired/revoked pages
6. Cam management UI at `/manage`: create form, share list, revoke

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
      serve.ts        ← GET /api/share/:token (public)
      auth.ts
    lib/
      token.ts        ← generateShareToken()
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
CREATE TABLE IF NOT EXISTS shares (
  share_token        TEXT    PRIMARY KEY,
  source_module      TEXT    NOT NULL CHECK (source_module IN ('energeia','aristeia')),
  source_slug        TEXT    NOT NULL,
  source_version     TEXT,                  -- NULL = live; set = snapshot at creation
  recipient_email    TEXT,                  -- optional Cam annotation; never enforced
  label              TEXT,
  expires_at         TEXT,                  -- NULL = no expiry; default 30 days from creation
  view_count         INTEGER NOT NULL DEFAULT 0,
  last_viewed_at     TEXT,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  revoked_at         TEXT,
  metadata           TEXT    NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS share_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  share_token    TEXT    NOT NULL REFERENCES shares(share_token),
  event_type     TEXT    NOT NULL CHECK (event_type IN ('view','download')),
  ip_hash        TEXT,
  user_agent     TEXT,
  occurred_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

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
CREATE INDEX IF NOT EXISTS idx_events_token      ON share_events(share_token);

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

## Token generation

```typescript
// src/lib/token.ts
export function generateShareToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
```

## Cookie signing

```typescript
// src/lib/cookie.ts
export async function signShareCookie(token: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(token));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function validateShareCookie(
  cookieValue: string, token: string, key: string
): Promise<boolean> {
  const expected = await signShareCookie(token, key);
  // Constant-time compare
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
{
  source_module:    'energeia' | 'aristeia';
  source_slug:      string;
  recipient_email?: string;    // optional annotation only
  label?:           string;
  expires_at?:      string | null;   // ISO 8601; null = no expiry; omit = 30-day default
  snapshot_mode?:   boolean;         // default false (live)
}
```

Default `expires_at`: `new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()`

If `snapshot_mode = true`: fetch upstream metadata to get current version tag; store in `source_version`.

Response `201`:
```json
{
  "share_token": "aBcDeFgHiJkLmNoPqRsTuV",
  "share_url":   "https://phero.skeptou.com/aBcDeFgHiJkLmNoPqRsTuV",
  "source_module": "aristeia",
  "source_slug":   "hubbard-2024-grounding",
  "source_version": null,
  "expires_at":    "2026-06-16T00:00:00Z",
  "created_at":    "2026-05-17T10:00:00Z"
}
```

---

## Handler: `GET /api/shares` (Cam session only)

Query params: `source_module`, `limit` (default 50), `offset`.

Returns all shares (including revoked/expired) ordered by `created_at DESC`, with `view_count`, `last_viewed_at`, `revoked_at`. Cam needs to see expired/revoked shares to understand history.

---

## Handler: `DELETE /api/shares/:token` (Cam session only)

Sets `revoked_at = now()` and appends to `audit_log`. Does not delete the row (needed for audit). Returns `200`.

---

## Handler: `GET /api/share/:token` (public)

**Rate limit:** 30 req/min per IP at CF layer.

```
1. Look up in active_shares view
   → NOT FOUND:     404 — serve expired.html  
   → revoked_at set (won't appear in active_shares, but check shares directly):
                    410 — serve revoked.html

2. Check scoped cookie: phero-session-<token>
   → valid HMAC:    skip to step 4
   → absent/invalid: issue new cookie (step 3), continue

3. Set-Cookie: phero-session-<token>=<HMAC>; HttpOnly; Secure; SameSite=Lax;
               Max-Age=604800; Path=/<token>

4. Fetch from upstream:
   energeia: GET {ENERGEIA_BASE_URL}/api/papers/{slug}/content[?version=...]
   aristeia:  GET {ARISTEIA_BASE_URL}/api/publications/{slug}/content[?version=...]
   Authorization: Bearer {SERVICE_TOKEN}

5. ctx.waitUntil() → UPDATE view_count + INSERT share_events

6. Stream with:
   Content-Type:        <from upstream>
   Content-Disposition: attachment; filename="<slug>.pdf"
   Cache-Control:       private, no-store
   Set-Cookie:          (from step 3, if new cookie issued)
```

Note: check `revoked_at` directly in `shares` table (not only `active_shares`) so revoked shares get `410` rather than `404`.

---

## Viewer UI

**`/<token>` — viewer (`share/viewer.html`):**
- On load: the document is already streaming (the Worker served it via `Content-Disposition: attachment`)
- The viewer page is for in-browser reading alongside the download. Render with PDF.js.
- Download button: `<a href="/<token>/download">Download PDF</a>` — alternatively use the browser's built-in save affordance from the attachment disposition.
- No Sképtou branding on this page — external recipients should not see internal infrastructure names.

**`/expired` — expired.html:** "This link is no longer available." Minimal styling.

**`/revoked` — revoked.html (410):** "This link has been revoked." Minimal styling.

**`/manage` — management UI (Access-gated):**
- Create share form: source_module dropdown, source_slug input, label input, expires_at picker, snapshot_mode checkbox, recipient_email (optional annotation)
- Share list: token (truncated), label, source, view_count, last_viewed_at, expires_at, revoked badge, copy-link button, revoke button
- Revoke confirmation dialog before `DELETE /api/shares/:token`

---

## Access gate — management only

`phero.skeptou.com/*` is **not** behind a blanket CF Access policy. Management paths only:

DevOps configures CF Access to apply only to:
- `phero.skeptou.com/manage/*`
- `phero.skeptou.com/api/shares*` (management API)

Public paths bypass Access:
- `phero.skeptou.com/<token>` (22-char token path)
- `phero.skeptou.com/api/share/*`

Worker's `requireCamSession()` check provides the auth layer for management API even though CF Access is also on it (defence in depth).

---

## Wrangler setup commands

```bash
wrangler d1 create skeptou-phero
# Paste database_id into wrangler.toml

wrangler d1 migrations apply skeptou-phero --remote
wrangler r2 bucket create skeptou-phero  # Not needed — phero has no R2

# Verify schema
wrangler d1 info skeptou-phero
# Expect: shares, share_events, audit_log, active_shares

# Provision secrets
echo "<energeia-service-token>" | wrangler secret put ENERGEIA_SERVICE_TOKEN
echo "<aristeia-service-token>" | wrangler secret put ARISTEIA_SERVICE_TOKEN
openssl rand -hex 32 | wrangler secret put COOKIE_SIGNING_KEY
```

---

## Phase 1 definition of done

- [ ] `wrangler d1 info skeptou-phero` shows `shares`, `share_events`, `audit_log`, `active_shares`
- [ ] `POST /api/shares` creates share; response includes `share_url`
- [ ] `GET /api/shares` returns created share with `view_count = 0`
- [ ] `GET /api/share/<token>` (energeia source): fetches PDF from energeia; 7-day cookie set; view_count incremented; download triggers save dialog
- [ ] `GET /api/share/<token>` (aristeia source): same
- [ ] Return visit within 7 days: cookie present; served immediately; no new cookie issued
- [ ] Cookie expired / cleared: new 7-day cookie issued on next visit (if share still active)
- [ ] `DELETE /api/shares/:token`: sets `revoked_at`; subsequent `GET /api/share/:token` → 410 revoked page
- [ ] Share with `expires_at = now + 1 minute`: after expiry → 404 expired page
- [ ] Rate limit: 31st request from same IP within 60s → 429
- [ ] Unauthenticated `POST /api/shares` → 403
- [ ] Management UI: create share, copy link, revoke — all work end-to-end
- [ ] Public viewer renders PDF in-browser alongside download button
- [ ] CF Access gate on `/manage/*` verified by QA (desktop, mobile, incognito)

---

## Out of scope (Phase 1)

- Watermarking — Phase 2
- Per-share analytics timeline — Phase 2
- Identified-recipient mode (P-10) — future / open Q
- Resend integration — not planned (P-7 ruled out OTP/email)
