# specs/runtime-fetch-cache.md — Runtime Fetch + Cache Layer

> **⚠ SUPERSEDED — 2026-05-14**  
> This spec is superseded by `specs/op-d1-migration.md`. Cam pivoted structured O&P data to Cloudflare D1; the fetch + cache approach described here is no longer the target architecture for phronesis. The agora-git-backed pattern (§III–§VII) remains in force for `energeia` documents, papers, and PDFs, and the webhook + CF Cache machinery described here may be re-scoped to energeia-only in a future energeia spec revision. Do not implement this spec as written.

**Version:** rev 1  
**Status:** superseded — see `specs/op-d1-migration.md`  
**Author:** Lead Dev / Architect — Sképtou  
**Date:** 2026-05-14  
**Superseded:** 2026-05-14  
**Consumers:** (archived — do not consume)  
**Depends on:** `specs/auth-core.md`, `ARCHITECTURE.md`

---

## §I — Problem

Current data pipeline: agora repo → sync scripts (`sync-vault.js`, `sync-agora.js`) run at build time → `dist/data/*.json` baked into CF Pages deploy → sub-app HTML loads that JSON on page init.

Consequence: content edits in agora do not surface in any sub-app UI until a new CF Pages deploy is triggered. For `phronesis`, project state and planning data can be stale for hours. For `energeia`, a paper status change requires a manual redeploy. The lag scales directly with commit frequency — on an active writing day, the dashboard reflects yesterday's state for most of the day.

This spec defines a runtime fetch + cache layer that eliminates build-cycle lag while staying within CF free-tier limits and maintaining offline / degraded-network resilience through a baked fallback.

---

## §II — Architecture overview

```
agora repo push
      │
      ▼
GitHub webhook ──► POST skeptou.com/api/webhook/agora-push  (Worker Route, public)
                         │  validates HMAC-SHA256 signature
                         │  maps changed paths → affected cache URLs
                         ▼
                  Cloudflare Zone Cache Purge API
                         │  purges affected URLs across all edge nodes in zone
                         ▼
                  [CF Cache entries for affected endpoints invalidated]


Browser requests phronesis dashboard
      │
      ▼
phronesis Worker: GET /api/data/projects
      │
      ├─► CF Cache HIT? ──yes──► return cached JSON (cache_hit: true)
      │
      └─► CF Cache MISS ──► fetch GitHub Contents API
                                │  decode + parse via lib/sync-vault.ts
                                │  PUT response into CF Cache (TTL: 300s)
                                └─► return fresh JSON (cache_hit: false)


Sub-app JS hydration sequence:
  1. Render immediately from window.__INITIAL_DATA__ (baked at deploy, zero network wait)
  2. fetch('/api/data/projects') — network-first via Service Worker
  3. Success: replace rendered data with live data; show data timestamp
  4. Failure: retain __INITIAL_DATA__, show staleness indicator
```

End-to-end latency after agora push:
- With webhook (Phase 3): cache purged within ~5s; next request fetches fresh data → ~10–15s total
- Without webhook (Phase 1–2): stale data for up to TTL (300s max), then auto-refresh on next cache miss

---

## §III — Worker endpoints

### §III.1 — Phronesis endpoints

Mounted on `phronesis.skeptou.com` Worker under `/api/data/*`.  
All endpoints require a valid session cookie (auth-gated via `@skeptou/auth-client` `requireAuth()` — see §IX.1).

| Endpoint | agora source path | TTL | Parse fn | Dir mode |
|---|---|---|---|---|
| `GET /api/data/projects` | `O&P/projects/` | 300s | `parseProjFiles()` | yes |
| `GET /api/data/opportunities` | `O&P/opportunities/` | 300s | `parseOppFiles()` | yes |
| `GET /api/data/tasks` | `O&P/tasks/` | 300s | `parseTaskFiles()` | yes |
| `GET /api/data/inventory` | `O&P/inventory.md` | 300s | `parseInventory()` | no |
| `GET /api/data/busy-scores` | `O&P/scores/` | 300s | `parseBusyScores()` | yes |

"Dir mode yes" means the GitHub Contents API is called once for the directory listing, then individual files are fetched in parallel. "Dir mode no" means a single file fetch.

### §III.2 — Energeia endpoints

Mounted on `energeia.skeptou.com` Worker under `/api/data/*`.  
Auth-gated identically to phronesis.

| Endpoint | agora source path | TTL | Parse fn | Dir mode |
|---|---|---|---|---|
| `GET /api/data/papers` | `agora/energeia/slugs.yaml` | 300s | `parseSlugsMeta()` | no |
| `GET /api/data/slugs` | `agora/energeia/slugs.yaml` | 300s | `parseSlugsRaw()` | no |
| `GET /api/data/versions/:slug` | `agora/papers/:slug/versions/` | 300s | `parseVersionLog()` | yes |

`/api/data/versions/:slug` uses the `:slug` path param to construct the agora directory path dynamically. Cache key includes the slug: `https://energeia.skeptou.com/api/data/versions/{slug}`.

### §III.3 — Response envelope

All endpoints return a uniform envelope:

```typescript
interface DataResponse<T> {
  data: T;
  cached_at: number;    // Unix ms timestamp of the last GitHub fetch
  cache_hit: boolean;   // true if served from CF Cache without a GitHub call
  ttl: number;          // seconds; the configured TTL for this endpoint
}
```

HTTP status codes:
- `200` — success (cache hit or fresh fetch)
- `401` — no valid session (auth failure; redirect to auth)
- `502` — GitHub API error (see §X.1 for fallback behaviour)
- `404` — agora path not found

### §III.4 — Extension pattern for future modules

Adding a new module's data endpoint:
1. Add route handler in `modules/<name>/src/handlers/data.ts` following the pattern in §IV.2
2. Add `EndpointConfig` entry (§IV.4) with the agora path + parse function
3. Add a row in `modules/webhook/src/path-map.ts` mapping agora file paths → this endpoint's URL (§V.3)
4. No shared Worker changes required

---

## §IV — CF Cache API layer

### §IV.1 — Cache store

Use `caches.default` — Cloudflare's shared CDN cache, accessible from Workers. Responses stored via `caches.default.put()` are served at the Cloudflare edge nearest to the requester; they are purgeable via the Zone Cache Purge API (§V.4).

Cache keys are full URLs including scheme and host: `https://phronesis.skeptou.com/api/data/projects`. The cache key is the incoming request URL; no additional key construction is required for single-user deployments.

> **Multi-user note (Glossolalia future):** If different users should see different data, the cache key must incorporate a user identifier. Out of scope for Sképtou v1 (single user); document as open question §XII.1.

### §IV.2 — Request handler pattern

```typescript
// modules/shared/lib/cache-handler.ts

export async function handleDataRequest<T>(
  request: Request,
  env: Env,
  endpoint: EndpointConfig<T>,
): Promise<Response> {
  // Auth gate — always first
  const { session } = await requireAuth(request, env.AUTH_CONFIG);

  const cacheKey = request.url;
  const cache = caches.default;

  // 1. Check CF Cache
  const cached = await cache.match(new Request(cacheKey));
  if (cached) {
    const body = await cached.json() as DataResponse<T>;
    return Response.json({ ...body, cache_hit: true });
  }

  // 2. Fetch from GitHub
  let raw: string | Map<string, string>;
  try {
    raw = endpoint.dirMode
      ? await fetchDirectory(env.GITHUB_PAT, env.GH_OWNER, env.GH_REPO, endpoint.ghPath)
      : await fetchFile(env.GITHUB_PAT, env.GH_OWNER, env.GH_REPO, endpoint.ghPath);
  } catch (err) {
    console.error(`GH_FETCH_ERROR path=${endpoint.ghPath}`, err);
    return new Response('Bad Gateway', { status: 502 });
  }

  // 3. Parse
  const data = endpoint.parse(raw as any);
  const ttl = endpoint.ttl ?? 300;

  // 4. Build payload
  const payload: DataResponse<T> = {
    data,
    cached_at: Date.now(),
    cache_hit: false,
    ttl,
  };

  // 5. Store in CF Cache
  const cacheResponse = new Response(JSON.stringify(payload), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${ttl}`,
    },
  });
  await cache.put(new Request(cacheKey), cacheResponse);

  return Response.json(payload);
}
```

### §IV.3 — GitHub Contents API fetch

```typescript
// modules/shared/lib/gh-fetch.ts

const GH_API = 'https://api.github.com';

function ghHeaders(pat: string): HeadersInit {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'skeptou-worker/1.0',
  };
}

export async function fetchFile(
  pat: string,
  owner: string,
  repo: string,
  path: string,
): Promise<string> {
  const url = `${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const res = await fetch(url, { headers: ghHeaders(pat) });

  if (res.status === 404) throw new GHNotFoundError(path);
  if (!res.ok) throw new GHFetchError(`GitHub ${res.status} for ${path}`);

  const json = await res.json() as { content: string; encoding: string };
  if (json.encoding !== 'base64') throw new GHFetchError(`Unexpected encoding: ${json.encoding}`);

  return atob(json.content.replace(/\n/g, ''));
}

export async function fetchDirectory(
  pat: string,
  owner: string,
  repo: string,
  dirPath: string,
): Promise<Map<string, string>> {
  const url = `${GH_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(dirPath)}`;
  const res = await fetch(url, { headers: ghHeaders(pat) });

  if (res.status === 404) throw new GHNotFoundError(dirPath);
  if (!res.ok) throw new GHFetchError(`GitHub ${res.status} for ${dirPath}`);

  const entries = await res.json() as Array<{
    name: string;
    download_url: string;
    type: string;
  }>;

  const files = entries.filter(e => e.type === 'file');

  const results = await Promise.all(
    files.map(async f => {
      const content = await fetch(f.download_url, {
        headers: { 'User-Agent': 'skeptou-worker/1.0' },
      }).then(r => r.text());
      return [f.name, content] as [string, string];
    }),
  );

  return new Map(results);
}
```

`download_url` is used for individual files (avoids base64 decoding; returns raw file content directly). This costs 1 extra request per file vs. the Contents API per-file endpoint, but eliminates base64 handling for large markdown files.

### §IV.4 — Endpoint configuration type

```typescript
// modules/shared/lib/endpoint-config.ts

export interface EndpointConfig<T = unknown> {
  route: string;                                           // e.g. '/api/data/projects'
  ghPath: string;                                          // agora path (file or dir)
  parse: (raw: string | Map<string, string>) => T;
  ttl?: number;                                            // seconds; default 300
  dirMode?: boolean;                                       // true = fetchDirectory
}
```

Parse functions (`parseProjFiles`, `parseOppFiles`, etc.) are extracted from the existing `sync-vault.js` / `sync-agora.js` build scripts and re-exported as TypeScript from `modules/shared/lib/parsers/`. They operate on the same raw string content — no changes to parse logic required.

### §IV.5 — TTL rationale

300s default is chosen because:
- With webhook active (Phase 3): TTL is irrelevant; cache is purged on every agora push, so stale data is bounded by push→purge latency (~5–15s), not TTL
- Without webhook (Phase 1–2): 5 min is short enough to feel responsive on an active writing day (data is at most 5 min old) while keeping GitHub API usage trivial (see §XI)
- TTL is not runtime-configurable; change requires a code deploy (acceptable — this is personal infrastructure)

---

## §V — Webhook + cache invalidation

### §V.1 — Endpoint

```
POST https://skeptou.com/api/webhook/agora-push
```

This is a **Worker Route** on the `skeptou.com` zone — a Cloudflare Worker intercepts this path before CF Pages handles the rest of the apex domain. The endpoint is publicly accessible (no CF Access policy on this path). Authentication is via GitHub HMAC-SHA256 signature (§V.2).

The Webhook Worker lives in `modules/webhook/` — a standalone Worker, not a subdomain. It has no subdomain slot in the module roster; it is infra-level.

`wrangler.toml` for the webhook Worker:

```toml
name = "skeptou-webhook"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[routes]]
pattern = "skeptou.com/api/webhook/*"
zone_name = "skeptou.com"

[vars]
ENVIRONMENT = "production"
```

Secrets to set: `GH_WEBHOOK_SECRET`, `CF_ZONE_ID`, `CF_API_TOKEN` (see §IX.4).

### §V.2 — GitHub signature verification

GitHub signs the raw request body with `HMAC-SHA256(GH_WEBHOOK_SECRET, body)` and places the result in the `X-Hub-Signature-256: sha256=<hex>` header. Use SubtleCrypto for constant-time verification:

```typescript
async function verifyGHSignature(
  secret: string,
  rawBody: string,
  sigHeader: string | null,
): Promise<boolean> {
  if (!sigHeader?.startsWith('sha256=')) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const expected = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(rawBody),
  );

  const expectedHex = 'sha256=' + Array.from(new Uint8Array(expected))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison — prevents timing oracle
  if (expectedHex.length !== sigHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedHex.length; i++) {
    diff |= expectedHex.charCodeAt(i) ^ sigHeader.charCodeAt(i);
  }
  return diff === 0;
}
```

Reject with `401` on invalid signature; accept silently any event type other than `push` (return `200` with empty body — GitHub retries on non-2xx).

### §V.3 — Path → cache URL mapping

On each `push` event, collect all modified paths from `commits[].added + commits[].modified + commits[].removed`. For each path, test against `PATH_MAP` to determine which cache URLs to purge.

```typescript
// modules/webhook/src/path-map.ts

type UrlResolver = string[] | ((match: RegExpMatchArray) => string[]);

interface PathMapping {
  pattern: RegExp;
  purgeUrls: UrlResolver;
}

export const PATH_MAP: PathMapping[] = [
  {
    pattern: /^O&P\/projects\//,
    purgeUrls: ['https://phronesis.skeptou.com/api/data/projects'],
  },
  {
    pattern: /^O&P\/opportunities\/opp-/,
    purgeUrls: ['https://phronesis.skeptou.com/api/data/opportunities'],
  },
  {
    pattern: /^O&P\/tasks\//,
    purgeUrls: ['https://phronesis.skeptou.com/api/data/tasks'],
  },
  {
    pattern: /^O&P\/inventory\.md$/,
    purgeUrls: ['https://phronesis.skeptou.com/api/data/inventory'],
  },
  {
    pattern: /^O&P\/scores\//,
    purgeUrls: ['https://phronesis.skeptou.com/api/data/busy-scores'],
  },
  {
    pattern: /^agora\/energeia\/slugs\.yaml$/,
    purgeUrls: [
      'https://energeia.skeptou.com/api/data/papers',
      'https://energeia.skeptou.com/api/data/slugs',
    ],
  },
  {
    pattern: /^agora\/papers\/([^/]+)\/versions\//,
    purgeUrls: (match) => [
      `https://energeia.skeptou.com/api/data/versions/${match[1]}`,
    ],
  },
];

export function resolvePurgeUrls(changedPaths: string[]): string[] {
  const urls = new Set<string>();
  for (const path of changedPaths) {
    for (const { pattern, purgeUrls } of PATH_MAP) {
      const match = path.match(pattern);
      if (match) {
        const resolved = typeof purgeUrls === 'function' ? purgeUrls(match) : purgeUrls;
        resolved.forEach(u => urls.add(u));
      }
    }
  }
  return [...urls];
}
```

When a new module is added, its path mappings are added to `PATH_MAP` only. No other webhook code changes.

### §V.4 — Cloudflare Zone Cache Purge API

The webhook Worker purges cache entries by calling the CF Admin API — this reaches all edge nodes in the zone, not just the current edge node (which is what `caches.default.delete()` within a Worker would only affect):

```typescript
async function purgeZoneUrls(urls: string[], env: Env): Promise<void> {
  if (urls.length === 0) return;

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/purge_cache`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files: urls }),
    },
  );

  if (!res.ok) {
    // Non-fatal: cache expires at TTL; log and continue
    const err = await res.text();
    console.error(`PURGE_FAIL status=${res.status} body=${err} urls=${JSON.stringify(urls)}`);
  } else {
    console.log(`PURGE_OK count=${urls.length} urls=${JSON.stringify(urls)}`);
  }
}
```

See §IX.4 for required API token scope.

### §V.5 — Full webhook handler

```typescript
// modules/webhook/src/index.ts

interface GHCommit {
  added: string[];
  modified: string[];
  removed: string[];
}
interface GHPushPayload {
  commits: GHCommit[];
  ref: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const rawBody = await request.text();
    const sig = request.headers.get('X-Hub-Signature-256');

    if (!(await verifyGHSignature(env.GH_WEBHOOK_SECRET, rawBody, sig))) {
      console.warn('WEBHOOK_AUTH_FAIL sig=' + sig?.slice(0, 16));
      return new Response('Unauthorized', { status: 401 });
    }

    const event = request.headers.get('X-GitHub-Event');
    if (event !== 'push') {
      return new Response('OK', { status: 200 });
    }

    const payload = JSON.parse(rawBody) as GHPushPayload;

    // Only process pushes to main branch
    if (payload.ref !== 'refs/heads/main') {
      return new Response('OK', { status: 200 });
    }

    const changedPaths: string[] = [];
    for (const commit of payload.commits) {
      changedPaths.push(...commit.added, ...commit.modified, ...commit.removed);
    }

    const urlsToPurge = resolvePurgeUrls(changedPaths);
    await purgeZoneUrls(urlsToPurge, env);

    return new Response(
      JSON.stringify({ purged: urlsToPurge, paths_checked: changedPaths.length }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  },
};
```

### §V.6 — GitHub webhook configuration

In agora repo settings → Webhooks → Add webhook:

| Field | Value |
|---|---|
| Payload URL | `https://skeptou.com/api/webhook/agora-push` |
| Content type | `application/json` |
| Secret | value of `GH_WEBHOOK_SECRET` Worker secret |
| Events | `push` only |
| Branch filter | `main` (optional — code handles it; belt-and-suspenders to filter here too) |
| Active | yes |

---

## §VI — UI hydration pattern

### §VI.1 — Build-time embedded fallback

`sync-vault.js` / `sync-agora.js` continue to run at build time, generating `dist/data/*.json`. The build script additionally injects this data as `window.__INITIAL_DATA__` in the HTML output before CF Pages deploy:

```javascript
// modules/phronesis/build.js (excerpt — runs after sync scripts)

const ENDPOINTS = ['projects', 'opportunities', 'tasks', 'inventory', 'busy-scores'];

const initialData = Object.fromEntries(
  ENDPOINTS.map(name => [
    name,
    JSON.parse(fs.readFileSync(`dist/data/${name}.json`, 'utf8')),
  ]),
);
initialData._build_ts = Date.now();   // used by staleness indicator

const scriptTag = `<script>window.__INITIAL_DATA__ = ${JSON.stringify(initialData)};</script>`;
html = html.replace('</head>', `${scriptTag}\n</head>`);
```

The `_build_ts` field enables the UI to display "Data as of {date}" accurately even in degraded mode.

### §VI.2 — Client hydration sequence

```javascript
// modules/phronesis/src/app.js

async function hydrate() {
  // Step 1: Render immediately from embedded data — zero network wait
  renderDashboard(window.__INITIAL_DATA__);

  // Step 2: Fetch live data from each Worker endpoint
  const endpoints = ['projects', 'opportunities', 'tasks', 'inventory', 'busy-scores'];

  const results = await Promise.allSettled(
    endpoints.map(name =>
      fetch(`/api/data/${name}`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
        .then(({ data, cached_at }) => ({ name, data, cached_at }))
    ),
  );

  const liveData = { ...window.__INITIAL_DATA__ };
  let allFailed = true;
  let latestCachedAt = 0;

  for (const result of results) {
    if (result.status === 'fulfilled') {
      liveData[result.value.name] = result.value.data;
      latestCachedAt = Math.max(latestCachedAt, result.value.cached_at);
      allFailed = false;
    }
  }

  // Step 3: Replace with live data
  renderDashboard(liveData);

  if (allFailed) {
    // Step 4: All fetches failed — show staleness indicator
    showStalenessIndicator(window.__INITIAL_DATA__._build_ts);
  } else {
    setDataTimestamp(latestCachedAt);
    clearStalenessIndicator();
  }
}

document.addEventListener('DOMContentLoaded', hydrate);
```

Partial failure (some endpoints succeed, others fail) is handled: succeeded endpoints show live data, failed endpoints show build-time data. No all-or-nothing behaviour.

### §VI.3 — Staleness indicator

When live fetch fails, show a non-intrusive notice. Style uses project palette: `var(--color-quartz)` text, small font, fixed bottom-right, does not disrupt layout:

```css
.data-freshness {
  position: fixed;
  bottom: 1rem;
  right: 1rem;
  font-size: 0.75rem;
  color: var(--color-quartz);
  font-family: var(--font-body);
  opacity: 0.7;
  pointer-events: none;
  z-index: 10;
}
```

Text when stale: "Data as of {formattedDate} — offline". Text when live: "Updated {formattedDate}" (auto-hides after 3s).

---

## §VII — Service Worker strategy

### §VII.1 — Scope

The SW intercepts `/api/data/*` requests only. Static assets are served by CF Pages CDN and do not need SW caching for normal operation. App-shell offline support (full offline mode) is out of scope for this spec.

### §VII.2 — Cache strategy: NetworkFirst

```javascript
// modules/phronesis/public/sw.js

const API_CACHE = 'api-cache-v1';

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith('/api/data/')) return;

  event.respondWith(networkFirst(event.request));
});

async function networkFirst(request) {
  const cache = await caches.open(API_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ error: 'offline', data: null, cache_hit: false }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
```

### §VII.3 — Cache versioning and cleanup

```javascript
const CURRENT_CACHES = new Set(['api-cache-v1']);

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => !CURRENT_CACHES.has(k))
          .map(k => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});
```

Bump `API_CACHE` name on breaking API response shape changes.

### §VII.4 — SW registration

```javascript
// In main HTML or app.js
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' });
}
```

---

## §VIII — Migration plan

Each phase is independently deployable and non-breaking. A later phase can be deferred without breaking an earlier phase.

### Phase 1 — Worker endpoints + CF caching (no UI change)

**Scope:** Backend only. Existing UI continues loading `dist/data/*.json` from Pages. New `/api/data/*` routes are available but not yet called by the UI.

**Deliverables:**
- `modules/shared/lib/gh-fetch.ts` — `fetchFile`, `fetchDirectory`
- `modules/shared/lib/cache-handler.ts` — `handleDataRequest`
- `modules/shared/lib/parsers/` — parse functions extracted from `sync-vault.js` / `sync-agora.js`
- `modules/phronesis/src/handlers/data.ts` — endpoint registration for all 5 phronesis routes
- `modules/energeia/src/handlers/data.ts` — endpoint registration for all 3 energeia routes
- Unit tests for `gh-fetch.ts` (mock fetch); integration test stubs (mock GitHub API responses)
- Wrangler routes for `/api/data/*` added to phronesis + energeia `wrangler.toml`

**Verification:**
- Authenticated: `curl -H "Cookie: <valid-session>" https://phronesis.skeptou.com/api/data/projects` → `200 { data: [...], cache_hit: false }` on first call
- Second call within TTL → `cache_hit: true`
- Unauthenticated: `curl https://phronesis.skeptou.com/api/data/projects` → `401`

**Pre-conditions:** Phase 1 of main project plan complete (Cloudflare account setup, phronesis subdomain deployed). GitHub PAT for agora repo created and set as Worker secret `GITHUB_PAT`. `GH_OWNER` and `GH_REPO` Worker vars confirmed (see §XII.5).

### Phase 2 — UI hydration swap

**Scope:** Frontend. Sub-apps switch from loading `dist/data/*.json` directly to the new `/api/data/*` Worker endpoints. Embedded fallback (`window.__INITIAL_DATA__`) added to builds. Service Worker registered.

**Deliverables:**
- `modules/phronesis/build.js` — `window.__INITIAL_DATA__` injection (§VI.1)
- `modules/phronesis/src/app.js` — hydration sequence (§VI.2)
- `modules/phronesis/src/components/DataFreshness.js` — staleness indicator (§VI.3)
- `modules/phronesis/public/sw.js` — Service Worker (§VII)
- Same three deliverables for `modules/energeia/`

**Verification:**
- Dashboard loads with build-time data on initial render (visible before network response)
- Live data replaces build-time data within <2s on normal connection
- Kill Worker (simulate error): staleness indicator appears, build-time data remains visible, no crash

### Phase 3 — GitHub webhook + cache invalidation

**Scope:** Infra. Webhook Worker deployed; GitHub webhook configured on agora repo; cache purges fire on push.

**Deliverables:**
- `modules/webhook/` — new Worker (§V.1)
- `modules/webhook/src/path-map.ts` — initial PATH_MAP (§V.3)
- `modules/webhook/src/index.ts` — handler (§V.5)
- Secrets deployed: `GH_WEBHOOK_SECRET`, `CF_ZONE_ID`, `CF_API_TOKEN`
- GitHub webhook configured in agora repo settings (§V.6)

**Verification:**
- Push a single commit to agora changing one `O&P/projects/*.md` file
- Within 15 seconds: `curl https://phronesis.skeptou.com/api/data/projects` → response reflects the change; `cache_hit: false` on first post-purge request
- Invalid signature POST to webhook endpoint → `401`
- Non-push event POST → `200` with no purge side effects

### Phase 4 — Retire build-time sync (optional, deferred)

**Preconditions:** Phases 1–3 stable for ≥2 weeks with no regressions.

**Scope:** Remove `sync-vault.js` and `sync-agora.js` from CI/build pipeline. `window.__INITIAL_DATA__` either (a) populated via a deploy-time warm-up fetch against the Worker API, or (b) left as empty `{}` with the sub-app rendering a loading skeleton until the Phase 2 hydration fetch completes.

**Recommended posture:** Demote sync scripts to manual-only bootstrap rather than fully retiring. They cost nothing at rest and provide a fallback seeding mechanism if the Worker is unreachable during deploy. See §XII.4.

---

## §IX — Security

### §IX.1 — Auth on data endpoints

All `/api/data/*` endpoints on gated subdomains call `requireAuth(request, env.AUTH_CONFIG)` from `@skeptou/auth-client` before any cache read or GitHub fetch. If the session cookie is absent or invalid, the Worker returns `401` (or `AuthRedirectResponse` to the auth subdomain — per `specs/auth-core.md` §VI).

This means cached responses are never returned to unauthenticated requests — the auth check runs before the CF Cache lookup in §IV.2.

**Cache key and multi-user:** Cache key is the plain request URL (no user identifier). Acceptable for Sképtou v1 (Cam is the sole user; all requests see the same agora data). If a second user is ever added, the cache key must incorporate a user or tenant identifier to prevent data leakage between accounts. Flag this before adding any user to the phronesis/energeia allowlist.

### §IX.2 — Webhook endpoint security

The webhook endpoint is public (no CF Access). It is protected by:
1. **HMAC-SHA256 signature** (§V.2) — constant-time comparison, not susceptible to timing oracle
2. **Event type filter** — only `push` events trigger any action; all others return `200` silently
3. **Branch filter** — only `refs/heads/main` triggers purges
4. **Minimal permissions** — webhook Worker has no KV bindings and no write access to any data store; it only calls the CF Zone Cache Purge API

No Content-Security-Policy or rate-limiting beyond CF's default WAF is required for this endpoint — the HMAC check is the sole auth mechanism and is sufficient.

### §IX.3 — GitHub PAT scope

`GITHUB_PAT` (Worker secret, set per-module) requires:
- `contents: read` on the agora repo only
- No other permissions

Use a fine-grained PAT scoped to the single repo, not a classic PAT. Classic PATs with `repo` scope grant unnecessary write access.

### §IX.4 — CF API token scope

`CF_API_TOKEN` (webhook Worker secret) requires:
- Zone → Cache Purge → Edit on `skeptou.com` zone only
- No other permissions (not the Global API key)

Create a scoped API token in Cloudflare dashboard → My Profile → API Tokens → Create Token → Cache Purge template, restricted to `skeptou.com` zone.

---

## §X — Error handling + observability

### §X.1 — GitHub API error → stale fallback

| Condition | Worker response | Cache behaviour |
|---|---|---|
| GitHub 401 (PAT invalid/expired) | `502` | Serve CF Cache if present; else `502` |
| GitHub 403 (rate limit or scope) | `502` | Serve CF Cache if present; else `502` |
| GitHub 404 (path not found) | `404` | No cache write |
| GitHub 5xx | `502` | Serve CF Cache if present; else `502` |
| Network timeout (>10s) | `504` | Serve CF Cache if present; else `504` |

"Serve CF Cache if present" means: on GitHub error in the fetch path, before returning an error response, attempt `caches.default.match(cacheKey)` — if a stale entry exists, return it with an added `X-Served-From: stale-on-error` header. The UI treats any `2xx` response as usable data regardless of freshness.

```typescript
// In handleDataRequest — after GitHub fetch throws
const stale = await caches.default.match(new Request(cacheKey));
if (stale) {
  const body = await stale.json() as DataResponse<T>;
  return Response.json(
    { ...body, cache_hit: true, stale_on_error: true },
    { headers: { 'X-Served-From': 'stale-on-error' } },
  );
}
return new Response('Bad Gateway', { status: 502 });
```

### §X.2 — Webhook delivery failures

GitHub retries failed webhook deliveries 3× with exponential backoff (~5s, 30s, 60s). A transient Worker error self-heals on retry. If all 3 retries fail, cache expires at TTL (≤300s) and the next user request fetches fresh data automatically. No manual intervention required.

### §X.3 — CF Zone Cache Purge API failures

Non-fatal. Log the error (`PURGE_FAIL`); return `200` from the webhook endpoint (prevents GitHub from retrying, since the problem is on the purge side, not the signature/parse side). Cache expires at TTL. Document: a failed purge means stale data for up to 300s, not indefinitely.

### §X.4 — Structured log events

Each Worker emits structured console logs (visible in CF Workers Logs dashboard):

```
INFO  CACHE_HIT   endpoint=/api/data/projects
INFO  CACHE_MISS  endpoint=/api/data/projects  gh_fetch_ms=320
INFO  PURGE_OK    count=2  urls=["https://phronesis.skeptou.com/api/data/projects","..."]
ERROR GH_FETCH_ERROR  status=403  path=O&P/projects/
ERROR PURGE_FAIL  status=400  body={"errors":[...]}
WARN  WEBHOOK_AUTH_FAIL  sig=sha256=abc123...
```

No external log sink required for personal-use volume. CF dashboard is sufficient.

---

## §XI — Cost + scale analysis

### §XI.1 — GitHub Contents API

Authenticated fine-grained PAT: 5000 requests/hr.

| Module | Endpoints | Avg files/dir | Requests per cache miss |
|---|---|---|---|
| Phronesis | 5 | ~15 avg | 5 × (1 dir + 15 files) = 80 |
| Energeia | 3 | 1 file (slugs.yaml) + ~5 versions | ~10 |
| Total | — | — | ~90 per full cold-start |

With 5-min TTL and one user: worst case is 12 full cold-starts/hr = 12 × 90 = 1080 requests/hr. Expected actual (staggered misses, warm cache): <300 requests/hr.

With webhook active (Phase 3): cache miss rate drops to near zero between pushes. Expected: <50 GitHub API requests/hr.

Verdict: no token rotation, no conditional-request optimization (ETags) required at this scale.

### §XI.2 — CF Workers compute (free tier)

Free tier: 100,000 requests/day.

Estimates:
- 100 dashboard page loads/day × 8 Worker invocations each = 800
- 20 agora pushes/day × 1 webhook invocation = 20
- Total: ~820 invocations/day = <1% of free tier

Verdict: no cost concern. No paid Workers plan required.

### §XI.3 — CF Cache API storage

`caches.default` usage is included in the Workers free tier. No separate cache storage billing.

### §XI.4 — CF Zone Cache Purge API

Free, unlimited calls. No rate-limit concern at personal-use volume.

---

## §XII — Open questions for Cam

| # | Question | Default if no answer | Blocks |
|---|---|---|---|
| 1 | **Global cache key vs. per-user?** Currently scoped globally (single user). Acceptable for Sképtou v1? If a second user is ever added (even to the allowlist), this must be revisited before that addition. | Global — acceptable for now | Phase 1 design |
| 2 | **Webhook auth method?** Recommendation: GitHub HMAC-SHA256 (`GH_WEBHOOK_SECRET`) per §V.2. Alternative: shared token in query param (`?token=...`) — simpler to set up, slightly weaker. HMAC is standard. | HMAC-SHA256 | Phase 3 pre-condition |
| 3 | **Cache TTL — 5 min, or adjust per endpoint?** 300s applies uniformly. Could differentiate: longer TTL for papers/slugs (change rarely), shorter for tasks (change frequently). No strong reason to deviate without webhook; with webhook active, TTL is a fallback only. | 300s uniform | Phase 1 config |
| 4 | **Retire sync scripts or keep as bootstrap?** Recommendation: demote to manual-only (not CI-triggered); keep for deploy-time seeding of `window.__INITIAL_DATA__`. Full retirement means loading skeleton visible on first render until hydration fetch completes. | Keep as manual bootstrap | Phase 4 decision |
| 5 | **GitHub account + repo name for agora?** `GH_OWNER` and `GH_REPO` Worker vars must be set before Phase 1 Code task fires. These depend on Phase 1 blocking decisions (monorepo approval + GitHub account). | — (blocks Phase 1) | Phase 1 pre-condition |

---

## §XIII — Out of scope

- GraphQL / batched queries — REST per-endpoint is sufficient; all collections fit in a single response
- Pagination — collections are small (<50 projects, <20 papers); no pagination needed
- Real-time / WebSocket / SSE updates — polling via tab-focus re-fetch is sufficient
- Multi-user cache key segmentation — Glossolalia-specific; deferred
- Write-through cache — endpoints are read-only; vault writes go through agora repo directly
- R2 for binary PDF caching — deferred to the energeia PDF pipeline spec
- Conditional GitHub requests (ETags / `If-None-Match`) — premature optimisation at this scale; revisit only if approaching rate limits

---

## §XIV — Definition of done

- [ ] All phronesis `/api/data/*` endpoints return correct data on first authenticated request (cache miss)
- [ ] Second request within TTL returns `cache_hit: true` with no GitHub API call observed in CF logs
- [ ] Unauthenticated request to any `/api/data/*` endpoint returns `401` (no data leakage)
- [ ] Webhook endpoint rejects invalid signatures with `401`; valid push triggers correct cache purges
- [ ] Push to agora changing a project file → phronesis dashboard reflects change within 15s (Phase 3)
- [ ] `window.__INITIAL_DATA__` present in phronesis + energeia HTML output at deploy
- [ ] Live data replaces build-time data on hydration (happy path, normal connection)
- [ ] Staleness indicator displays correctly when Worker is unreachable
- [ ] SW registers and caches last-good API responses for offline reads
- [ ] GitHub PAT is fine-grained, `contents: read` on agora repo only (no write scope)
- [ ] CF API token is scoped to Cache Purge on `skeptou.com` zone only
- [ ] All Worker secret names documented in `notes/SECRETS.md` (names only, not values)
- [ ] PATH_MAP entries verified against actual agora directory structure before Phase 3 Code task fires
- [ ] Open questions §XII.1–5 resolved or explicitly deferred before Phase 1 Code task fires
