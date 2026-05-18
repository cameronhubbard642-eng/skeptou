# specs/brief-strategia-phase1.md — Strategia Engineer Brief, Phase 1

**Version:** rev 1
**Status:** ready for implementation
**Author:** Lead Dev / Architect — Sképtou
**Date:** 2026-05-17
**Spec:** `specs/strategia.md` rev 2
**Phase:** 1 of 3
**Tier:** Sonnet

---

## Mission

Build `strategia.skeptou.com` Phase 1: D1 schema, R2 bucket, three read endpoints, and static viewer UI. No write or delete endpoints in Phase 1. Access-gated behind Cloudflare Access before any content lands.

---

## Deliverables

1. D1 database `skeptou-strategia` created; migrations applied
2. R2 bucket `skeptou-strategia` created; bound to Worker
3. Worker: three read handlers (`GET /api/documents`, `GET /api/documents/:slug`, `GET /api/documents/:slug/content`)
4. Static Pages shell: list view + in-app viewer (`/`, `/view/:slug`)
5. Cloudflare Access policy applied

---

## Repo layout

Monorepo at `github.com/cameronhubbard642-eng/skeptou`. Module lives at `modules/strategia/`. Follow pattern from `modules/phronesis/` for wrangler config, Pages Functions structure, and D1 binding.

```
modules/strategia/
  wrangler.toml
  package.json
  src/
    index.ts          ← Worker entry
    handlers/
      documents.ts    ← GET /api/documents, GET /api/documents/:slug
      content.ts      ← GET /api/documents/:slug/content
      auth.ts         ← auth-core wrapper (import from @skeptou/auth-client)
    types.ts
  migrations/
    0001_initial_schema.sql
    0002_indexes.sql
  public/
    index.html        ← list view
    view.html         ← viewer shell (PDF.js, marked.js)
    viewer.css
    viewer.js
```

---

## D1 schema — `0001_initial_schema.sql`

```sql
CREATE TABLE IF NOT EXISTS documents (
  slug            TEXT    PRIMARY KEY,
  title           TEXT    NOT NULL,
  source_team     TEXT    NOT NULL,
  source_actor    TEXT    NOT NULL,
  content_type    TEXT    NOT NULL
                          CHECK (content_type IN ('brief','annotated_pdf','worksheet','report','image','other')),
  mime_type       TEXT    NOT NULL,
  r2_key          TEXT    NOT NULL UNIQUE,
  byte_size       INTEGER NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  deleted_at      TEXT,
  tags            TEXT    NOT NULL DEFAULT '[]',
  metadata        TEXT    NOT NULL DEFAULT '{}'
);

CREATE TRIGGER IF NOT EXISTS documents_no_update
  BEFORE UPDATE ON documents FOR EACH ROW
  WHEN NEW.slug != OLD.slug OR NEW.r2_key != OLD.r2_key OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'slug, r2_key, and created_at are immutable');
END;

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name    TEXT    NOT NULL DEFAULT 'documents',
  row_key       TEXT    NOT NULL,
  action        TEXT    NOT NULL CHECK (action IN ('INSERT','DELETE')),
  actor         TEXT    NOT NULL,
  snapshot      TEXT    NOT NULL DEFAULT '{}',
  occurred_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
```

## D1 schema — `0002_indexes.sql`

```sql
CREATE INDEX IF NOT EXISTS idx_documents_source_team   ON documents(source_team);
CREATE INDEX IF NOT EXISTS idx_documents_content_type  ON documents(content_type);
CREATE INDEX IF NOT EXISTS idx_documents_created_at    ON documents(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_deleted_at    ON documents(deleted_at);
CREATE VIEW  IF NOT EXISTS live_documents AS
  SELECT * FROM documents WHERE deleted_at IS NULL;
```

---

## wrangler.toml (Phase 1)

```toml
name = "strategia-worker"
main = "src/index.ts"
compatibility_date = "2025-01-01"
pages_build_output_dir = "public"

[[d1_databases]]
binding = "DB"
database_name = "skeptou-strategia"
database_id = "FILL_AFTER_CREATE"

[[r2_buckets]]
binding = "STRATEGIA_R2"
bucket_name = "skeptou-strategia"
```

---

## Auth

Import `@skeptou/auth-client` (same package used by phronesis). All three Phase 1 endpoints require either:
- Valid session cookie (Cam session), or
- Valid Bearer service token (any scope — read access)

Unauthenticated → `401 Unauthorized`.

```typescript
import { authenticateRequest } from '@skeptou/auth-client';

// In each handler:
const ctx = await authenticateRequest(request, env);
if (!ctx) return new Response(JSON.stringify({ error: 'Unauthorized' }), {
  status: 401, headers: { 'Content-Type': 'application/json' }
});
```

---

## Handler: `GET /api/documents`

Query params: `team`, `content_type`, `since`, `until`, `tag`, `limit` (default 50, max 200), `offset` (default 0).

Reads from `live_documents` view (excludes `deleted_at IS NOT NULL`). Returns `slug`, `title`, `source_team`, `source_actor`, `content_type`, `mime_type`, `byte_size`, `created_at`, `tags`. **Do not return `r2_key` or `metadata` in list response.**

Response shape:
```json
{
  "data": [ { "slug": "...", "title": "...", ... } ],
  "meta": { "total": 47, "limit": 50, "offset": 0 }
}
```

---

## Handler: `GET /api/documents/:slug`

Returns full row for one document including `metadata`. 404 if `slug` not in `live_documents`.

Response shape:
```json
{
  "slug": "brief-2026-05-14-session-12",
  "title": "CoC Session 12 Brief — 2026-05-14",
  "source_team": "coc",
  "source_actor": "coc-scribe",
  "content_type": "brief",
  "mime_type": "text/markdown",
  "r2_key": "coc/brief-2026-05-14-session-12.md",
  "byte_size": 4821,
  "created_at": "2026-05-14T18:23:11Z",
  "tags": ["coc", "session-12"],
  "metadata": {}
}
```

---

## Handler: `GET /api/documents/:slug/content`

Fetches bytes from R2 and streams them to the client.

```typescript
const row = await env.DB.prepare(
  'SELECT mime_type, r2_key, title FROM live_documents WHERE slug = ?'
).bind(slug).first();
if (!row) return new Response(null, { status: 404 });

const object = await env.STRATEGIA_R2.get(row.r2_key);
if (!object) return new Response(null, { status: 404 });

return new Response(object.body, {
  headers: {
    'Content-Type': row.mime_type,
    'Content-Disposition': `inline; filename="${encodeURIComponent(row.title)}"`,
    'Cache-Control': 'private, no-store',
  }
});
```

`Content-Disposition: inline` prevents the browser download bar when PDF.js is rendering.

---

## Viewer UI (public/)

**`/` — list view (`index.html`):**
- Fetch `GET /api/documents` on load
- Render table: title, team, type, date, link to `/view/:slug`
- Filter controls: team dropdown, content_type dropdown, date range

**`/view/:slug` — viewer (`view.html`):**

Logic:
1. `GET /api/documents/:slug` → get `mime_type`
2. Based on `mime_type`:
   - `application/pdf` → load PDF.js; `fetch('/api/documents/:slug/content')` → `pdfjsLib.getDocument({ data: arrayBuffer })`
   - `text/markdown` → fetch content → `marked.parse(text)` → `DOMPurify.sanitize(html)` → inject into `<div id="content">`
   - `text/plain` → wrap in `<pre>`
   - `image/*` → `<img src="/api/documents/:slug/content">`
3. **No download button.** No `Content-Disposition: attachment` trigger. `inline` disposition + PDF.js = no native download bar.

CDN imports (use these exact versions to match phronesis):
```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.6/purify.min.js"></script>
```

Styling: use Sképtou design tokens from `assets/branding/`. Background Parchment `#fcf5e5`, body text Purple `#301934`, Borges-Gris font (Access-gated subdomain — Borges license applies).

---

## Cloudflare Access policy

Apply before any real documents land. Pattern:
1. DevOps creates Access application for `strategia.skeptou.com` — identity provider: same as phronesis
2. QA verifies: unauthenticated browser → redirected to Access login; incognito + fresh session blocked; mobile browser blocked

**This gate is a pre-condition for Phase 2.** Do not proceed to Phase 2 until QA clears the gate.

---

## Wrangler commands (Phase 1 setup)

```bash
# Create D1 database
wrangler d1 create skeptou-strategia
# Note the database_id and paste into wrangler.toml

# Apply migrations
wrangler d1 migrations apply skeptou-strategia --remote

# Create R2 bucket
wrangler r2 bucket create skeptou-strategia

# Verify
wrangler d1 info skeptou-strategia
# Expect: tables = [documents, audit_log], views = [live_documents]

# Smoke test (seed a test row)
wrangler r2 object put skeptou-strategia/test/test-doc.md \
  --file /tmp/test-doc.md --content-type text/markdown

wrangler d1 execute skeptou-strategia --remote --command \
  "INSERT INTO documents VALUES ('test-doc','Test Doc','test','cam','brief','text/markdown','test/test-doc.md',1234,strftime('%Y-%m-%dT%H:%M:%SZ','now'),NULL,'[]','{}')"
```

---

## Phase 1 definition of done

- [ ] `wrangler d1 info skeptou-strategia` shows `documents`, `audit_log`, `live_documents`
- [ ] R2 bucket `skeptou-strategia` created; bound as `STRATEGIA_R2`
- [ ] `GET /api/documents` → `200 { data: [], meta: { total: 0 } }` (empty DB)
- [ ] `GET /api/documents/:slug` with test row → full JSON response
- [ ] `GET /api/documents/:slug/content` streams PDF bytes; browser renders in PDF.js without download dialog
- [ ] `GET /api/documents` unauthenticated → `401`
- [ ] List view renders test row; viewer renders PDF and Markdown correctly
- [ ] Cloudflare Access gate verified by QA (desktop, mobile, incognito)

---

## Out of scope (Phase 1)

- `POST /api/documents` (upload) — Phase 2
- `DELETE /api/documents/:slug` — Phase 2
- Service token provisioning for specialist ingest — Phase 3
- Agora-auto-publish webhook — Phase 3
