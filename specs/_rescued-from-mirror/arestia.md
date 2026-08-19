# specs/arestia.md — Arestia Professional Publications Archive

**Version:** rev 1
**Status:** draft — awaiting Cam review
**Author:** Lead Dev / Architect — Sképtou
**Date:** 2026-05-16
**Depends on:** `specs/auth-core.md`, `specs/energeia.md`, `ARCHITECTURE.md`
**Consumers:** DevOps engineer, Arestia engineer, Cam

---

## §I — Purpose + scope

### §I.1 — What arestia is

`arestia.skeptou.com` (Slot 5) is the canonical, permanent archive for Cam's professional documents and publications. Its defining property is **in-perpetuity storage**: once a document is imported, its archived form is never silently modified or deleted without explicit Cam action and audit trail. It is a curatorial surface, not a live sync.

Documents that belong in arestia:

| Document class | Examples | Format |
|---|---|---|
| Published journal articles | Peer-reviewed philosophy papers | PDF (canonical compiled) |
| Book chapters | Anthology contributions | PDF |
| Conference proceedings | APA, SPEP, Pacific APA papers | PDF |
| White papers / working papers | Distributed preprints | PDF |
| Professional letters | Recommendation letters authored by Cam, formal correspondence | PDF |
| CV snapshot versions | Point-in-time CV exports | PDF |
| Other professional documents | Abstract submissions, dissertation chapters (final) | PDF or Markdown |

Documents that do **not** belong in arestia:

- Teaching materials (syllabi, handouts, rubrics) — future `paideia` module
- Working drafts under active revision — those live in energeia
- Team-generated reports and session briefs — those live in strategia
- Personal non-professional documents — out of scope

### §I.2 — Relationship to energeia

Energeia is the **live pipeline**: Obsidian/Scrivener drafts → compiled LaTeX PDF → versioned publication artifact in agora. Arestia is the **archive sink**: when a paper reaches a publication milestone (accepted, revised-and-resubmitted, formally published), Cam imports the canonical PDF from energeia as a frozen snapshot.

The critical constraint: **no live sync**. If Cam edits the paper in energeia and recompiles after import, the arestia archive is not updated automatically. Cam must manually re-import to update the archived version. This is intentional — the archive records what was published at a point in time, not what is currently in the pipeline.

### §I.3 — Design posture

Arestia is Cam-only on the write side. No specialist service tokens. The write operations are:
1. Import from energeia (Worker fetches canonical PDF from energeia, saves snapshot in R2)
2. Out-of-band manual upload (PDF not in energeia — pre-system publications, external book chapters)
3. Metadata annotation (Cam adds/edits citation metadata and notes post-import)
4. Delete (soft delete; Cam-only; confirmation required; see §VIII)

All reads are authenticated (any valid auth-core session, consistent with the Access-gated subdomain).

---

## §II — Architecture overview

```
arestia.skeptou.com/*            ← Cloudflare Pages (static UI shell)
  /                              ← Publications list / index
  /view/:slug                    ← In-app viewer route
  /import                        ← Import from energeia form (Cam session only)
  /upload                        ← Out-of-band upload form (Cam session only)

arestia.skeptou.com/api/*        ← Cloudflare Worker (arestia-worker)
  GET    /api/publications        ← List (filters: pub_type, year, source_paper_slug, canonical)
  GET    /api/publications/:slug  ← Metadata
  GET    /api/publications/:slug/content    ← Stream R2 object (PDF)
  POST   /api/publications/import           ← Import from energeia (Cam session only)
  POST   /api/publications                  ← Out-of-band manual upload — multipart (Cam session only)
  PATCH  /api/publications/:slug            ← Update notes / citation_metadata (Cam session only)
  DELETE /api/publications/:slug            ← Soft delete (Cam session only)
```

**Storage:**

```
R2 (skeptou-arestia)             ← Document bytes (PDFs, snapshots)
D1 (skeptou-arestia)             ← Publication metadata, import history, audit log
```

**Auth layer:** `@skeptou/auth-client` (auth-core). Session-cookie auth only — no service token path for any write operation. Cloudflare Access gate covers `arestia.skeptou.com/*`.

**Worker bindings (wrangler.toml):**

```toml
[[r2_buckets]]
binding = "ARESTIA_R2"
bucket_name = "skeptou-arestia"

[[d1_databases]]
binding = "ARESTIA_DB"
database_name = "skeptou-arestia"
database_id = "<uuid>"

[vars]
ENERGEIA_BASE_URL = "https://energeia.skeptou.com"
```

The Worker calls energeia's `/api/papers/:slug/content` endpoint using a scoped service token stored in a `ENERGEIA_SERVICE_TOKEN` secret (see §IX.2).

---

## §III — Storage architecture

### §III.1 — Why R2 + D1

Same rationale as strategia: R2 for binary payloads (PDFs up to ~100MB), D1 for structured queryable metadata. Publication PDFs are typically 0.5–15MB; an entire career archive of 50–100 papers occupies < 1GB.

### §III.2 — R2 object key schema

**Canonical (current) import:**

```
publications/<slug>/canonical.pdf
```

**Historical snapshots (prior imports, retained on re-import):**

```
publications/<slug>/history/<imported_at>.pdf
```

When Cam re-imports a paper, the prior R2 object is moved to the `history/` prefix before the new canonical is written. This means the current PDF is always at `publications/<slug>/canonical.pdf` and every prior version is preserved in `history/`.

**LaTeX source snapshot (optional — open question Q4 in §XII):**

```
publications/<slug>/source/canonical.zip
publications/<slug>/source/history/<imported_at>.zip
```

**Out-of-band uploads (papers not sourced from energeia):**

```
publications/<slug>/canonical.pdf
```

Same key schema as energeia-sourced; `source_paper_slug` is NULL in D1.

### §III.3 — Import history model

Rather than a single row per publication that gets overwritten on re-import, arestia uses a two-table model:

- `publications` — one row per publication (canonical state: current title, citation metadata, notes, current R2 key)
- `import_history` — one row per import event (linked to publication slug, stores version tag, import timestamp, byte size of that snapshot)

This gives the list view a clean single-entry-per-publication UX, while preserving full re-import history in `import_history`. The viewer shows the canonical PDF; a "history" drawer in the detail view lists prior imports with links to their archived snapshots.

---

## §IV — D1 schema

### §IV.1 — Migration files

Location: `modules/arestia/migrations/`

```
0001_initial_schema.sql
0002_indexes.sql
```

Applied via `wrangler d1 migrations apply skeptou-arestia`.

### §IV.2 — `0001_initial_schema.sql`

```sql
-- ============================================================
-- Arestia publication metadata — skeptou-arestia D1 database
-- Sképtou / specs/arestia.md rev 1
-- ============================================================

CREATE TABLE IF NOT EXISTS publications (
  slug                TEXT    PRIMARY KEY,
  title               TEXT    NOT NULL,
  pub_type            TEXT    NOT NULL
                              CHECK (pub_type IN (
                                'article','chapter','proceedings','whitepaper',
                                'letter','cv','other'
                              )),
  source_paper_slug   TEXT,               -- NULL if out-of-band import
  source_version      TEXT,               -- energeia version tag at last import; NULL if out-of-band
  r2_key              TEXT    NOT NULL,   -- always points to canonical: publications/<slug>/canonical.pdf
  r2_key_source       TEXT,               -- optional LaTeX source snapshot key; NULL if not captured
  mime_type           TEXT    NOT NULL DEFAULT 'application/pdf',
  byte_size           INTEGER NOT NULL,
  citation_metadata   TEXT    NOT NULL DEFAULT '{}',  -- JSON: journal, volume, issue, year, pages, doi, isbn, venue, etc.
  notes               TEXT,               -- Cam-authored annotation; nullable
  imported_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  archived_at         TEXT,               -- NULL = live; set on soft delete
  metadata            TEXT    NOT NULL DEFAULT '{}'   -- escape hatch for future fields
);

-- Trigger: keep updated_at current on edits
CREATE TRIGGER IF NOT EXISTS publications_updated_at
  AFTER UPDATE ON publications
  FOR EACH ROW
BEGIN
  UPDATE publications SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
  WHERE slug = NEW.slug;
END;

CREATE TABLE IF NOT EXISTS import_history (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_slug    TEXT    NOT NULL REFERENCES publications(slug),
  source_paper_slug   TEXT,               -- NULL if out-of-band
  source_version      TEXT,               -- version tag at this import
  r2_key_snapshot     TEXT    NOT NULL,   -- full key to the historical snapshot object
  r2_key_source_snapshot TEXT,           -- optional LaTeX source snapshot at this version
  byte_size           INTEGER NOT NULL,
  imported_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  import_actor        TEXT    NOT NULL DEFAULT 'cam'
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name    TEXT    NOT NULL,
  row_key       TEXT    NOT NULL,
  action        TEXT    NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE','IMPORT','REIMPORT')),
  actor         TEXT    NOT NULL,
  snapshot      TEXT    NOT NULL DEFAULT '{}',
  occurred_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
```

**Design notes:**

- `publications.slug` — Cam-chosen or auto-derived from `source_paper_slug` (e.g. energeia slug → arestia slug). Must be URL-safe.
- `publications.imported_at` — timestamp of the most recent import. Updated on re-import (alongside `source_version` and `byte_size`). `created_at` is immutable — records when the publication entry was first created.
- `publications.archived_at` — soft delete flag. `NULL` = live in the archive. Set to a timestamp on delete. R2 canonical object is **not** deleted on soft delete (see §VIII).
- `citation_metadata` — JSON blob. Recommended fields: `journal`, `volume`, `issue`, `year`, `pages`, `doi`, `isbn`, `venue`, `publisher`, `editors`, `abstract`. Not enforced at DB level; validated by the PATCH handler.
- `import_history` — each row is a point-in-time import event. The R2 object at `r2_key_snapshot` is the PDF as it existed at `imported_at`. These objects are retained indefinitely (open question Q5 in §XII).
- No service token columns — all writes are Cam-session-only; no need to track token-based actors.

### §IV.3 — `0002_indexes.sql`

```sql
CREATE INDEX IF NOT EXISTS idx_publications_pub_type         ON publications(pub_type);
CREATE INDEX IF NOT EXISTS idx_publications_source_slug      ON publications(source_paper_slug);
CREATE INDEX IF NOT EXISTS idx_publications_archived_at      ON publications(archived_at);
CREATE INDEX IF NOT EXISTS idx_publications_created_at       ON publications(created_at);
CREATE INDEX IF NOT EXISTS idx_import_history_pub_slug       ON import_history(publication_slug);
CREATE INDEX IF NOT EXISTS idx_import_history_imported_at    ON import_history(imported_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_row_key             ON audit_log(row_key);
CREATE INDEX IF NOT EXISTS idx_audit_log_occurred_at         ON audit_log(occurred_at);
```

### §IV.4 — Live publications view

```sql
CREATE VIEW IF NOT EXISTS live_publications AS
  SELECT * FROM publications WHERE archived_at IS NULL;
```

All read API endpoints query `live_publications`. Soft-deleted entries are invisible to list/get/content unless an explicit admin query is made.

### §IV.5 — Citation metadata JSON shape (recommended)

The `citation_metadata` field is a JSON object. The PATCH handler validates against this shape (extra keys are allowed via the `metadata` escape hatch on the root row):

```typescript
interface CitationMetadata {
  journal?:     string;     // e.g. "Philosophical Review"
  volume?:      string;     // e.g. "132"
  issue?:       string;     // e.g. "3"
  year?:        number;     // e.g. 2026
  pages?:       string;     // e.g. "441–480"
  doi?:         string;     // e.g. "10.1093/philrev/xxx"
  isbn?:        string;     // for book chapters
  venue?:       string;     // e.g. "APA Eastern Division 2026" (for proceedings)
  publisher?:   string;     // e.g. "Oxford University Press"
  editors?:     string[];   // for book chapters
  abstract?:    string;     // short abstract text
  url?:         string;     // published URL if open-access
  status?:      string;     // e.g. "published", "forthcoming", "under review", "accepted"
}
```

---

## §V — Import model

### §V.1 — Import from energeia (pull)

The primary ingestion path. Cam navigates to `/import` in the arestia UI (or runs the equivalent API call), selects a paper slug from energeia, and triggers an import. The arestia Worker:

1. Calls `GET https://energeia.skeptou.com/api/papers/:source_paper_slug/content` with a scoped service token (§IX.2)
2. Receives the canonical compiled PDF from energeia
3. Writes the PDF bytes to R2 at `publications/<slug>/canonical.pdf` (overwriting if re-import)
4. If prior canonical exists (re-import): moves the current canonical to `publications/<slug>/history/<now>.pdf` first
5. Inserts or updates the D1 `publications` row
6. Appends a row to `import_history`
7. Writes an `audit_log` row (`IMPORT` or `REIMPORT`)
8. Returns `201` with the updated publication metadata

**Fetch of source version:** arestia queries `GET https://energeia.skeptou.com/api/papers/:slug` (metadata endpoint) to retrieve the current `version` tag before fetching content. This version tag is stored in `source_version` on the D1 row and in `import_history`.

**Re-import flow (paper already in arestia):**

```
[Prior canonical]   publications/<slug>/canonical.pdf  (e.g. v1.2 bytes)
                          ↓ copy to
[History snapshot]  publications/<slug>/history/2026-04-01T10:00:00Z.pdf
                          ↓ then write
[New canonical]     publications/<slug>/canonical.pdf  (e.g. v1.3 bytes)
```

D1 `publications` row: `source_version`, `byte_size`, `imported_at` updated in place. `created_at` unchanged. New `import_history` row added.

**Import handler sketch:**

```typescript
async function importFromEnergeia(
  body: ImportBody,
  actor: string,
  env: Env
): Promise<Response> {
  const { slug, source_paper_slug, pub_type, title } = body;

  // 1. Fetch energeia paper metadata to get version tag
  const metaRes = await fetch(
    `${env.ENERGEIA_BASE_URL}/api/papers/${source_paper_slug}`,
    { headers: { Authorization: `Bearer ${env.ENERGEIA_SERVICE_TOKEN}` } }
  );
  if (!metaRes.ok) return Response.json({ error: 'energeia paper not found' }, { status: 404 });
  const energeiaMeta = await metaRes.json() as { version: string };
  const sourceVersion = energeiaMeta.version;

  // 2. Fetch canonical PDF from energeia
  const pdfRes = await fetch(
    `${env.ENERGEIA_BASE_URL}/api/papers/${source_paper_slug}/content`,
    { headers: { Authorization: `Bearer ${env.ENERGEIA_SERVICE_TOKEN}` } }
  );
  if (!pdfRes.ok) return Response.json({ error: 'energeia content fetch failed' }, { status: 502 });
  const pdfBytes = await pdfRes.arrayBuffer();
  const byteSize = pdfBytes.byteLength;

  // 3. Check if publication already exists (re-import)
  const existing = await env.ARESTIA_DB.prepare(
    `SELECT slug, r2_key, imported_at FROM publications WHERE slug = ?`
  ).bind(slug).first<{ slug: string; r2_key: string; imported_at: string } | null>();

  const now          = new Date().toISOString();
  const canonicalKey = `publications/${slug}/canonical.pdf`;
  const action       = existing ? 'REIMPORT' : 'IMPORT';

  let stmts = [];

  if (existing) {
    // 3a. Move current canonical to history before overwriting
    const historyKey = `publications/${slug}/history/${existing.imported_at}.pdf`;
    const current    = await env.ARESTIA_R2.get(existing.r2_key);
    if (current) {
      await env.ARESTIA_R2.put(historyKey, await current.arrayBuffer(), {
        httpMetadata: { contentType: 'application/pdf' },
      });
      stmts.push(
        env.ARESTIA_DB.prepare(
          `INSERT INTO import_history (publication_slug, source_paper_slug, source_version, r2_key_snapshot, byte_size, imported_at, import_actor)
           SELECT slug, source_paper_slug, source_version, ?, byte_size, imported_at, ? FROM publications WHERE slug = ?`
        ).bind(historyKey, actor, slug)
      );
    }
    stmts.push(
      env.ARESTIA_DB.prepare(
        `UPDATE publications SET source_version=?, r2_key=?, byte_size=?, imported_at=? WHERE slug=?`
      ).bind(sourceVersion, canonicalKey, byteSize, now, slug)
    );
  } else {
    stmts.push(
      env.ARESTIA_DB.prepare(
        `INSERT INTO publications (slug, title, pub_type, source_paper_slug, source_version, r2_key, byte_size)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(slug, title, pub_type, source_paper_slug, sourceVersion, canonicalKey, byteSize)
    );
  }

  stmts.push(
    env.ARESTIA_DB.prepare(
      `INSERT INTO audit_log (table_name, row_key, action, actor, snapshot) VALUES ('publications', ?, ?, ?, ?)`
    ).bind(slug, action, actor, JSON.stringify({ slug, source_paper_slug, source_version: sourceVersion, byte_size: byteSize }))
  );

  // 4. Write new canonical to R2
  await env.ARESTIA_R2.put(canonicalKey, pdfBytes, {
    httpMetadata: { contentType: 'application/pdf' },
  });

  // 5. Commit D1 changes atomically
  await env.ARESTIA_DB.batch(stmts);

  const row = await env.ARESTIA_DB.prepare(
    `SELECT * FROM publications WHERE slug = ?`
  ).bind(slug).first();

  return Response.json({ data: row }, { status: existing ? 200 : 201 });
}
```

### §V.2 — Out-of-band manual upload

For publications that predate the energeia system, external book chapters, or any PDF not in the pipeline. Cam uploads directly via the `/upload` form.

`source_paper_slug` is `NULL` on the D1 row. `source_version` is `NULL`. All other fields follow the same schema.

There is no automated re-import path for out-of-band documents — Cam can upload a new version via the same `POST /api/publications` endpoint using the same `slug`, which triggers the same canonical-move-to-history flow.

**MIME allowlist for out-of-band uploads:**

```typescript
const ALLOWED_MIME_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/markdown':   'md',
  'text/plain':      'txt',
};
```

Arestia is narrower than strategia — it focuses on PDFs. Markdown is allowed for cases like plain-text letters or notes. Images are out of scope (a publication is a document, not an image).

### §V.3 — Import form UX

The `/import` route renders a form that:
1. Calls `GET /api/import/energeia-papers` (a passthrough to energeia's paper list) to populate a dropdown of available energeia papers
2. Pre-fills `source_paper_slug`, `title` from the selected paper's energeia metadata
3. Lets Cam choose/confirm `slug` (defaulting to the energeia slug), `pub_type`, and optionally seed `citation_metadata` fields
4. On submit: `POST /api/publications/import`

The energeia paper list is fetched fresh on each form load (no caching) to ensure the dropdown reflects current energeia state.

---

## §VI — API surface

### §VI.1 — `GET /api/publications`

List live publications.

**Query parameters:**

| Param | Type | Description |
|---|---|---|
| `pub_type` | string | Filter by pub_type enum |
| `year` | integer | Filter by `json_extract(citation_metadata, '$.year') = year` |
| `source_paper_slug` | string | Filter to publications sourced from a specific energeia paper |
| `status` | string | Filter by `json_extract(citation_metadata, '$.status')` |
| `limit` | integer | Max results (default 50, max 200) |
| `offset` | integer | Pagination offset (default 0) |

**Auth:** any valid auth-core session.

**Response `200`:**
```json
{
  "data": [
    {
      "slug": "consciousness-2026-phil-review",
      "title": "Consciousness and the Extended Mind",
      "pub_type": "article",
      "source_paper_slug": "paper-consciousness",
      "source_version": "v1.3",
      "byte_size": 412800,
      "imported_at": "2026-04-15T09:11:00Z",
      "created_at": "2026-04-15T09:11:00Z",
      "citation_metadata": {
        "journal": "Philosophical Review",
        "year": 2026,
        "doi": "10.1093/philrev/xxx",
        "status": "published"
      }
    }
  ],
  "meta": { "total": 12, "limit": 50, "offset": 0 }
}
```

Note: `r2_key`, `r2_key_source`, `notes`, `metadata` are returned only in `GET /api/publications/:slug`.

---

### §VI.2 — `GET /api/publications/:slug`

Full metadata for one publication, including notes, r2_key, and import history summary.

**Auth:** any valid auth-core session.

**Response `200`:**
```json
{
  "data": {
    "slug": "consciousness-2026-phil-review",
    "title": "Consciousness and the Extended Mind",
    "pub_type": "article",
    "source_paper_slug": "paper-consciousness",
    "source_version": "v1.3",
    "r2_key": "publications/consciousness-2026-phil-review/canonical.pdf",
    "mime_type": "application/pdf",
    "byte_size": 412800,
    "citation_metadata": { ... },
    "notes": "Published April 2026. Revised from APA 2025 presentation version.",
    "imported_at": "2026-04-15T09:11:00Z",
    "created_at": "2026-04-15T09:11:00Z",
    "updated_at": "2026-04-15T09:11:00Z",
    "import_history": [
      {
        "source_version": "v1.2",
        "imported_at": "2026-03-01T14:00:00Z",
        "byte_size": 398400,
        "r2_key_snapshot": "publications/consciousness-2026-phil-review/history/2026-03-01T14:00:00Z.pdf"
      }
    ]
  }
}
```

---

### §VI.3 — `GET /api/publications/:slug/content`

Stream the canonical R2 PDF to the browser. Same response pattern as strategia.

**Auth:** any valid auth-core session.

**Headers:**
```
Content-Type: application/pdf
Content-Disposition: inline; filename="<slug>.pdf"
X-Content-Type-Options: nosniff
Cache-Control: private, no-store
```

**Optional:** `?version=<imported_at_timestamp>` param to stream a historical snapshot rather than the canonical. If provided, the Worker fetches from `publications/<slug>/history/<version>.pdf` in R2.

---

### §VI.4 — `POST /api/publications/import`

Import from energeia. Cam-only.

**Auth:** session cookie only.

**Request body (JSON):**
```typescript
interface ImportBody {
  slug:              string;   // arestia slug (URL-safe; defaults to source_paper_slug if absent)
  source_paper_slug: string;   // energeia paper slug to fetch
  pub_type:          string;   // pub_type enum
  title:             string;   // publication title (can differ from energeia title)
  citation_metadata?: object;  // optional: pre-seed at import time
}
```

**Response `201`** (first import) or `200` (re-import): publication metadata row.

**Response `403`:** non-session auth attempt.

---

### §VI.5 — `POST /api/publications`

Out-of-band manual upload. Cam-only.

**Auth:** session cookie only.

**Request:** `Content-Type: multipart/form-data`

| Field | Required | Description |
|---|---|---|
| `file` | yes | PDF (or .md / .txt) binary |
| `slug` | yes | URL-safe unique identifier |
| `title` | yes | Publication title |
| `pub_type` | yes | pub_type enum value |
| `citation_metadata` | no | JSON string |
| `notes` | no | Cam annotation |

**Response `201`:** publication metadata row.

**Re-upload (same slug, updated file):** same slug + new file triggers the canonical-move-to-history flow identically to re-import. Cam uses this to update an out-of-band document.

---

### §VI.6 — `PATCH /api/publications/:slug`

Update notes and/or citation_metadata. No content replacement (that goes through re-import or re-upload). Cam-only.

**Auth:** session cookie only.

**Request body (JSON — all fields optional):**
```typescript
interface PatchBody {
  notes?:             string;
  citation_metadata?: Partial<CitationMetadata>;
  title?:             string;  // title correction allowed
}
```

**Behavior:** Merges `citation_metadata` JSON at the top level (does not deep-merge nested objects). Sets `updated_at`. Writes `audit_log` UPDATE row.

**Response `200`:** updated publication metadata.

---

### §VI.7 — `DELETE /api/publications/:slug`

Soft delete. Cam-only. See §VIII for full delete affordance spec.

**Auth:** session cookie only.

**Response `204`:** no body.
**Response `403`:** non-session attempt.
**Response `404`:** not found or already archived.

---

### §VI.8 — `GET /api/import/energeia-papers`

Passthrough: fetches available paper list from energeia for the import form dropdown.

**Auth:** session cookie (this endpoint is UI-support only; not intended for programmatic use).

**Behavior:** calls `GET https://energeia.skeptou.com/api/papers` with the `ENERGEIA_SERVICE_TOKEN`, returns the list to the browser. Strips any energeia-internal fields not needed for the import form.

**Response `200`:**
```json
{
  "data": [
    { "slug": "paper-consciousness", "title": "Consciousness and the Extended Mind", "version": "v1.3" },
    { "slug": "paper-grounding", "title": "Metaphysical Grounding and Causation", "version": "v2.1" }
  ]
}
```

---

## §VII — In-app viewer

### §VII.1 — Rendering strategy

| MIME type | Renderer |
|---|---|
| `application/pdf` | **PDF.js** (same as strategia — see §VII.2) |
| `text/markdown` | `marked.js` + DOMPurify sanitize |
| `text/plain` | `<pre>` block |
| Unsupported | "Preview unavailable" stub |

### §VII.2 — PDF.js

Identical configuration to strategia. PDF.js fetches from `/api/publications/:slug/content` using the browser's session cookie. `Content-Disposition: inline` + PDF.js rendering = no native browser PDF toolbar, no download button.

The viewer page adds one arestia-specific affordance: a **"View prior version"** dropdown that lists `import_history` entries. Selecting a prior version fetches `/api/publications/:slug/content?version=<imported_at>`, which streams the historical R2 snapshot. The viewer heading changes to "Viewing archived version — [date]" when a historical version is active.

### §VII.3 — Citation sidebar

The detail view at `/view/:slug` renders a citation sidebar alongside the PDF viewer:

| Field | Display |
|---|---|
| Title | Large heading |
| Authors | (from citation_metadata or Cam's profile) |
| Journal / Venue | Badge |
| Year | — |
| DOI | Clickable link (opens in new tab — external) |
| Status | Badge (published / forthcoming / under review) |
| Notes | Cam-authored annotation, Markdown rendered |

The sidebar is read-only in the viewer. A pencil icon opens an inline edit form that POSTs to `PATCH /api/publications/:slug`.

### §VII.4 — No download UI surface

Same policy as strategia: no download button in the UI. Access is for on-screen reading, not distribution. A technically capable user can access the `/content` endpoint directly; this is by policy, not by mechanism.

---

## §VIII — Delete affordance

### §VIII.1 — "In perpetuity" and deletion

Arestia's stated purpose is "dedicated access/storage in perpetuity." This creates tension with the delete option. The resolution recommended here:

**Soft delete only.** The D1 row is tombstoned (`archived_at` set). The R2 canonical object and all history snapshots are **retained indefinitely** (not purged on soft delete). The document disappears from the list view and viewer, but all bytes remain in R2 and can be recovered by Cam (or the engineer) via direct R2 access or by unsetting `archived_at`.

Rationale: "in perpetuity" means the published record is preserved against accidental loss. The delete affordance is for mistakes and duplicates — importing the wrong version, a duplicate slug, a mis-categorized upload — not for removing a published paper from existence. By keeping R2 bytes intact, soft delete satisfies the UI need without violating the archival guarantee.

**Open question Q5 (§XII):** Does Cam agree with this interpretation? If a paper was in error (e.g. imported the wrong file), does Cam want R2 bytes purged or retained?

### §VIII.2 — Delete flow

1. Cam clicks "Delete" on a publication in the list or detail view
2. Confirmation modal appears:
   > Delete "Consciousness and the Extended Mind" (v1.3, imported 2026-04-15)?
   > This will remove it from the archive. The original file is retained internally.
   > This action requires your confirmation.
   > [Cancel] [Delete publication]
3. On confirm: `DELETE /api/publications/:slug`
4. Worker: sets `archived_at = now()` on D1 row, writes `audit_log` DELETE row, returns `204`
5. R2 objects (canonical + history snapshots) are NOT deleted
6. List refreshes; publication is no longer visible

### §VIII.3 — Cam-session gate

Same pattern as strategia: `auth.mode !== 'session'` check at the handler level. No service token (there are none for arestia) can delete.

---

## §IX — Auth + scopes

### §IX.1 — Session-only write model

All write operations (import, upload, PATCH, delete) require a Cam session cookie. There are no service tokens for the arestia write surface. This reflects the curatorial nature of the archive: publication decisions are Cam's alone.

The auth check for write routes:

```typescript
async function requireCamSession(request: Request, env: Env): Promise<AuthContext> {
  const ctx = await authenticateRequest(request, env);
  if (ctx.mode !== 'session') {
    throw new Response(JSON.stringify({ error: 'session auth required' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return ctx;
}
```

Read routes (`GET /api/publications*`) accept any valid auth-core session, consistent with the Access-gated subdomain. (There are no service tokens at all for arestia, so in practice "any valid session" means Cam's browser session.)

### §IX.2 — Energeia service token (Worker-to-Worker)

The arestia Worker needs to call energeia's API to perform imports. This requires a service token scoped for energeia reads. This is a **Worker-to-Worker** credential — it lives as a Cloudflare Worker secret (`ENERGEIA_SERVICE_TOKEN`), not a user-facing token.

Token provisioning: Cam provisions a read-scoped service token in energeia (following energeia's `spec/energeia.md` service token model), stores it as a Wrangler secret:

```bash
wrangler secret put ENERGEIA_SERVICE_TOKEN --env production
```

This token is never exposed to the browser and is used only in the server-side import handler.

---

## §X — Phasing

### Phase 1 — Schema + read endpoints + viewer

**Scope:** D1 schema applied, R2 bucket created. Read endpoints live. Static UI shell with list view and in-app PDF.js viewer. No write endpoints yet.

**Deliverables:**
- D1 migration SQL applied; `wrangler d1 info skeptou-arestia` shows 3 tables + 1 view
- R2 bucket `skeptou-arestia` created; bound as `ARESTIA_R2`
- Worker: `GET /api/publications`, `GET /api/publications/:slug`, `GET /api/publications/:slug/content`
- Static Pages shell at `arestia.skeptou.com` with list view and `/view/:slug` route
- Cloudflare Access policy applied and QA-verified (gate before any real documents)

**Verification:**
- `GET /api/publications` returns `200` with empty array (unauthenticated → `401`)
- Manually seeded test row (via `wrangler d1 execute` + `wrangler r2 object put`) appears in list and renders in PDF.js viewer
- Prior-version dropdown in viewer works with a manually seeded history snapshot
- Access gate verified by QA on desktop and mobile, incognito

### Phase 2 — Import + manual upload

**Scope:** `POST /api/publications/import` live. `POST /api/publications` (out-of-band) live. `PATCH /api/publications/:slug` live. `GET /api/import/energeia-papers` live. Import form UI at `/import`. Manual upload form at `/upload`. Citation sidebar edit in viewer.

**Pre-condition:** energeia read API (`GET /api/papers`, `GET /api/papers/:slug/content`) must be live before arestia import can be tested end-to-end.

**Deliverables:**
- `ENERGEIA_SERVICE_TOKEN` secret provisioned and validated
- Import handler: energeia metadata fetch → PDF fetch → R2 canonical write → D1 INSERT/UPDATE → import_history INSERT → audit_log
- Re-import flow: history move → new canonical write → D1 UPDATE
- Out-of-band upload handler with MIME allowlist
- PATCH handler for notes + citation_metadata merge
- Import form UI with energeia paper dropdown
- Citation sidebar + inline edit in viewer

**Verification:**
- Import a live energeia paper → appears in arestia list with correct source_version
- Re-import same paper → prior canonical appears in history dropdown; `import_history` table shows two rows
- PATCH citation_metadata → updates reflected in citation sidebar
- Out-of-band upload (PDF not in energeia) → appears in list with `source_paper_slug = NULL`

### Phase 3 — Delete affordance + audit log review

**Scope:** `DELETE /api/publications/:slug` live. Soft delete tombstone model. `GET /api/audit/since/:timestamp` endpoint for Cam admin audit review. Confirmation modal in UI.

**Deliverables:**
- Delete handler: sets `archived_at`, writes `audit_log` DELETE row; R2 bytes retained
- Confirmation modal with full citation displayed
- Cam admin audit view (hidden route, session only): `GET /api/audit/since/:timestamp` returning `audit_log` rows

**Verification:**
- Delete from UI → publication disappears from list → `archived_at` set in D1 → R2 object still exists (verify with `wrangler r2 object get`)
- Service token (if any were to be tested) returns `403` on delete attempt
- Audit log shows INSERT, UPDATE, and DELETE actions with correct actor and snapshots

### Phase 4 — LaTeX source snapshot (if Q4 approved)

**Scope:** If Cam approves LaTeX source snapshot capture (§XII Q4), the import handler is extended to also fetch the `.zip` source bundle from energeia and store it at `publications/<slug>/source/canonical.zip`.

**Deliverables:** extended import handler; history move for source zip alongside PDF; `/source/content` endpoint (streams zip).

---

## §XI — Security posture

### §XI.1 — Access gate (non-negotiable)

Same standing rule as all private subdomains: DevOps deploys empty Access-gated placeholder → QA verifies gating → real publications land. Academic papers and professional letters are sensitive; Access gate is mandatory before content.

### §XI.2 — No service tokens on the user-facing write surface

Arestia is intentionally write-restricted to Cam's session. There is no write service token model to leak or compromise. The only service token is the Worker-to-Worker `ENERGEIA_SERVICE_TOKEN`, which is a Wrangler secret (not user-accessible, not returned in any API response).

### §XI.3 — Content-Security-Policy

Same CSP as strategia:
```
Content-Security-Policy: default-src 'self';
  script-src 'self' https://cdnjs.cloudflare.com;
  style-src 'self' 'unsafe-inline';
  img-src 'self' blob:;
  object-src 'none';
  frame-ancestors 'none'
```

### §XI.4 — DOI and external links

The citation sidebar may display external URLs (DOI links, publisher pages). These open in a new tab (`target="_blank" rel="noopener noreferrer"`). No other external resources are loaded by the viewer. The arestia Worker does not proxy external URLs.

---

## §XII — Open questions for Cam

| # | Question | Blocks | Recommendation |
|---|---|---|---|
| Q1 | **Module name spelling:** Cam used "arestia" throughout. Greek roots: ἀρετή (aretḗ, "excellence/virtue") → transliteration would be "aretia"; ἀριστεία (aristeía, "heroic feat / deeds of the best") → "aristeia". Is "arestia" a deliberate hybrid transliteration, or should the folder/subdomain use "aristeia" or "aretia"? | module slug, subdomain DNS | Use Cam's spelling ("arestia") unless Cam corrects |
| Q2 | **Re-import: new row vs overwrite:** Spec recommends two-table model (canonical `publications` row updated in place; `import_history` row appended; prior R2 object moved to history prefix). Alternative: each import creates a new `publications` row with a version-suffixed slug. Recommended approach preserves clean list UX (one entry per paper) while keeping full history. Cam confirms? | §IV, §V.1 schema | Two-table model (update publications + append import_history) |
| Q3 | **Soft delete retention:** On soft delete, R2 canonical and history snapshot bytes are retained indefinitely. Cam's "in perpetuity" framing suggests bytes should never be auto-purged. Confirm: soft delete = tombstone only, R2 retained forever? Or should there be a 30-day R2 purge window after soft delete for true removal? | §VIII.1 | Retain R2 bytes indefinitely; soft delete is UI-only tombstone |
| Q4 | **LaTeX source snapshot:** Should the import handler also capture the LaTeX source bundle (`.zip`) from energeia alongside the PDF? This preserves the source at the imported version, enabling later recompilation. Adds complexity to import handler + R2 key schema. | Phase 4 scope | Optional; recommend deferring to Phase 4 after PDF import is stable |
| Q5 | **Energeia API readiness pre-condition:** Phase 2 requires `GET /api/papers/:slug/content` to be live on energeia. Is this endpoint planned in the energeia spec? Confirm energeia engineer brief should include this read endpoint. | Phase 2 import | Yes — flag to energeia engineer |
| Q6 | **Citation metadata completeness:** The `CitationMetadata` shape in §IV.5 covers standard fields. Any additional fields needed for Cam's specific publication types (e.g., `series`, `conference_location`, `presentation_date`, `co-authors`)? | PATCH handler validation | Treat as extension-friendly; Cam adds fields via `metadata` escape hatch until formally added |

---

## §XIII — Out of scope

- Live sync with energeia (any change in energeia auto-updates arestia) — explicitly excluded
- Teaching materials (syllabi, handouts, rubrics) — future `paideia` module
- Report generation — that is strategia
- Collaboration / sharing with external parties — future `phero` module
- Version control of citation metadata (only current state stored in D1; historical JSON states not tracked)
- Full-text search across PDF content
- DOI resolver / metadata auto-import from CrossRef (possible future extension; not in scope)
- Public view (arestia is Access-gated; no public-facing publications page — that lives on `energeia.skeptou.com` or `skeptou.com` apex)

---

## §XIV — Definition of done

**Phase 1:**
- [ ] D1 `skeptou-arestia` created; migrations applied; `wrangler d1 info` shows `publications`, `import_history`, `audit_log` tables and `live_publications` view
- [ ] R2 bucket `skeptou-arestia` created and bound
- [ ] `GET /api/publications` → `200` empty array; unauthenticated → `401`
- [ ] Test publication manually seeded (wrangler d1 + r2 commands); appears in list and renders in PDF.js without triggering browser download dialog
- [ ] Prior-version dropdown populated from manually seeded `import_history` row; historical snapshot streams via `?version=` param
- [ ] Access gate QA-verified (incognito, phone, desktop)

**Phase 2:**
- [ ] `GET /api/import/energeia-papers` returns energeia paper list (requires energeia API live)
- [ ] `POST /api/publications/import`: imports canonical PDF from energeia; D1 row created with correct `source_version`; R2 canonical written
- [ ] Re-import same paper: prior canonical moved to `history/` R2 prefix; `import_history` has two rows; `publications.source_version` updated
- [ ] `POST /api/publications` (out-of-band): PDF upload creates row with `source_paper_slug = NULL`; renders in viewer
- [ ] `PATCH /api/publications/:slug`: notes + citation_metadata update reflected in citation sidebar
- [ ] Non-session request to any write endpoint → `403`

**Phase 3:**
- [ ] `DELETE /api/publications/:slug` (session only): sets `archived_at`; publication disappears from list; R2 canonical still exists (`wrangler r2 object get` succeeds)
- [ ] `audit_log` shows INSERT (or IMPORT), UPDATE, and DELETE rows with correct actor and snapshots
- [ ] Confirmation modal displays full citation before delete is committed
