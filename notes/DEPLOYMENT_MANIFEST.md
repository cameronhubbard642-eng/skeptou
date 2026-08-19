# DEPLOYMENT_MANIFEST — Sképtou

**Purpose:** the reconnection map for the v1 rebuild. Every deployed Cloudflare
resource, binding, route, and secret **name** that the v0 implementation used.
The v0 application code was removed from trunk in the qualified-blank-slate reset;
**all of the infrastructure below survives that reset and is still live.** Rebuilt
modules must reconnect to these exact names/IDs rather than creating new resources.

**Generated:** 2026-08-18
**Derived from:** `modules/*/wrangler.toml`, `.github/workflows/*.yml`, module source,
`notes/CUTOVER_SEQUENCE.md`. Pre-reset snapshot of all code is tag **`v0-archive`**.

> **NO SECRET VALUES APPEAR IN THIS FILE.** Only secret *names* and where they live.

---

## §0. Account

| Field | Value |
|---|---|
| Cloudflare account ID | `0eac870edbebb135e71b572f0bb8e83b` |
| Account name | `8rnbx9v7g6@privaterelay.appleid.com's Account` |
| GitHub repo | `cameronhubbard642-eng/skeptou` (private) |
| Zone | `skeptou.com` |

Source: `modules/phronesis/.wrangler/cache/wrangler-account.json` (untracked local cache, preserved).

---

## §I. ⚠️ HARD SAFETY BOUNDARY — Glossolalia

A **separate** D1 database, `database_id 2c8387bb-9ce3-46a6-9f06-c1d8ec5b5537`,
backs Cam's **live** Taller de Traducción and Übersetzungswerkstatt language apps.

- **It is NOT a Sképtou resource. Never target it. Never clear it. Never migrate it.**
- Verified 2026-08-18: that UUID appears **nowhere** in this repository. No Sképtou
  wrangler config, workflow, or source file references it. There is no path by which a
  Sképtou `wrangler` command reaches it.
- The **only** D1 UUID present anywhere in this repo is `6321abe6-…` (`skeptou-op`, phronesis).
- `modules/auth-core/wrangler.toml` contains an `[env.glossolalia]` **auth-worker**
  deployment target (`auth.glossolalia.dev`, KV id unfilled, Phase 4, never deployed).
  That is the auth worker only — unrelated to, and holding no binding to, the
  Glossolalia D1 above. Leave it as-is.

Any destructive D1 operation must name the database **explicitly by name** (`skeptou-op`)
and be preceded by a `wrangler d1 info` check that the returned `uuid` is `6321abe6-…`.

---

## §II. D1 databases

| Module | Binding | Database name | database_id | Status |
|---|---|---|---|---|
| **phronesis** | `OP_DB` | `skeptou-op` | `6321abe6-ed91-4577-8d82-c9dbf688795c` | **Live.** Created region WNAM 2026-05-16. 5 migrations applied. |
| strategia | `STRATEGIA_DB` | `skeptou-strategia` | *(resolved at CI deploy)* | Created/patched by `deploy-strategia.yml` via CF API at deploy time; `FILL_AFTER_CREATE` in committed toml by design. |
| strategia | `OP_DB` | `skeptou-op` | `6321abe6-ed91-4577-8d82-c9dbf688795c` | **Shared read** of phronesis D1 for the `service_tokens` table (S-4 default, `specs/strategia.md` §X.3). |
| aristeia | `ARISTEIA_DB` | `skeptou-aristeia` | *(resolved at CI deploy)* | Created idempotently by `deploy-aristeia.yml` (`wrangler d1 info` → `d1 create`). |
| phero | `PHERO_DB` | `skeptou-phero` | *(resolved at CI deploy)* | Created idempotently by `deploy-phero.yml` via CF API, then `sed`-patched into toml. |
| auth-core | `AUTH_DB` | *(referenced in source; no toml binding)* | — | Spec-level only; auth-core ships on KV, not D1. Confirm before rebuild. |
| energeia | — | — | — | No D1. State lives in the agora repo + KV. |
| apex | — | — | — | Static only. |

**phronesis migrations** (`modules/phronesis/migrations/`, preserved on trunk):
`0001_initial_schema.sql`, `0002_indexes.sql`, `0003_triggers.sql`,
`0004_rev3_schema.sql`, `0005_nesting.sql`.
Note: D1 wraps each migration in an implicit transaction — migration files must **not**
contain raw `BEGIN`/`COMMIT` (see commit `a5084d1`).

---

## §III. R2 buckets

| Module | Binding | Bucket name | Provisioned by |
|---|---|---|---|
| strategia | `STRATEGIA_R2` | `skeptou-strategia` | `deploy-strategia.yml` (CF API, idempotent create) |
| aristeia | `ARISTEIA_R2` | `skeptou-aristeia` | `deploy-aristeia.yml` (`wrangler r2 bucket create`, idempotent) |
| energeia | `ENERGEIA_R2` | *(referenced in source; no toml binding)* | Not provisioned in CI. Confirm existence before rebuild. |

---

## §IV. KV namespaces

| Module | Binding | Namespace ID | Notes |
|---|---|---|---|
| auth-core (`env.skeptou`) | `AUTH_KV` | `f43938aca3b6436d96f33d1377db2974` | **Live.** Sessions, allowlist, rate-limit counters, audit log. |
| auth-core (`env.glossolalia`) | `AUTH_KV` | *unfilled* (`<glossolalia-auth-kv-id>`) | Phase 4, deferred, never deployed. |
| energeia | `ENERGEIA_ACTIONS` | *not in repo* — held only as a Pages binding + in the daemon's `CF_KV_NAMESPACE_ID` env | Daemon action queue. `daemon/energeia-daemon.py` polls it every 5s via the CF REST API. **Retrieve the ID from the CF dashboard before rebuilding energeia.** |

---

## §V. Workers, Pages projects, and custom domains

| Resource | Kind | Project / Worker name | Custom domain | Deploy path |
|---|---|---|---|---|
| apex | Pages | `skeptou` | `skeptou.com` | `deploy-apex.yml` → `cloudflare/pages-action@v1`, Direct Upload |
| phronesis | Pages | `phronesis` | `phronesis.skeptou.com` | `deploy-phronesis.yml` → `wrangler pages deploy .` from `dist/` |
| energeia | Pages | `energeia` | `energeia.skeptou.com` | `deploy-energeia.yml` → `wrangler pages deploy .` from `dist/` |
| aristeia | Pages | `aristeia` | `aristeia.skeptou.com` | `deploy-aristeia.yml` → `wrangler pages deploy .` from `dist/` (deploys **twice**: bindings only take effect on the second deploy) |
| strategia | Pages | `strategia` | `strategia.skeptou.com` | `deploy-strategia.yml` → `wrangler pages deploy .` from `dist/` |
| phero | **Worker** + Assets | `phero-worker` | `phero.skeptou.com/*` (`custom_domain = true`) | `deploy-phero.yml` → `wrangler deploy` |
| auth-core | **Worker** | `auth-skeptou` | `auth.skeptou.com` (`custom_domain = true`) | `deploy-auth-core.yml` → `npm run deploy:skeptou` |
| auth-core (glossolalia) | Worker | `auth-glossolalia` | `auth.glossolalia.dev` | Manual dispatch only; Phase 4, **never deployed** |

**Pages Functions caveat (load-bearing, rediscovered the hard way in v0):**
`cloudflare/pages-action@v1` is deliberately *not* used for the Functions-bearing
projects. It hard-codes `wrangler pages publish`, which does not bundle a `functions/`
directory inside the upload dir — handlers land as static assets and `POST /api/*`
returns 405. The workflows instead `cd` into `dist/` and run `wrangler pages deploy .`
so wrangler's CWD contains `./functions/`. **Preserve this in the rebuild.**

**Pages bindings are configured in the Cloudflare dashboard**, not from the committed
`wrangler.toml`, for phronesis and aristeia (dashboard → project → Settings → Functions).
strategia and aristeia additionally patch bindings via the CF API at deploy time.
The committed `wrangler.toml` files exist for `d1 migrations apply` and `pages dev` only.

---

## §VI. Cloudflare Access

| Item | Value |
|---|---|
| Coverage | Every private subdomain. Apex `skeptou.com` is the only public surface. |
| phronesis policy | `phronesis.skeptou.com/*` — the whole origin, `/api/*` included |
| Login branding | Applied via `apply-cf-access-branding.yml` (manual dispatch). PATCHes `/accounts/{id}/access/organizations` `login_design`: bg `#fcf5e5`, text `#301934`, logo = raw GitHub URL of `assets/branding/cf-access-login/logo.svg`, footer "Authorized access only." |
| Required token perm | `Access: Edit` (account-level) on `CLOUDFLARE_API_TOKEN` |

**AUD tags:** no Access AUD value is stored in this repo. `CF_ACCESS_AUD` was a
**Cloudflare Pages secret** (phronesis + energeia), read by the Workers for
`CF-Access-Jwt-Assertion` validation.

**Status per `notes/CUTOVER_SEQUENCE.md`:** v0 migrated off Access-JWT validation onto
auth-core HMAC, and step 4 of that cutover **deletes** the `CF_ACCESS_AUD` Pages secrets:
```
wrangler pages secret delete CF_ACCESS_AUD --project-name phronesis
wrangler pages secret delete CF_ACCESS_AUD --project-name energeia
```
Whether that step actually ran is **not verifiable from the repo** — confirm in the
dashboard before the rebuild depends on either mechanism.

---

## §VII. Service tokens (Worker-to-Worker)

Long-lived machine credentials; never in committed code. Established pairs:

| Consumer | Target | Wrangler secret name | GitHub secret name |
|---|---|---|---|
| phero | energeia | `ENERGEIA_SERVICE_TOKEN` | `PHERO_ENERGEIA_SERVICE_TOKEN` |
| phero | aristeia | `ARISTEIA_SERVICE_TOKEN` | `PHERO_ARISTEIA_SERVICE_TOKEN` |
| aristeia | energeia | `ENERGEIA_SERVICE_TOKEN` | *(pull model, `specs/aristeia.md`)* |
| scholia *(spec'd, unbuilt)* | phero | `PHERO_SERVICE_TOKEN` | — |

Token validation reads the shared `service_tokens` table in **phronesis's `skeptou-op` D1**
(S-4 decision — strategia binds `OP_DB` for exactly this). TTL 90 days (resolved 2026-05-14).
Planned-but-unbuilt pairs are catalogued in `ARCHITECTURE.md` §III (graphe consumers, graphe sync).

---

## §VIII. Secret NAMES (values never recorded here)

### GitHub Actions repo secrets — Settings → Secrets and variables → Actions

| Name | Used by | Purpose |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | every deploy workflow | Pages/Workers deploy, D1+R2 API, zone edit (phero routes), Access edit (branding) |
| `CLOUDFLARE_ACCOUNT_ID` | every deploy workflow | account id |
| `GITHUB_TOKEN` | apex | auto-provided by Actions |
| `VAULT_GITHUB_PAT` | phronesis | O&P vault PAT, `contents:read` |
| `VAULT_REPO` | phronesis | `owner/repo` of the O&P vault |
| `VAULT_SUBTREE` | phronesis | path prefix, e.g. `Organization & Planning` |
| `AGORA_DISPATCH_PAT` | energeia | classic PAT, `repo` scope on the agora repo |
| `AGORA_REPO` | energeia | `owner/repo` for agora |
| `HMAC_SECRET` | aristeia | pushed to Pages secrets at deploy |
| `PHERO_AUTH_HMAC_SECRET` | phero | = auth-core `HMAC_SECRET` |
| `PHERO_ENERGEIA_SERVICE_TOKEN` | phero | → wrangler secret `ENERGEIA_SERVICE_TOKEN` |
| `PHERO_ARISTEIA_SERVICE_TOKEN` | phero | → wrangler secret `ARISTEIA_SERVICE_TOKEN` |
| `PHERO_COOKIE_SIGNING_KEY` | phero | → wrangler secret `COOKIE_SIGNING_KEY` |

### Cloudflare Pages secrets — dashboard → project → Settings → Variables

| Project | Secret names |
|---|---|
| phronesis | `VAULT_GITHUB_PAT` (`contents:write` here), `VAULT_REPO`, `VAULT_SUBTREE`, `HMAC_SECRET`, `AUTH_DOMAIN`, `CF_ACCESS_AUD` *(see §VI — may be deleted)* |
| energeia | `AGORA_DISPATCH_PAT`, `AGORA_REPO`, `HMAC_SECRET`, `AUTH_DOMAIN`, `CF_ACCESS_AUD` *(see §VI)* |
| aristeia | `HMAC_SECRET` |
| strategia | `HMAC_SECRET` |

### Worker secrets — `wrangler secret put`

| Worker | Secret names |
|---|---|
| `auth-skeptou` | `HMAC_SECRET` (32-byte base64url), `RESEND_API_KEY`, `ADMIN_SECRET` |
| `phero-worker` | `AUTH_HMAC_SECRET`, `ENERGEIA_SERVICE_TOKEN`, `ARISTEIA_SERVICE_TOKEN`, `COOKIE_SIGNING_KEY` |

### Local daemon env — `daemon/energeia-daemon.py`

`CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_KV_NAMESPACE_ID` (the `ENERGEIA_ACTIONS` namespace).

---

## §IX. Plaintext vars (non-secret, in committed config)

**auth-core `[env.skeptou.vars]`:** `DEPLOYMENT=skeptou`, `COOKIE_DOMAIN=.skeptou.com`,
`BRAND_NAME=Sképtou`, `BRAND_URL=https://skeptou.com`,
`RESEND_FROM=noreply@auth-mail.skeptou.com`, `ADMIN_EMAIL=camh502@alumni.stanford.edu`,
`PII_MINIMIZE=true`.

**phero `[vars]`:** `ENERGEIA_BASE_URL=https://energeia.skeptou.com`,
`ARISTEIA_BASE_URL=https://aristeia.skeptou.com`, `SHARE_COOKIE_TTL_DAYS=7`,
`ADMIN_EMAIL=camh502@alumni.stanford.edu`.

**Full binding-name surface used by v0 code** (rebuild targets):
`OP_DB`, `PHERO_DB`, `ARISTEIA_DB`, `STRATEGIA_DB`, `AUTH_DB`, `AUTH_KV`,
`ENERGEIA_ACTIONS`, `STRATEGIA_R2`, `ARISTEIA_R2`, `ENERGEIA_R2`,
`HMAC_SECRET`, `AUTH_HMAC_SECRET`, `COOKIE_SIGNING_KEY`, `SERVICE_TOKEN`,
`ENERGEIA_SERVICE_TOKEN`, `ARISTEIA_SERVICE_TOKEN`, `AGORA_DISPATCH_PAT`, `AGORA_REPO`,
`AUTH_DOMAIN`, `COOKIE_NAME`, `COOKIE_DOMAIN`, `BRAND_NAME`, `BRAND_URL`, `DEPLOYMENT`,
`ADMIN_EMAIL`, `ADMIN_SECRET`, `RESEND_FROM`, `RESEND_API_KEY`, `PII_MINIMIZE`,
`RATE_LIMIT_IP_CAPACITY`, `RATE_LIMIT_EMAIL_CAPACITY`, `SHARE_COOKIE_TTL_DAYS`,
`ENERGEIA_BASE_URL`, `ARISTEIA_BASE_URL`.

---

## §X. DNS — preserve unconditionally

iCloud custom-domain email on `skeptou.com` must not break:

- MX: `mx01.mail.icloud.com`, `mx02.mail.icloud.com`
- SPF: `v=spf1 include:icloud.com ~all`
- DKIM + DMARC as configured

---

## §XI. Not verified against the live account

`wrangler` OAuth expired **2026-07-17** and its refresh token is rejected; `wrangler login`
needs an interactive browser. This manifest is therefore reconstructed **from repository
configuration**, not read back from Cloudflare.

*(The phronesis D1 reset was completed 2026-08-18 via the Cloudflare D1 MCP — see
`archive/README.md`. That path reached D1 only; it did not reconcile the rest of this
manifest, so everything below still needs verifying.)*

Before the rebuild, re-authenticate and reconcile:

```bash
wrangler login                       # or export CLOUDFLARE_API_TOKEN=…
wrangler d1 list
wrangler r2 bucket list
wrangler kv namespace list           # captures the ENERGEIA_ACTIONS id
wrangler pages project list
wrangler pages secret list --project-name phronesis   # …and energeia/aristeia/strategia
```

Specifically unresolved: the `ENERGEIA_ACTIONS` KV id; the deploy-time `database_id`s for
`skeptou-strategia`, `skeptou-aristeia`, `skeptou-phero`; whether `skeptou-auth` D1 and
`ENERGEIA_R2` were ever created; the Access AUD tags; and whether the `CF_ACCESS_AUD`
deletion in `notes/CUTOVER_SEQUENCE.md` step 4 ran.

---

## §XII. ⚠️ CI HAZARD — read before pushing the reset commit

The reset commit touches **every** `modules/<name>/**` path. All seven deploy
workflows trigger on `push: branches:[main]` filtered by exactly those paths, so
**pushing the reset commit to `main` fires all of them at once**, against live
infrastructure, with no application source left to build.

Likely per-workflow outcome:

| Workflow | On the reset commit |
|---|---|
| `deploy-apex.yml` | `cp modules/apex/index.html …` fails → job errors, **no deploy**. Public apex should survive — but this is the public surface, so do not test the theory. |
| `deploy-phronesis.yml` / `deploy-energeia.yml` | build steps fail on missing sources → job errors before `pages deploy`. |
| `deploy-aristeia.yml` / `deploy-strategia.yml` | the **idempotent D1/R2 create + `d1 migrations apply` steps run first and will succeed**, then the build fails. Non-destructive, but it does touch live D1. |
| `deploy-phero.yml` | D1 create + **`wrangler secret put` for four secrets** runs before build. If the GH secrets are still populated this is a harmless re-push; if any is empty the workflow emits a warning and leaves that secret unset. |
| `deploy-auth-core.yml` | `npm ci` fails on the deleted lockfile → job errors, **live `auth-skeptou` Worker untouched**. |

The dangerous case is any workflow reaching `wrangler pages deploy` with an empty or
partial `dist/` — that would publish an empty site over a live one. The build steps
should fail first in every case, but **this is inference from reading the workflows,
not something that was executed or verified.**

**Recommended before pushing** (Cam's call — the reset session did not modify CI,
per the instruction to preserve `.github/`):

1. Disable the workflows for the duration of the rebuild —
   `gh workflow disable deploy-apex.yml` (and each of the others); re-enable per module
   as its v1 implementation lands. This is the cheapest, most reversible option.
2. Or push the reset commit on a branch and merge via PR with Actions disabled.
3. Do **not** push anything apex-affecting without explicit Cam approval
   (Sképtou PR-for-public rule, `notes/STATE_OF_PLAY.md`).

**The reset commit was deliberately left unpushed for this reason.**

## §XIII. Stray file flagged, not changed

Root `_headers` sets a CSP whose `connect-src` allows `api.openai.com`,
`api.anthropic.com`, `generativelanguage.googleapis.com`, `api.elevenlabs.io`, and
`api.glossolalia.dev`. No Sképtou deploy reads it — every Pages deploy uploads from
`modules/<name>/dist/`, and the per-module `_headers` files lived under
`modules/*/static/` and `modules/phero/public/`. It looks like a stray copied from a
Glossolalia project. Left in place (deleting it was outside the reset's scope); worth
a decision during the architecture redo.
