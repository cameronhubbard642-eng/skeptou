# specs/brief-aristeia-phase1.md — Aristeia Engineer Brief, Phase 1

**Version:** rev 1
**Status:** ready for implementation
**Author:** Lead Dev / Architect — Sképtou
**Date:** 2026-05-17
**Spec:** `specs/aristeia.md` rev 2
**Phase:** 1 of 4
**Tier:** Sonnet

---

## Mission

Build `aristeia.skeptou.com` Phase 1: D1 schema (3 tables + 1 view), R2 bucket, three read endpoints, and static viewer UI mirroring strategia's pattern. No import or write endpoints in Phase 1. Access-gated before any content lands.

---

## Deliverables

1. D1 database `skeptou-aristeia` created; migrations applied (3 tables + 1 view)
2. R2 bucket `skeptou-aristeia` created; bound to Worker
3. Worker: `GET /api/publications`, `GET /api/publications/:slug`, `GET /api/publications/:slug/content`
4. Static Pages shell: list view + PDF.js viewer with citation sidebar + history dropdown
5. Cloudflare Access policy applied and QA-verified

---

## Repo layout

```
modules/aristeia/
  wrangler.toml
  package.json
  src/
    index.ts
    handlers/
      publications.ts    ← list + detail endpoints
      content.ts         ← content streaming
      auth.ts
    types.ts
  migrations/
    0001_initial_schema.sql
    0002_indexes.sql
  public/
    index.html           ← publications list
    view.html            ← viewer + citation sidebar
    viewer.css
    viewer.js
```

---

## D1 schema — `0001_initial_schema.sql`

```sql
CREATE TABLE IF NOT EXISTS publications (
  slug            TEXT    PRIMARY KEY,
  title           TEXT    NOT NULL,
  authors         TEXT    NOT NULL DEFAULT '[]',     -- JSON array
  status          TEXT    NOT NULL
                          CHECK (status IN ('draft','in_pipeline','submitted','under_review',
                                            'accepted','published','archived')),
  current_version TEXT,                              -- e.g. 'v1.3' or NULL if no version tag
  r2_key          TEXT    NOT NULL UNIQUE,           -- canonical: publications/<slug>/canonical.pdf
  byte_size       INTEGER NOT NULL,
  citation        TEXT    NOT NULL DEFAULT '{}',     -- CitationMetadata JSON
  notes           TEXT    NOT NULL DEFAULT '',
  imported_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  deleted_at      TEXT                               -- NULL = live; soft-delete tombstone
);

CREATE TABLE IF NOT EXISTS import_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT    NOT NULL REFERENCES publications(slug),
  version_tag     TEXT,                              -- energeia version tag at import time
  r2_history_key  TEXT    NOT NULL,                  -- publications/<slug>/history/<imported_at>.pdf
  byte_size       INTEGER NOT NULL,
  imported_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  import_source   TEXT    NOT NULL DEFAULT 'energeia' CHECK (import_source IN ('energeia','manual')),
  metadata_snapshot TEXT  NOT NULL DEFAULT '{}'      -- CitationMetadata at import time
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name    TEXT    NOT NULL,
  row_key       TEXT    NOT NULL,
  action        TEXT    NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE','IMPORT')),
  actor         TEXT    NOT NULL,
  snapshot      TEXT    NOT NULL DEFAULT '{}',
  occurred_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
```

## D1 schema — `0002_indexes.sql`

```sql
CREATE INDEX IF NOT EXISTS idx_publications_status      ON publications(status);
CREATE INDEX IF NOT EXISTS idx_publications_deleted_at  ON publications(deleted_at);
CREATE INDEX IF NOT EXISTS idx_import_history_slug      ON import_history(slug);
CREATE INDEX IF NOT EXISTS idx_import_history_imported  ON import_history(imported_at DESC);

CREATE VIEW IF NOT EXISTS live_publications AS
  SELECT * FROM publications WHERE deleted_at IS NULL;
```

---

## wrangler.toml (Phase 1)

```toml
name = "aristeia-worker"
main = "src/index.ts"
compatibility_date = "2025-01-01"
pages_build_output_dir = "public"

[[d1_databases]]
binding = "DB"
database_name = "skeptou-aristeia"
database_id = "FILL_AFTER_CREATE"

[[r2_buckets]]
binding = "ARISTEIA_R2"
bucket_name = "skeptou-aristeia"
```

---

## Auth

All Phase 1 endpoints: Cam session cookie or any valid Bearer service token → read access. Unauthenticated → `401`.

Same pattern as strategia: `import { authenticateRequest } from '@skeptou/auth-client'`.

---

## Handler: `GET /api/publications`

Query params: `status`, `limit` (default 50, max 200), `offset`.

Reads from `live_publications` view. Returns: `slug`, `title`, `authors`, `status`, `current_version`, `byte_size`, `imported_at`, `citation` (summary fields: `journal`, `year`, `doi` only — not full JSON).

Response:
```json
{
  "data": [
    {
      "slug": "hubbard-2024-grounding",
      "title": "Grounding and the Problem of...",
      "authors": ["Hubbard, C."],
      "status": "published",
      "current_version": "v1.2",
      "byte_size": 312400,
      "imported_at": "2026-05-17T10:00:00Z",
      "citation": { "journal": "Synthese", "year": 2024, "doi": "10.1007/..." }
    }
  ],
  "meta": { "total": 12, "limit": 50, "offset": 0 }
}
```

---

## Handler: `GET /api/publications/:slug`

Returns full row including complete `citation` JSON and `notes`. 404 if not in `live_publications`.

Also returns import history summary:
```json
{
  "slug": "hubbard-2024-grounding",
  ...,
  "citation": { /* full CitationMetadata */ },
  "import_history": [
    { "id": 3, "version_tag": "v1.2", "imported_at": "2026-05-17T10:00:00Z", "byte_size": 312400 },
    { "id": 2, "version_tag": "v1.1", "imported_at": "2026-04-01T09:00:00Z", "byte_size": 308100 }
  ]
}
```

History rows ordered by `imported_at DESC`. Do not return `r2_history_key` to client.

---

## Handler: `GET /api/publications/:slug/content`

Optional query param: `version=<id>` where `id` is an `import_history.id`.

- No `version` param → stream canonical R2 object at `publications/<slug>/canonical.pdf`
- `version=<id>` → look up `import_history` row, stream from `r2_history_key`

```typescript
if (versionId) {
  const hist = await env.DB.prepare(
    'SELECT r2_history_key FROM import_history WHERE id = ? AND slug = ?'
  ).bind(versionId, slug).first();
  if (!hist) return new Response(null, { status: 404 });
  r2Key = hist.r2_history_key;
} else {
  const pub = await env.DB.prepare(
    'SELECT r2_key FROM live_publications WHERE slug = ?'
  ).bind(slug).first();
  if (!pub) return new Response(null, { status: 404 });
  r2Key = pub.r2_key;
}

const object = await env.ARISTEIA_R2.get(r2Key);
return new Response(object.body, {
  headers: {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="${slug}.pdf"`,
    'Cache-Control': 'private, no-store',
  }
});
```

---

## Viewer UI

**List view (`/`):** Table of `live_publications` — title, authors, status badge, year, import date, link to `/view/:slug`.

**Viewer (`/view/:slug`):**
1. `GET /api/publications/:slug` → render citation sidebar + history dropdown
2. History dropdown: shows `version_tag` + `imported_at` for each history row; selecting a version reloads content from `/api/publications/:slug/content?version=<id>`
3. PDF.js renders canonical or history PDF
4. Citation sidebar (right panel or collapsible): title, authors, journal, year, doi, status, abstract

**No download button** — `Content-Disposition: inline` + PDF.js only.

Styling: Sképtou tokens (Parchment bg, Purple text, Mauve headers, Borges-Gris font). Mirror strategia viewer structure.

---

## Cloudflare Access policy

Same pattern as strategia and phronesis — blanket gate on `aristeia.skeptou.com`. QA must verify gate before any real content lands (Phase 2 pre-condition).

---

## Wrangler commands

```bash
wrangler d1 create skeptou-aristeia
# Paste database_id into wrangler.toml

wrangler d1 migrations apply skeptou-aristeia --remote
wrangler r2 bucket create skeptou-aristeia

# Verify
wrangler d1 info skeptou-aristeia
# Expect: publications, import_history, audit_log, live_publications

# Seed test row
wrangler r2 object put skeptou-aristeia/publications/test-paper/canonical.pdf \
  --file /tmp/test.pdf --content-type application/pdf

wrangler d1 execute skeptou-aristeia --remote --command \
  "INSERT INTO publications(slug,title,authors,status,r2_key,byte_size)
   VALUES('test-paper','Test Paper','[\"Hubbard, C.\"]','draft',
          'publications/test-paper/canonical.pdf',12345)"
```

---

## Phase 1 definition of done

- [ ] `wrangler d1 info skeptou-aristeia` shows `publications`, `import_history`, `audit_log`, `live_publications`
- [ ] R2 bucket bound as `ARISTEIA_R2`
- [ ] `GET /api/publications` → `200` empty array; unauthenticated → `401`
- [ ] `GET /api/publications/:slug` with test row → full JSON including empty `import_history`
- [ ] `GET /api/publications/:slug/content` streams PDF; renders in PDF.js without download dialog
- [ ] History dropdown works with a manually seeded `import_history` row (`?version=<id>`)
- [ ] Citation sidebar renders seeded citation fields
- [ ] Cloudflare Access gate verified by QA (desktop, mobile, incognito)

---

## Out of scope (Phase 1)

- `POST /api/publications/import` — Phase 2 (requires energeia `GET /api/papers/:slug/content` live — see `brief-energeia-content-endpoint.md`)
- `POST /api/publications` (manual upload) — Phase 2
- `PATCH /api/publications/:slug` (metadata edit) — Phase 2
- `DELETE /api/publications/:slug` (soft delete) — Phase 3
- LaTeX source snapshot — Phase 4
