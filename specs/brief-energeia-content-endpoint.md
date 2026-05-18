# specs/brief-energeia-content-endpoint.md — Energeia Content Endpoint Brief

**Version:** rev 1
**Status:** ready for implementation
**Author:** Lead Dev / Architect — Sképtou
**Date:** 2026-05-17
**Spec:** `specs/energeia.md` rev 4 (addendum — endpoint not yet in spec)
**Tier:** Sonnet

---

## Mission

Add `GET /api/papers/:slug/content` to the energeia Worker. This is a small, focused change — one new read handler, authenticated by service token. It is a hard pre-condition for aristeia Phase 2 import.

**Do not gate this on aristeia Phase 1.** Implement and ship independently so aristeia Phase 2 is not blocked.

---

## Deliverables

1. `GET /api/papers/:slug/content` handler in `modules/energeia/src/`
2. Accept `ARISTEIA_SERVICE_TOKEN` (Bearer) — read-only scope; no Cam session required
3. Accept optional `?version=<tag>` query param to retrieve a specific compiled version

---

## Handler spec

**Route:** `GET /api/papers/:slug/content`

**Auth:** Bearer service token (scope: `aristeia` or `internal-read`). Cam session also accepted. Unauthenticated → `401`.

**Query params:**
- `version` (optional): a version tag string (e.g. `v1.3`). If omitted, returns the latest compiled canonical PDF.

**Logic:**

```typescript
// 1. Authenticate
const ctx = await authenticateRequest(request, env);
if (!ctx) return new Response(null, { status: 401 });

// 2. Validate scope — service token must have 'aristeia' or 'internal-read' scope
//    Cam session always passes
if (ctx.mode === 'service_token' && !['aristeia','internal-read'].includes(ctx.scope ?? '')) {
  return new Response(null, { status: 403 });
}

// 3. Look up paper
const slug = params.slug;
const version = url.searchParams.get('version');

// If version specified, look up that compiled output in R2
// R2 key pattern (follow existing energeia convention): papers/<slug>/<version>/main.pdf
// If no version, use latest canonical: papers/<slug>/canonical.pdf (or equivalent)
// Adjust to match energeia's actual R2 key schema

const r2Key = version
  ? `papers/${slug}/${version}/main.pdf`
  : `papers/${slug}/canonical.pdf`;

const object = await env.ENERGEIA_R2.get(r2Key);
if (!object) return new Response(null, { status: 404 });

// 4. Return version metadata in response headers
return new Response(object.body, {
  headers: {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="${slug}.pdf"`,
    'Cache-Control': 'private, no-store',
    'X-Energeia-Version': version ?? 'canonical',
    'X-Energeia-Slug': slug,
  }
});
```

**Note:** Check the actual R2 key schema in the existing energeia Worker code before implementing. The `canonical.pdf` key name and version-tagged path above are the spec recommendation — match whatever energeia already uses if it differs.

---

## Service token provisioning

A new service token with scope `aristeia` must be created in the phronesis `service_tokens` D1 table (per `specs/auth-core.md` service token pattern):

```sql
-- Insert into phronesis D1 (skeptou-phronesis)
INSERT INTO service_tokens (token_hash, name, scope, created_by, expires_at, active)
VALUES (
  sha256_hex('<random-secret>'),   -- generate with: openssl rand -hex 32
  'aristeia-energeia-reader',
  'aristeia',
  'cam',
  datetime('now', '+1 year'),
  1
);
```

Store the raw token as a Wrangler secret on the aristeia Worker:
```bash
echo "<raw-secret>" | wrangler secret put ENERGEIA_SERVICE_TOKEN --config modules/aristeia/wrangler.toml
```

---

## Wrangler secret (energeia Worker)

No new secrets needed on the energeia Worker side — it reads from the phronesis `service_tokens` D1 table as it already does for other service token consumers.

If energeia does not already have a D1 binding to phronesis for token validation, add one:
```toml
[[d1_databases]]
binding = "AUTH_DB"
database_name = "skeptou-phronesis"
database_id = "<phronesis-db-id>"
```

---

## Verification

```bash
# With a valid aristeia service token:
curl -H "Authorization: Bearer <token>" \
  https://energeia.skeptou.com/api/papers/hubbard-2024-grounding/content \
  --output test.pdf
# Expect: 200, valid PDF bytes

# Without token:
curl https://energeia.skeptou.com/api/papers/hubbard-2024-grounding/content
# Expect: 401

# With version param:
curl -H "Authorization: Bearer <token>" \
  "https://energeia.skeptou.com/api/papers/hubbard-2024-grounding/content?version=v1.2" \
  --output test-v1.2.pdf
# Expect: 200, PDF bytes for that compiled version

# Non-existent slug:
curl -H "Authorization: Bearer <token>" \
  https://energeia.skeptou.com/api/papers/no-such-paper/content
# Expect: 404
```

---

## Definition of done

- [ ] `GET /api/papers/:slug/content` returns `200` + PDF bytes for a known slug
- [ ] `?version=<tag>` returns the corresponding compiled version (or 404 if tag not found)
- [ ] Unauthenticated → `401`
- [ ] Wrong scope service token → `403`
- [ ] `ARISTEIA_SERVICE_TOKEN` secret provisioned in aristeia Worker wrangler secrets
- [ ] Aristeia engineer has confirmed endpoint is live (pre-condition unblock check)

---

## Out of scope

- Any changes to energeia UI
- Version listing endpoint (aristeia manages its own history; it only pulls specific versions)
- Bulk export
