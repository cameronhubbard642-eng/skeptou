# specs/brief-scholia-phase1.md — Scholia Engineer Brief, Phase 1

**Version:** rev 1
**Status:** ready for implementation
**Author:** Lead Dev / Architect — Sképtou
**Date:** 2026-05-17
**Spec:** `specs/scholia.md` rev 2
**Phase:** 1 of 4
**Tier:** Sonnet

---

## Mission

Build `scholia.skeptou.com` Phase 1: D1 schema (comments + reactions + attachment metadata), R2 bucket, comment CRUD endpoints (Cam-only), reactions (Cam-only), file attachment upload/serve, Markdown rendering pipeline, and Cam management UI. Single user (Cam). No embeddable overlay, no recipient comments, no notifications — those are Phase 2+.

---

## Pre-conditions

None. Phase 1 has no upstream dependencies. All content targets (`source_module` / `source_ref` pairs) are written as opaque strings — the Worker does not validate whether the upstream document exists. Phase 1 can ship before energeia/aristeia/strategia/phero.

---

## Deliverables

1. D1 database `skeptou-scholia` created; 3 migrations applied
2. R2 bucket `skeptou-scholia-attachments` created
3. KV namespaces `NOTIFICATIONS_QUEUE` + `NOTIFICATION_PREFS` created (live for Phase 3; used here only for the scheduled attachment-purge Worker)
4. Worker: all comment endpoints (POST/GET/PATCH/DELETE)
5. Worker: attachment upload + serve endpoints
6. Worker: reaction POST + DELETE endpoints
7. Scheduled Worker: purge unlinked R2 attachments (24h TTL)
8. Cam management UI at `/manage`: inbox, per-document view, Markdown rendering, reactions, attachments, cam_label edit, resolve/archive/reply

---

## Repo layout

```
modules/scholia/
  wrangler.toml
  package.json
  src/
    index.ts
    handlers/
      comments.ts      ← POST/GET/PATCH/DELETE /api/scholia/comments
      attachments.ts   ← POST/GET /api/scholia/attachments
      reactions.ts     ← POST/DELETE /api/scholia/comments/:id/reactions
      inbox.ts         ← GET /api/scholia/inbox
      auth.ts
    lib/
      id.ts            ← generateCommentId() — same 22-char base64url as phero slugs
      markdown.ts      ← server note: rendering is client-side; this validates body length only
    types.ts
    scheduled.ts       ← purge unlinked attachments
  migrations/
    0001_initial_schema.sql
    0002_indexes.sql
    0003_reactions.sql
  public/
    index.html         ← redirect to /manage
    manage/
      index.html       ← management UI (inbox + per-doc view)
      settings.html    ← notification preferences (Phase 3 toggle UI; present but no-op Phase 1)
    assets/
      manage.js        ← marked.js + DOMPurify + management UI logic
      manage.css
```

---

## D1 schema — `0001_initial_schema.sql`

```sql
-- ============================================================
-- Scholia comment store — skeptou-scholia D1
-- specs/scholia.md rev 2
-- ============================================================

CREATE TABLE IF NOT EXISTS scholia_comments (
  comment_id         TEXT    PRIMARY KEY,
  source_module      TEXT    NOT NULL,
  source_ref         TEXT    NOT NULL,
  parent_comment_id  TEXT    REFERENCES scholia_comments(comment_id),
  author_kind        TEXT    NOT NULL CHECK (author_kind IN ('cam','recipient','service_token')),
  author_label       TEXT    NOT NULL,
  cam_label          TEXT,
  author_email       TEXT,
  position           TEXT    NOT NULL DEFAULT 'null',
  body               TEXT    NOT NULL CHECK (length(body) > 0 AND length(body) <= 10000),
  attachment_r2_key  TEXT,
  attachment_filename TEXT,
  attachment_mime    TEXT,
  attachment_size    INTEGER,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  edited_at          TEXT,
  resolved_at        TEXT,
  archived_at        TEXT,
  metadata           TEXT    NOT NULL DEFAULT '{}'
);
```

## D1 schema — `0002_indexes.sql`

```sql
CREATE INDEX IF NOT EXISTS idx_scholia_source
  ON scholia_comments(source_module, source_ref, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_scholia_parent
  ON scholia_comments(parent_comment_id)
  WHERE parent_comment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scholia_inbox
  ON scholia_comments(author_kind, resolved_at, archived_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_scholia_module
  ON scholia_comments(source_module, created_at DESC);

CREATE VIEW IF NOT EXISTS live_comments AS
  SELECT * FROM scholia_comments WHERE archived_at IS NULL;
```

## D1 schema — `0003_reactions.sql`

```sql
CREATE TABLE IF NOT EXISTS scholia_reactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id   TEXT    NOT NULL REFERENCES scholia_comments(comment_id),
  author_kind  TEXT    NOT NULL CHECK (author_kind IN ('cam','recipient','service_token')),
  author_label TEXT    NOT NULL,
  reaction     TEXT    NOT NULL CHECK (reaction IN ('+1','-1','?','!')),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (comment_id, author_kind, author_label, reaction)
);

CREATE INDEX IF NOT EXISTS idx_reactions_comment
  ON scholia_reactions(comment_id);
```

---

## wrangler.toml

```toml
name = "scholia-worker"
main = "src/index.ts"
compatibility_date = "2025-01-01"
pages_build_output_dir = "public"

[[d1_databases]]
binding = "SCHOLIA_DB"
database_name = "skeptou-scholia"
database_id = "FILL_AFTER_CREATE"

[[r2_buckets]]
binding = "SCHOLIA_ATTACHMENTS"
bucket_name = "skeptou-scholia-attachments"

[[kv_namespaces]]
binding = "NOTIFICATIONS_QUEUE"
id = "FILL_AFTER_CREATE"

[[kv_namespaces]]
binding = "NOTIFICATION_PREFS"
id = "FILL_AFTER_CREATE"

[triggers]
crons = ["0 16 * * *"]   # 8am America/Los_Angeles = 16:00 UTC; attachment purge + future digest

[vars]
MAX_ATTACHMENT_BYTES = "20971520"   # 20 MB

# Secrets (wrangler secret put):
# COOKIE_SIGNING_KEY       ← HMAC key for scholia-identity cookies (Phase 2)
# PHERO_SERVICE_TOKEN      ← phero share validation (Phase 2)
# RESEND_API_KEY           ← email notifications (Phase 3)
# CAM_NOTIFICATION_EMAIL   ← destination for notifications (Phase 3)
```

---

## ID generation

```typescript
// src/lib/id.ts
export function generateCommentId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
```

---

## Handler: `POST /api/scholia/comments` (Cam session only)

```typescript
interface CreateCommentBody {
  source_module:       string;
  source_ref:          string;
  parent_comment_id?:  string;
  position?:           object | null;   // stored as JSON string
  body:                string;          // Markdown source; 1–10,000 chars
  attachment_key?:     string;          // from prior POST /api/scholia/attachments
}
```

Logic:
1. `requireCamSession()` — 403 if absent.
2. Validate body length (1–10,000).
3. If `attachment_key` provided: verify the R2 object exists; read its metadata from a staging KV key `attachment-staged:<key>` (set during upload, deleted here). If not found in staging → `400 attachment_key not found or already used`.
4. If `parent_comment_id` provided: verify parent exists in `scholia_comments` and shares the same `source_module` / `source_ref`. Reject cross-document replies.
5. Insert row; set `author_kind = 'cam'`, `author_label = 'cam'`.
6. If `attachment_key` provided: delete the `attachment-staged:<key>` KV entry (marks it as claimed).

Response `201`:
```json
{
  "comment_id": "aBcDeFgHiJkLmNoPqRsTuV",
  "source_module": "aristeia",
  "source_ref": "hubbard-2024-grounding",
  "author_kind": "cam",
  "created_at": "2026-05-17T14:00:00Z"
}
```

---

## Handler: `GET /api/scholia/comments` (Cam session only)

Required params: `source_module`, `source_ref`.
Optional: `include_archived` (default false), `limit` (default 100, max 500), `offset`.

Query:
```sql
SELECT c.*,
  (SELECT json_group_object(r.reaction, json_object(
      'count', COUNT(*),
      'viewer_reacted', MAX(CASE WHEN r.author_kind='cam' AND r.author_label='cam' THEN 1 ELSE 0 END)
    )) FROM scholia_reactions r WHERE r.comment_id = c.comment_id GROUP BY r.reaction
  ) as reactions_json
FROM live_comments c
WHERE c.source_module = ? AND c.source_ref = ?
  AND (? OR c.archived_at IS NULL)
ORDER BY c.created_at ASC
LIMIT ? OFFSET ?
```

Post-process in Worker: assemble nested reply structure (group by `parent_comment_id`), parse `reactions_json` into the `reactions` object shape (`{"+1": {"count": 2, "viewer_reacted": true}, ...}`), fill missing reaction types with `{count: 0, viewer_reacted: false}`.

---

## Handler: `PATCH /api/scholia/comments/:id` (Cam session only)

Accepted fields:
- `body` — updates body + sets `edited_at = now()`. No time limit for Cam.
- `cam_label` — sets or clears Cam's author annotation. Pass `null` to clear.
- `resolved_at` — pass ISO string to resolve; pass `null` to re-open.
- `archived_at` — pass ISO string to archive; pass `null` to unarchive.

Validates that the comment exists. Returns `200` with updated row.

---

## Handler: `DELETE /api/scholia/comments/:id` (Cam session only)

Alias for `PATCH { archived_at: now() }`. Returns `200`.

---

## Handler: `GET /api/scholia/inbox` (Cam session only)

```sql
SELECT * FROM live_comments
WHERE author_kind != 'cam'
  AND resolved_at IS NULL
ORDER BY created_at DESC
LIMIT ? OFFSET ?
```

Returns `{ total_unresolved: <count>, comments: [...] }`. In Phase 1 this always returns an empty list; endpoint is live for Phase 2 readiness.

---

## Attachment upload: `POST /api/scholia/attachments` (Cam session only)

1. Read request body as `ArrayBuffer` (streams into Worker memory — 20 MB limit enforced).
2. Check `Content-Type` header against allowlist: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `application/pdf`, `text/plain`. If not in list → `400 unsupported mime type`.
3. Check content length ≤ 20 MB (20,971,520 bytes) → `413` if over.
4. Generate R2 key: `scholia/cam/${year}/${month}/${generateCommentId()}.${ext}` where `ext` is derived from MIME.
5. Put into R2 with `customMetadata: { filename, mime, size, uploaded_at }`.
6. Write staging KV entry: `attachment-staged:<key> → { filename, mime, size }` with TTL 86400 (24h).

Response `201`:
```json
{
  "attachment_key": "scholia/cam/2026/05/aBcDeFgHiJkLmNoPqRsTuV.pdf",
  "attachment_filename": "draft-comments.pdf",
  "attachment_mime": "application/pdf",
  "attachment_size": 1048576
}
```

---

## Attachment serve: `GET /api/scholia/attachments/:key` (Cam session only)

1. `requireCamSession()` — 403 if absent.
2. Look up R2 object by key; 404 if not found.
3. Return `R2Object.body` stream with:
   - `Content-Type`: from R2 customMetadata mime
   - `Content-Disposition: attachment; filename="<filename>"`
   - `Cache-Control: private, max-age=3600`

---

## Reaction endpoints

**`POST /api/scholia/comments/:id/reactions`** (Cam session only in Phase 1)

```typescript
{ reaction: '+1' | '-1' | '?' | '!' }
```

Insert into `scholia_reactions`. On UNIQUE constraint violation → `409 already reacted`. Returns `201`.

**`DELETE /api/scholia/comments/:id/reactions/:type`** (Cam session only in Phase 1)

Delete from `scholia_reactions WHERE comment_id=? AND author_kind='cam' AND author_label='cam' AND reaction=?`. If 0 rows deleted → `404`. Returns `200`.

---

## Scheduled Worker: attachment purge

Runs on the cron trigger (`0 16 * * *`). Scans `NOTIFICATIONS_QUEUE` KV for staging keys matching `attachment-staged:*`. For each key older than 24h, checks if the R2 key is referenced in `scholia_comments.attachment_r2_key`. If not referenced → delete from R2 and from KV.

```typescript
// src/scheduled.ts
export async function handleScheduled(env: Env): Promise<void> {
  const list = await env.NOTIFICATION_PREFS.list({ prefix: 'attachment-staged:' });
  for (const key of list.keys) {
    const val = await env.NOTIFICATION_PREFS.getWithMetadata(key.name);
    if (!val.value) continue;
    const r2Key = key.name.replace('attachment-staged:', '');
    const referenced = await env.SCHOLIA_DB
      .prepare('SELECT 1 FROM scholia_comments WHERE attachment_r2_key = ? LIMIT 1')
      .bind(r2Key).first();
    if (!referenced) {
      await env.SCHOLIA_ATTACHMENTS.delete(r2Key);
      await env.NOTIFICATION_PREFS.delete(key.name);
    }
  }
}
```

Note: staging keys are stored in `NOTIFICATION_PREFS` KV for simplicity (avoids a fourth KV namespace). They use the `attachment-staged:` prefix to distinguish from notification preference keys.

---

## Management UI

**`/manage` — unified inbox + per-document view**

Single-page HTML + JS. No framework required.

- **Inbox tab**: loads `GET /api/scholia/inbox`; empty in Phase 1 but renders correctly.
- **Per-document view**: filter form for `source_module` + `source_ref`; loads `GET /api/scholia/comments?...`; renders comment tree.
- **Comment rendering**:
  - Body: `DOMPurify.sanitize(marked.parse(comment.body))` injected via `innerHTML`.
  - Load marked.js + DOMPurify from CDN: `https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.6/marked.min.js` and `https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.6/purify.min.js`
  - DOMPurify config: `{ ALLOWED_TAGS: ['p','strong','em','a','code','pre','ul','ol','li','blockquote','br','h1','h2','h3'], ALLOWED_ATTR: ['href'] }`
- **Reactions bar**: 👍{n} 👎{n} ❓{n} 🚩{n} — click to toggle (POST or DELETE accordingly); `viewer_reacted` reflected as active state.
- **Attachment**: if comment has `attachment_r2_key`, show `📎 {filename}` link pointing to `GET /api/scholia/attachments/:key`.
- **cam_label edit**: inline edit field per comment; PATCH on submit; updates displayed author name without page reload.
- **Resolve / archive**: buttons trigger PATCH; comment moves out of active list; no page reload.
- **Reply form**: inline form; POST creates child comment with `parent_comment_id`.
- **Create comment form** (`/manage/new`): fields: `source_module`, `source_ref`, `position` (optional JSON), `body` (textarea with live Markdown preview), `attachment` (file input → upload first, then attach key).

---

## CF Access gate

`scholia.skeptou.com/manage/*` and `scholia.skeptou.com/api/scholia/*` behind CF Access policy (Cam's identity). Public paths (`/overlay.js`, future) bypass Access in Phase 2+; nothing public in Phase 1.

Worker's `requireCamSession()` provides defence-in-depth on top of Access.

---

## Wrangler setup commands

```bash
wrangler d1 create skeptou-scholia
# Paste database_id into wrangler.toml

wrangler d1 migrations apply skeptou-scholia --remote

# Verify
wrangler d1 info skeptou-scholia
# Expect: scholia_comments, scholia_reactions, live_comments

wrangler r2 bucket create skeptou-scholia-attachments
wrangler kv:namespace create notifications-queue
wrangler kv:namespace create notification-prefs
# Paste IDs into wrangler.toml

# Secrets
echo "<signing-key>" | wrangler secret put COOKIE_SIGNING_KEY
# RESEND_API_KEY + CAM_NOTIFICATION_EMAIL needed in Phase 3 only; skip for Phase 1
```

---

## Phase 1 definition of done

- [ ] `wrangler d1 info skeptou-scholia` shows `scholia_comments`, `scholia_reactions`, `live_comments`
- [ ] `POST /api/scholia/comments` (Cam session) → `201`; row in D1 with `author_kind='cam'`
- [ ] `POST /api/scholia/comments` (no session) → `403`
- [ ] `GET /api/scholia/comments?source_module=aristeia&source_ref=test` → comment with `reactions: {"+1": {count:0, viewer_reacted:false}, ...}`
- [ ] Markdown body `**bold**` → management UI renders `<strong>bold</strong>` (not raw asterisks); no `<script>` tags survive DOMPurify
- [ ] Nested reply: comment A → reply B with `parent_comment_id = A` → GET nests B under A
- [ ] `PATCH /:id` with `cam_label = "Smith"` → management UI shows "Smith" in author column
- [ ] `PATCH /:id` resolve → `resolved_at` set; subsequent `GET /inbox` count unchanged (was 0)
- [ ] `POST /api/scholia/attachments` with valid PDF ≤ 20MB → `201` with `attachment_key`
- [ ] `POST /api/scholia/attachments` > 20MB → `413`
- [ ] `POST /api/scholia/attachments` with `text/html` → `400 unsupported mime type`
- [ ] `POST /api/scholia/comments` with `attachment_key` → comment row has `attachment_r2_key` set; `GET` includes attachment metadata
- [ ] `GET /api/scholia/attachments/:key` (Cam session) → streams file with correct Content-Type
- [ ] Unlinked attachment after 24h (scheduled Worker runs): R2 object deleted; staging KV entry deleted
- [ ] `POST /:id/reactions` `+1` → `201`; `GET` shows `viewer_reacted: true, count: 1`
- [ ] `POST /:id/reactions` `+1` again → `409`
- [ ] `DELETE /:id/reactions/+1` → `200`; `GET` shows `viewer_reacted: false, count: 0`
- [ ] `GET /api/scholia/inbox` → `{ total_unresolved: 0, comments: [] }`
- [ ] Management UI loads without JS errors; comment tree renders; all actions work end-to-end
- [ ] CF Access gate on `/manage/*` verified by QA (incognito + mobile)

---

## Out of scope (Phase 1)

- Embeddable overlay (`overlay.js`) — Phase 2
- Recipient comments (phero share session auth) — Phase 2
- cam_label in overlay context — Phase 2
- Resend email notifications — Phase 3
- Daily digest scheduled Worker — Phase 3
- Notification preference toggle (UI present but no-op) — Phase 3
- energeia / aristeia / strategia viewer integrations — Phase 4
