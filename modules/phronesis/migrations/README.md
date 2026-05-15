# skeptou-op — D1 setup runbook (DevOps)

D1 database backing the O&P data API. See `specs/op-d1-migration.md` rev 2.

## One-time database creation

```bash
cd modules/phronesis
npx wrangler@3 d1 create skeptou-op
```

Copy the printed `database_id` into `wrangler.toml` → `[[d1_databases]]` →
`database_id` (replacing `REPLACE_AFTER_wrangler_d1_create`).

## Apply migrations

Migrations in `migrations/` are applied in filename order.

```bash
# Local dev DB (for `wrangler pages dev`)
npx wrangler@3 d1 migrations apply skeptou-op --local

# Remote (production)
npx wrangler@3 d1 migrations apply skeptou-op --remote
```

Or via the package scripts: `npm run d1:migrate:local` / `npm run d1:migrate`.

Verify:

```bash
npx wrangler@3 d1 info skeptou-op
# Expect 7 tables: projects, opportunities, commitments, tasks,
#                   inventory, audit_log, service_tokens
# plus 2 views:    active_opportunities, declined_opportunities
```

## Bind to the deployed Pages project

The CI deploy does not read `wrangler.toml`. Add the binding in the
Cloudflare dashboard:

> phronesis → Settings → Functions → D1 database bindings
> Variable name: `OP_DB`   Database: `skeptou-op`

Until this binding exists, the `/api/*` D1 endpoints return `503`
(`DB_UNAVAILABLE`) — auth still works, no crash.

## Service token provisioning (Phase 3)

```bash
TOKEN=$(openssl rand -hex 32)
HASH=$(echo -n "$TOKEN" | sha256sum | awk '{print $1}')

npx wrangler@3 d1 execute skeptou-op --remote --command \
  "INSERT INTO service_tokens (token_hash, role_slug, scopes, expires_at) VALUES (
    '${HASH}',
    'pm-specialist',
    '[\"/api/projects\",\"/api/opportunities\",\"/api/tasks\",\"/api/audit\"]',
    datetime('now', '+90 days')
  );"

echo "Deliver this token to the specialist role-brief: $TOKEN"
```

Only the SHA-256 hash is stored. Revoke a token with
`UPDATE service_tokens SET active = 0 WHERE token_hash = '...'`.

## Backup / restore

- **Time Travel** (30-day point-in-time restore, no config):
  `npx wrangler@3 d1 time-travel restore skeptou-op --timestamp="..."`
- Nightly D1→JSON export to agora is added in Phase 5.
