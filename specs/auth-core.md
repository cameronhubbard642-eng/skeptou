# Module Spec — `auth-core`

**Owner:** Lead Dev / Architect  
**Status:** DRAFT — ready for engineer review  
**Last revised:** 2026-05-13 (rev 1 — email-only; 30-day sliding session; bespoke auth replacing CF Access)

---

## §I. Purpose and Scope

`auth-core` is the bespoke authentication system for the entire Sképtou subdomain constellation and Glossolalia PWAs. It replaces Cloudflare Access as the gating mechanism for all private subdomains.

The design is a single Worker codebase deployed twice with per-deployment configuration: `auth.skeptou.com` and `auth.glossolalia.dev`. Each deployment manages its own allowlist, KV namespace, cookie domain, and branding. Sub-apps validate sessions by importing `@skeptou/auth-client` — a shared library that validates HMAC-signed cookies without any per-request KV lookup, keeping authenticated-request overhead negligible.

**Magic-link model:** There are no passwords. Authentication is email-only. A visitor submits their email; if it is on the allowlist, a one-time magic link is sent via Resend. Clicking the link issues a session cookie. The session cookie is HMAC-signed and domain-scoped; every authenticated request validates it in-process with no network call.

**In scope (v1):**
- `auth.skeptou.com` and `auth.glossolalia.dev` deployments from one Worker source
- Admin-managed allowlist (KV-backed; no self-signup)
- Email magic link delivery via Resend
- HMAC-SHA256-signed session cookies; 30-day sliding TTL; 90-day absolute cap
- `@skeptou/auth-client` shared library (Quartz / Worker sub-apps import this)
- Rate limiting (token-bucket per email, per IP)
- Structured audit log (KV append; optional R2 export)
- Bootstrap CLI script (first allowlist entry + first secret rotation)
- Glossolalia migration path from current auth

**Out of scope (v1):**
- SMS / Twilio / A2P 10DLC (dropped entirely)
- Phone number field anywhere in any data model
- Passkeys / WebAuthn (v2)
- Self-service registration
- OAuth / SSO (v3)
- Multi-factor beyond magic link
- Admin UI (allowlist managed via Worker Admin API or wrangler KV commands)

---

## §II. Deployment Model

One Worker source tree; two Wrangler environments.

### §II.1 Directory layout

```
auth-worker/
  src/
    index.ts               ← request router
    handlers/
      login.ts             ← POST /login
      verify.ts            ← GET /verify
      logout.ts            ← POST /logout
      session.ts           ← GET /session
      admin/
        allowlist.ts       ← GET/PUT/DELETE /admin/allowlist
        audit.ts           ← GET /admin/audit
    lib/
      hmac.ts              ← sign / verify HMAC-SHA256
      token.ts             ← generate / parse magic tokens
      session.ts           ← cookie encode / decode / refresh
      allowlist.ts         ← KV allowlist CRUD helpers
      resend.ts            ← Resend email client wrapper
      ratelimit.ts         ← token-bucket rate limiter
      audit.ts             ← audit log append
      brand.ts             ← branding helpers
    middleware/
      requireAdmin.ts      ← admin-route guard
      cors.ts              ← CORS headers per deployment
  templates/
    login.html             ← magic link request page
    check-email.html       ← "check your email" page
    verify-success.html    ← post-verify landing (redirect target)
    verify-error.html      ← expired / already-used token
    logout.html            ← logout confirmation
  packages/
    auth-client/           ← @skeptou/auth-client (publishable)
      src/
        index.ts           ← validateSession() / requireAuth()
        types.ts
      package.json
      tsconfig.json
  wrangler.toml
  package.json
  tsconfig.json
```

### §II.2 Wrangler environments

```toml
# wrangler.toml

name = "auth-worker"
main = "src/index.ts"
compatibility_date = "2026-01-01"

[[kv_namespaces]]
binding = "AUTH_KV"
id = ""                # filled per environment below

[vars]
DEPLOYMENT = ""        # "skeptou" | "glossolalia"
COOKIE_DOMAIN = ""
BRAND_NAME = ""
BRAND_URL = ""
RESEND_FROM = ""

[env.skeptou]
name = "auth-skeptou"
[env.skeptou.vars]
DEPLOYMENT = "skeptou"
COOKIE_DOMAIN = ".skeptou.com"
BRAND_NAME = "Sképtou"
BRAND_URL = "https://skeptou.com"
RESEND_FROM = "noreply@skeptou.com"
[[env.skeptou.kv_namespaces]]
binding = "AUTH_KV"
id = "<skeptou-auth-kv-id>"

[env.glossolalia]
name = "auth-glossolalia"
[env.glossolalia.vars]
DEPLOYMENT = "glossolalia"
COOKIE_DOMAIN = ".glossolalia.dev"
BRAND_NAME = "Glossolalia"
BRAND_URL = "https://glossolalia.dev"
RESEND_FROM = "noreply@glossolalia.dev"
[[env.glossolalia.kv_namespaces]]
binding = "AUTH_KV"
id = "<glossolalia-auth-kv-id>"
```

Secrets (set per environment via `wrangler secret put`):

| Secret | Purpose |
|---|---|
| `HMAC_SECRET` | HMAC-SHA256 session signing key (32+ bytes, base64url) |
| `RESEND_API_KEY` | Resend API key |
| `ADMIN_SECRET` | Bearer token for `/admin/*` routes |

Secret rotation: generate new `HMAC_SECRET` → deploy → old sessions invalidate within one TTL cycle. No explicit revocation needed; sessions are stateless. Full rotation procedure in §XII.

### §II.3 Custom domain routing

```
auth.skeptou.com      → env.skeptou   Worker route
auth.glossolalia.dev  → env.glossolalia Worker route
```

All subdomains of each deployment's domain are expected to validate cookies against the corresponding `auth.*` Worker. Cookie `Domain` attribute is set to `.skeptou.com` or `.glossolalia.dev` respectively, so the cookie is visible across all subdomains within that domain.

---

## §III. Allowlist

Allowlist is stored in KV as individual entries. There is no self-signup; entries are added by the admin.

### §III.1 KV keys

```
allow:<email>   → JSON: { email, added_at, note?, active: true }
```

`email` is lowercased and trimmed on write. Lookup always lowercases the incoming address before checking.

### §III.2 Admin API (§VII.4–§VII.5)

Allowlist entries are managed via authenticated `PUT /admin/allowlist` and `DELETE /admin/allowlist/:email`. The admin bearer token (`ADMIN_SECRET`) is separate from any session cookie. The bootstrap script seeds the first entry (§XII).

### §III.3 Active flag

`active: false` soft-disables an entry without deletion. Login attempts against an inactive entry receive the same "check your email" response as an unrecognised address (no enumeration).

---

## §IV. Cryptographic Design

### §IV.1 HMAC session cookie

Cookie name: `__skeptou_session` (or `__glossolalia_session` per deployment — set via `DEPLOYMENT` var).

Cookie value format:
```
base64url(JSON payload) . base64url(HMAC-SHA256 signature)
```

Payload schema:
```typescript
interface SessionPayload {
  sub: string;          // email (lowercased)
  iat: number;          // issued-at (Unix seconds)
  exp: number;          // absolute expiry (Unix seconds; iat + 90 days)
  rol: string;          // "user" | "admin"
  jti: string;          // 16-byte random nonce (hex) — replay protection
}
```

Signing:
```typescript
// src/lib/hmac.ts
async function signPayload(payload: SessionPayload, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', base64urlDecode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const data = base64urlEncode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${base64urlEncode(sig)}`;
}

async function verifyPayload(token: string, secret: string): Promise<SessionPayload | null> {
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const key = await crypto.subtle.importKey(
    'raw', base64urlDecode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const valid = await crypto.subtle.verify(
    'HMAC', key, base64urlDecode(sig), new TextEncoder().encode(data)
  );
  if (!valid) return null;
  const payload: SessionPayload = JSON.parse(base64urlDecode(data));
  if (payload.exp < Math.floor(Date.now() / 1000)) return null; // expired
  return payload;
}
```

### §IV.2 Cookie attributes

```
Set-Cookie: __skeptou_session=<value>;
  Domain=.skeptou.com;
  Path=/;
  HttpOnly;
  Secure;
  SameSite=Lax;
  Max-Age=<sliding_ttl_seconds>
```

`Max-Age` is the sliding window (30 days = 2592000 seconds). `exp` inside the payload is the absolute cap (90 days from issuance). Cookie renewal (§IV.4) refreshes `Max-Age` but never extends `exp` beyond the original 90-day absolute cap.

### §IV.3 Magic link token

Token: `crypto.getRandomValues(new Uint8Array(32))` → hex string (64 chars).

Stored in KV:

```
magic:<hex-token>  →  JSON: { email, created_at, exp }
```

TTL: 10 minutes (KV `expirationTtl: 600`). Deleted on first use (one-time; subsequent use of the same token returns 401 expired).

Token is never logged in plaintext after generation. The KV key uses the full 64-char hex token; its length makes enumeration infeasible. HMAC of the token (not the token itself) is what appears in audit log entries.

### §IV.4 Sliding session renewal

On every authenticated request validated by `@skeptou/auth-client`, if the session has less than 15 days remaining in its sliding window (i.e., the cookie's `Max-Age` would expire in under 15 days), the sub-app must call `requireAuth()` with `{ refresh: true }` to trigger renewal. The sub-app Worker then calls back to `auth.<domain>/session` with the existing cookie to receive a refreshed `Set-Cookie` header.

Alternatively, sub-apps may call `auth.<domain>/session` proactively on page load (§VII.3) to handle renewal transparently. The auth Worker refreshes the cookie only if the remaining sliding window is under half the TTL (15 days).

Absolute cap: `exp` in the payload never changes. If `exp` has passed, the session is invalid regardless of `Max-Age`.

---

## §V. Session TTL Summary

| Parameter | Value |
|---|---|
| Magic link TTL | 10 minutes |
| Session sliding window | 30 days |
| Session absolute cap | 90 days from issuance |
| Sliding renewal trigger | < 15 days remaining on sliding window |
| Cookie `Max-Age` on renewal | Resets to 30 days (2592000 s) |

---

## §VI. KV Layout

All keys are scoped per KV namespace (each deployment has its own namespace).

```
── Allowlist ──────────────────────────────────────────────────────────
allow:<email>
  { email: string, added_at: string, note?: string, active: boolean }

── Magic tokens ───────────────────────────────────────────────────────
magic:<hex-token>
  { email: string, created_at: string, exp: number }
  expirationTtl: 600

── Session revocation (sparse; normally not needed) ───────────────────
revoke:<jti>
  { revoked_at: string, reason?: string }
  expirationTtl: 7776000   // 90 days (max absolute session lifetime)

── Rate limit buckets (per-email) ─────────────────────────────────────
rl:login:email:<email>
  { tokens: number, last_refill: number }
  expirationTtl: 3600

── Rate limit buckets (per-IP) ────────────────────────────────────────
rl:login:ip:<ip>
  { tokens: number, last_refill: number }
  expirationTtl: 3600

── Audit log ──────────────────────────────────────────────────────────
audit:<iso-date>:<ulid>
  AuditEntry (see §XI.1)
  expirationTtl: 7776000   // 90 days rolling retention; export to R2 for longer

── Admin nonce (replay protection for admin bearer) ───────────────────
admin:nonce:<nonce>
  { used_at: string }
  expirationTtl: 300
```

---

## §VII. API Endpoints

All endpoints live at `auth.<domain>/`. TLS enforced at Cloudflare edge.

### §VII.1 `POST /login`

**Purpose:** Accept an email, check allowlist, issue magic link.

**Request:**
```
Content-Type: application/json
Body: { "email": "cam@example.com" }
```

**Response (always 200 — no enumeration):**
```json
{ "ok": true }
```

Browser is redirected to or shown the "check your email" page regardless of whether the address is on the allowlist or not. This prevents allowlist enumeration.

**Internal flow:**
1. Validate request body: `email` is a string, syntactically valid, ≤ 254 chars.
2. Rate limit: check `rl:login:email:<email>` and `rl:login:ip:<cf-connecting-ip>`. Exceed → return `429` with `Retry-After` header.
3. Lowercase + trim email.
4. Look up `allow:<email>` in KV. If absent or `active: false`: write audit entry `LOGIN_ATTEMPT_BLOCKED`; return 200 (no-op — silent fail).
5. Generate 32-byte random token (hex).
6. Write `magic:<token>` to KV with `expirationTtl: 600`.
7. Call Resend to deliver magic link email (§IX).
8. Write audit entry `MAGIC_LINK_ISSUED`.
9. Return 200 `{ ok: true }`.

**Error codes:**
- `400` — malformed request body or invalid email format
- `429` — rate limit exceeded

### §VII.2 `GET /verify`

**Purpose:** Consume magic link token; issue session cookie.

**Request:**
```
GET /verify?token=<hex-token>&next=<encoded-url>
```

`next` is the URL the user originally intended to visit; used for post-auth redirect. Must be validated to be a relative path or same-origin URL (no open redirect).

**Response (success):**
```
302 → <next> or deployment's BRAND_URL
Set-Cookie: __<deployment>_session=<value>; ...
```

**Internal flow:**
1. Read `token` from query string. If absent → serve `verify-error.html`.
2. Look up `magic:<token>` in KV. If absent (expired or already used) → serve `verify-error.html` with "link expired" message.
3. Atomically delete `magic:<token>` (one-time use).
4. Look up `allow:<email>` again (allowlist entry may have been deactivated during the 10-minute window). If inactive → serve `verify-error.html` with "access revoked" message.
5. Build `SessionPayload`:
   - `sub` = email
   - `iat` = now
   - `exp` = now + 90 days (absolute cap)
   - `rol` = `"user"` (or `"admin"` if email matches `ADMIN_EMAIL` var; see §XII)
   - `jti` = 16-byte random hex
6. Sign payload → cookie value.
7. Set `Set-Cookie` with `Max-Age: 2592000` (30 days sliding).
8. Write audit entry `SESSION_ISSUED`.
9. Redirect to validated `next` or `BRAND_URL`.

**Error responses:** Always serve HTML error pages (not JSON) since this is a browser flow.

### §VII.3 `GET /session`

**Purpose:** Validate current session cookie; optionally renew sliding window.

**Request:**
```
GET /session
Cookie: __<deployment>_session=<value>
```

Sub-apps call this endpoint (via fetch with `credentials: 'include'`) to validate and optionally renew the session.

**Response (valid session):**
```json
{
  "ok": true,
  "sub": "cam@example.com",
  "rol": "user",
  "exp": 1785000000,
  "renewed": false
}
```

If renewal was triggered (sliding window < 15 days remaining):
```
Set-Cookie: __<deployment>_session=<new-value>; ...
{ "ok": true, "sub": "...", "renewed": true }
```

**Response (invalid/expired):**
```json
{ "ok": false, "reason": "expired" | "invalid" | "revoked" }
```

**Internal flow:**
1. Parse and verify HMAC cookie.
2. Check `revoke:<jti>` in KV (only if HMAC is valid — avoids KV call on forged tokens).
3. If valid: check renewal condition (sliding window < 50% = 15 days). If true, issue renewed cookie.
4. Return session info.

**CORS:** This endpoint returns permissive CORS headers for same-domain sub-apps only. The `Access-Control-Allow-Origin` response header reflects the `Origin` request header only if it matches the deployment's domain suffix (`.skeptou.com` or `.glossolalia.dev`). No wildcard.

### §VII.4 `POST /logout`

**Purpose:** Revoke session.

**Request:**
```
POST /logout
Cookie: __<deployment>_session=<value>
Content-Type: application/json  (or form-encoded)
Body: {}   (empty; CSRF token not required — SameSite=Lax covers cross-site POST)
```

**Response:**
```
302 → /   (or BRAND_URL)
Set-Cookie: __<deployment>_session=; Max-Age=0; ...  (cookie deletion)
```

**Internal flow:**
1. Parse cookie. If valid: write `revoke:<jti>` to KV with `expirationTtl: 7776000`.
2. Write audit entry `SESSION_REVOKED`.
3. Delete cookie (Max-Age=0).
4. Redirect to root.

Invalid or absent cookie is a no-op (still clears cookie and redirects; no error).

### §VII.5 `GET /admin/allowlist`

**Purpose:** List all allowlist entries.

**Auth:** `Authorization: Bearer <ADMIN_SECRET>` header required.

**Response:**
```json
{
  "entries": [
    { "email": "cam@example.com", "added_at": "2026-05-13T...", "active": true },
    ...
  ]
}
```

Entries are returned sorted by `added_at` ascending.

### §VII.6 `PUT /admin/allowlist`

**Purpose:** Add or update an allowlist entry.

**Auth:** `Authorization: Bearer <ADMIN_SECRET>`.

**Request:**
```json
{ "email": "someone@example.com", "note": "optional note", "active": true }
```

**Response:**
```json
{ "ok": true, "email": "someone@example.com", "action": "created" | "updated" }
```

**Validation:** Email must be syntactically valid. `active` defaults to `true` if absent.

### §VII.7 `DELETE /admin/allowlist/:email`

**Purpose:** Remove an allowlist entry.

**Auth:** `Authorization: Bearer <ADMIN_SECRET>`.

**Response (success):**
```json
{ "ok": true, "email": "someone@example.com" }
```

**Response (not found):**
```json
{ "ok": false, "reason": "not_found" }
```

Note: `DELETE` removes the KV entry; existing sessions for that email remain valid until they expire or are individually revoked. To immediately block access, set `active: false` via `PUT /admin/allowlist` — this is checked on every `/verify` call and on sub-app validation when using the KV-check path (see `@skeptou/auth-client` §VIII.2).

### §VII.8 `GET /admin/audit`

**Purpose:** Retrieve recent audit log entries.

**Auth:** `Authorization: Bearer <ADMIN_SECRET>`.

**Query params:**
- `limit` — max entries to return (default 100, max 500)
- `before` — ISO date string; return entries before this date
- `email` — filter by subject email

**Response:**
```json
{
  "entries": [ AuditEntry, ... ],
  "count": 47
}
```

---

## §VIII. `@skeptou/auth-client`

A small TypeScript package bundled into the monorepo at `packages/auth-client/`. Sub-apps (Quartz Workers, other Cloudflare Workers) import it to validate sessions locally without an external network call.

### §VIII.1 API

```typescript
// packages/auth-client/src/index.ts

export interface SessionInfo {
  sub: string;      // email
  rol: string;      // "user" | "admin"
  iat: number;
  exp: number;
  jti: string;
}

export interface AuthClientConfig {
  hmacSecret: string;          // same HMAC_SECRET as the auth Worker
  cookieName: string;          // "__skeptou_session" | "__glossolalia_session"
  authBaseUrl: string;         // "https://auth.skeptou.com"
  refreshThresholdDays?: number; // default 15
}

/**
 * Validate the session cookie from an incoming Request.
 * Pure HMAC validation — no network call.
 * Returns null if cookie is absent, invalid, or expired.
 */
export async function validateSession(
  request: Request,
  config: AuthClientConfig
): Promise<SessionInfo | null>

/**
 * validateSession + redirect to auth login if invalid.
 * Appends ?next=<current-url> to the auth login URL.
 * Optionally refreshes the sliding window if under threshold.
 */
export async function requireAuth(
  request: Request,
  config: AuthClientConfig,
  options?: { refresh?: boolean }
): Promise<{ session: SessionInfo; response?: Response }>
// throws AuthRedirectResponse if session is invalid (sub-app should return it)

export class AuthRedirectResponse extends Response {
  constructor(authBaseUrl: string, next: string);
}
```

### §VIII.2 Usage pattern in a sub-app Worker

```typescript
// Example: phronesis Worker entry
import { requireAuth, AuthRedirectResponse } from '@skeptou/auth-client';

const AUTH_CONFIG = {
  hmacSecret: env.HMAC_SECRET,
  cookieName: '__skeptou_session',
  authBaseUrl: 'https://auth.skeptou.com',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const { session, response } = await requireAuth(request, AUTH_CONFIG, { refresh: true });
      // session.sub, session.rol are available
      const res = await handleRequest(request, env, session);
      // If requireAuth issued a renewal, attach Set-Cookie header
      if (response) {
        const headers = new Headers(res.headers);
        headers.set('Set-Cookie', response.headers.get('Set-Cookie')!);
        return new Response(res.body, { ...res, headers });
      }
      return res;
    } catch (e) {
      if (e instanceof AuthRedirectResponse) return e;
      throw e;
    }
  }
};
```

### §VIII.3 Quartz integration

Quartz generates a static site; Cloudflare Pages serves it. A `_worker.js` (Cloudflare Pages Function) wraps all requests, calls `requireAuth`, and either proxies to the static asset or redirects to the auth Worker. The `_worker.js` is generated by the build pipeline; it imports `@skeptou/auth-client` at build time and embeds the HMAC_SECRET at deploy time via Cloudflare Pages environment variable.

```javascript
// _worker.js (generated; simplified)
import { requireAuth, AuthRedirectResponse } from '@skeptou/auth-client';

export default {
  async fetch(request, env, ctx) {
    try {
      await requireAuth(request, {
        hmacSecret: env.HMAC_SECRET,
        cookieName: '__skeptou_session',
        authBaseUrl: 'https://auth.skeptou.com',
      });
    } catch (e) {
      if (e instanceof AuthRedirectResponse) return e;
      throw e;
    }
    return env.ASSETS.fetch(request);
  }
};
```

Public paths (if any; default: none for private subdomains) can be exempted by checking `new URL(request.url).pathname` before calling `requireAuth`.

### §VIII.4 Secret sharing

The `HMAC_SECRET` must match between the auth Worker and every sub-app Worker that validates sessions locally. It is stored in Cloudflare Pages/Workers environment secrets per deployment and per consuming Worker. Key rotation requires updating the secret in every sub-app and the auth Worker simultaneously; deployment ordering is: auth Worker first (issues new sessions), then sub-apps (accept new sessions; old sessions expire within 30–90 days naturally).

---

## §IX. Branding and Email Templates

### §IX.1 Branding variables

Each deployment exposes these variables (set in wrangler.toml `[vars]`):

| Var | skeptou value | glossolalia value |
|---|---|---|
| `BRAND_NAME` | `Sképtou` | `Glossolalia` |
| `BRAND_URL` | `https://skeptou.com` | `https://glossolalia.dev` |
| `DEPLOYMENT` | `skeptou` | `glossolalia` |
| `RESEND_FROM` | `noreply@skeptou.com` | `noreply@glossolalia.dev` |
| `COOKIE_NAME` | `__skeptou_session` | `__glossolalia_session` |

HTML templates in `templates/` reference `{{BRAND_NAME}}`, `{{BRAND_URL}}` etc. via a lightweight template substitution function (no dependency; simple `string.replaceAll`).

### §IX.2 Aesthetic

Sképtou deployment uses the project aesthetic (§III of CLAUDE.md): Parchment background (`#fcf5e5`), Purple body text (`#301934`), Mauve accents (`#915f6d`), Cormorant font (Google Fonts; public-facing auth page). Magic link email also uses Parchment background for HTML email body (inline styles; `background-color: #fcf5e5`; no external fonts in email).

Glossolalia deployment uses its own brand colors/fonts per `glossolalia-brand.ts` (to be defined by Glossolalia spec; placeholder: clean white + system font).

### §IX.3 Magic link email (Resend)

```typescript
// src/lib/resend.ts
async function sendMagicLink(
  to: string,
  token: string,
  config: { brandName: string; brandUrl: string; authBaseUrl: string; resendFrom: string; resendApiKey: string },
  next?: string
): Promise<void> {
  const link = `${config.authBaseUrl}/verify?token=${token}${next ? `&next=${encodeURIComponent(next)}` : ''}`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: config.resendFrom,
      to,
      subject: `Sign in to ${config.brandName}`,
      html: magicLinkHtml(link, config.brandName, config.brandUrl),
      text: `Sign in to ${config.brandName}: ${link}\n\nThis link expires in 10 minutes and can only be used once.`,
    }),
  });
}
```

Email HTML is self-contained inline-styled; no external CSS. Structure: header (brand name), body (one sentence + big CTA button), footer (expiry notice + "if you didn't request this, ignore this email").

---

## §X. Rate Limiting

Token-bucket algorithm; KV-backed. Two independent buckets per login attempt: per-email and per-IP.

### §X.1 Parameters

| Bucket | Capacity | Refill rate | Cost per attempt |
|---|---|---|---|
| Per-email | 5 tokens | 1 token / 10 min | 1 |
| Per-IP | 20 tokens | 1 token / 1 min | 1 |

These defaults are conservative for the expected usage pattern (single user per allowlist entry, low login frequency). If Glossolalia deployment serves a larger allowlist, override via `RATE_LIMIT_EMAIL_CAPACITY`, `RATE_LIMIT_IP_CAPACITY` env vars.

### §X.2 Implementation

```typescript
// src/lib/ratelimit.ts
interface Bucket { tokens: number; last_refill: number; }

async function consume(
  kv: KVNamespace,
  key: string,
  capacity: number,
  refillRate: number,   // tokens per second
  cost: number
): Promise<{ allowed: boolean; retryAfter?: number }> {
  const raw = await kv.get(key, 'json') as Bucket | null;
  const now = Math.floor(Date.now() / 1000);
  let { tokens, last_refill } = raw ?? { tokens: capacity, last_refill: now };
  const elapsed = now - last_refill;
  tokens = Math.min(capacity, tokens + elapsed * refillRate);
  if (tokens < cost) {
    const retryAfter = Math.ceil((cost - tokens) / refillRate);
    return { allowed: false, retryAfter };
  }
  tokens -= cost;
  await kv.put(key, JSON.stringify({ tokens, last_refill: now }), { expirationTtl: 3600 });
  return { allowed: true };
}
```

### §X.3 Response on limit exceeded

```
HTTP 429 Too Many Requests
Retry-After: <seconds>
Content-Type: application/json

{ "error": "rate_limit_exceeded", "retry_after": 120 }
```

The login page shows a user-facing "Too many attempts. Try again in 2 minutes." message when it receives a 429 from the API.

---

## §XI. Logging and Audit

### §XI.1 AuditEntry schema

```typescript
interface AuditEntry {
  id: string;           // ULID
  ts: string;           // ISO 8601
  event: AuditEvent;
  sub?: string;         // email (redacted as sha256 prefix if PII-minimised mode; default: plaintext)
  ip?: string;          // CF-Connecting-IP (v4 only; v6 truncated to /48)
  ua?: string;          // User-Agent truncated to 200 chars
  deployment: string;   // "skeptou" | "glossolalia"
  meta?: Record<string, unknown>; // event-specific extras
}

type AuditEvent =
  | 'LOGIN_ATTEMPT_BLOCKED'    // address not on allowlist
  | 'MAGIC_LINK_ISSUED'        // allowlist hit; link sent
  | 'MAGIC_LINK_VERIFIED'      // token consumed; session issued
  | 'MAGIC_LINK_EXPIRED'       // /verify called with absent/expired token
  | 'SESSION_ISSUED'           // new session cookie set
  | 'SESSION_RENEWED'          // sliding window refresh
  | 'SESSION_REVOKED'          // logout
  | 'SESSION_EXPIRED'          // validateSession found exp < now
  | 'ADMIN_ALLOWLIST_CREATED'
  | 'ADMIN_ALLOWLIST_UPDATED'
  | 'ADMIN_ALLOWLIST_DELETED'
  | 'RATE_LIMIT_HIT';
```

### §XI.2 KV storage and retention

Each entry is written as `audit:<iso-date>:<ulid>` with `expirationTtl: 7776000` (90 days). This gives a rolling 90-day window queryable via prefix scan. The `/admin/audit` endpoint scans the `audit:` prefix and filters by date/email client-side after fetch (KV prefix scan returns keys; entries are fetched by key).

### §XI.3 R2 export (optional)

A scheduled Worker (cron: `0 0 * * *`) scans entries from the previous day and appends them as NDJSON to R2 object `audit/<deployment>/<YYYY>/<MM>/<DD>.ndjson`. This is opt-in and not required for Phase 1. Enabling it requires an R2 bucket binding in wrangler.toml.

---

## §XII. Bootstrap Procedure

Run once per deployment, before the Worker is publicly reachable.

```bash
# 1. Create KV namespace for each deployment
wrangler kv:namespace create "AUTH_KV" --env skeptou
wrangler kv:namespace create "AUTH_KV" --env glossolalia
# → Copy IDs into wrangler.toml

# 2. Generate HMAC_SECRET (32 bytes → base64url)
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='

# 3. Set secrets per deployment
wrangler secret put HMAC_SECRET --env skeptou
wrangler secret put RESEND_API_KEY --env skeptou
wrangler secret put ADMIN_SECRET --env skeptou
# (repeat for glossolalia)

# 4. Deploy Workers
wrangler deploy --env skeptou
wrangler deploy --env glossolalia

# 5. Seed first allowlist entry (admin email)
curl -X PUT https://auth.skeptou.com/admin/allowlist \
  -H "Authorization: Bearer <ADMIN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"email":"cam@skeptou.com","note":"primary admin","active":true}'

# 6. Smoke test: POST /login with seeded email; click link in inbox; verify cookie issued
```

### §XII.1 Admin email and role

One email address is designated admin via the `ADMIN_EMAIL` env var (set in wrangler.toml or via `wrangler secret put`). When this email completes a magic-link flow, the issued session has `rol: "admin"`, granting access to `/admin/*` endpoints via cookie (in addition to the bearer-token path). This allows a browser-based admin workflow without managing a separate token.

### §XII.2 HMAC secret rotation

```bash
# 1. Generate new secret
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='

# 2. Update auth Worker first
wrangler secret put HMAC_SECRET --env skeptou   # enter new value

# 3. Re-deploy auth Worker
wrangler deploy --env skeptou

# 4. Update HMAC_SECRET in every sub-app Worker that calls validateSession locally
#    (phronesis, energeia, etc.) — update env secret + re-deploy each

# Effect: sessions issued before rotation are invalid immediately (new secret).
# All active users will be redirected to login on next request.
# There is no graceful transition period. Schedule rotation during a low-use window.
```

---

## §XIII. Glossolalia Migration Path

Glossolalia currently uses an existing auth mechanism (specifics to be confirmed in Glossolalia spec). Migration to `auth-core` v1:

1. Deploy `auth.glossolalia.dev` with Glossolalia KV namespace, brand vars, and Resend sender address.
2. Seed Glossolalia allowlist with all current authorized users' emails.
3. Deploy `@skeptou/auth-client` integration to all Glossolalia Workers/Pages Functions.
4. Set `HMAC_SECRET` consistently across Glossolalia Workers.
5. Cut DNS: `auth.glossolalia.dev` → `auth-glossolalia` Worker.
6. Disable old auth mechanism.
7. Notify users: next login will require magic link. Existing sessions (old mechanism) are invalid after cutover.

Pre-migration checklist:
- [ ] Glossolalia allowlist compiled and verified
- [ ] `auth.glossolalia.dev` smoke-tested in staging
- [ ] All Glossolalia Workers updated to use `@skeptou/auth-client`
- [ ] HMAC_SECRET confirmed consistent across all Glossolalia Workers
- [ ] Resend sender domain `glossolalia.dev` verified in Resend dashboard
- [ ] Resend SPF/DKIM records added to `glossolalia.dev` DNS

---

## §XIV. Threat Model

| Threat | Mitigation |
|---|---|
| Cookie forgery | HMAC-SHA256 signature; 256-bit secret; SubtleCrypto constant-time verify |
| Cookie theft (XSS) | HttpOnly attribute; no JavaScript access |
| Cookie theft (MITM) | Secure attribute; HSTS enforced at Cloudflare edge |
| CSRF | SameSite=Lax; logout POST requires same-site context; GET endpoints are idempotent |
| Magic link interception | 10-minute TTL; one-time use; HTTPS delivery only |
| Allowlist enumeration | Login always returns 200 regardless of allowlist hit/miss |
| Token brute-force | 256-bit random space (2^256); KV TTL eliminates stale tokens |
| Session fixation | New `jti` generated on every session issuance |
| Replay after logout | `revoke:<jti>` KV entry; checked on `/session` validation |
| Admin credential leak | Admin bearer token separate from session; rotatable independently |
| Rate abuse | Token-bucket rate limiter per email + per IP |
| KV timing oracle | KV reads are performed only after HMAC signature verification passes; forged tokens get no KV call |
| Resend abuse | Rate limiting prevents mass magic-link issuance per email and per IP |

---

## §XV. Open Questions

| # | Question | Blocks |
|---|---|---|
| 1 | Resend domain verification for `skeptou.com` and `glossolalia.dev` — which DNS records needed, who owns those domains? | Bootstrap |
| 2 | `ADMIN_EMAIL` value for each deployment | Bootstrap |
| 3 | Glossolalia current auth mechanism — what exactly is being replaced? | §XIII migration plan |
| 4 | PII minimisation preference: store email plaintext in audit log, or store SHA-256 prefix? | Audit log design |
| 5 | R2 long-retention export — enable at Phase 1 or defer? | §XI.3 |
| 6 | `/login` page UX — redirect user to the page they originally wanted after magic-link verify, or always land on BRAND_URL? | `next` param handling in login page template |
| 7 | Glossolalia allowlist size — how many users? (Affects KV scan perf + whether pagination is needed on `/admin/allowlist`) | Phase complexity |
| 8 | Absolute session cap of 90 days acceptable, or longer? (Affects absolute-inactivity UX — rare but someone who doesn't visit for 90+ days will need to re-auth) | Session design |
