# specs/scholia.md — Scholia Commenting and Annotation Backend

**Version:** rev 1
**Status:** draft — awaiting Cam ratification
**Author:** Lead Dev / Architect — Sképtou
**Date:** 2026-05-17
**Depends on:** `specs/auth-core.md`, `specs/phero.md`
**Consumers:** DevOps engineer, Scholia engineer, Cam

---

## §I — Purpose + scope

### §I.1 — What scholia is

`scholia.skeptou.com` (Slot 16 — σχόλια, "notes / marginal annotations / scholarly commentary") is the single, module-agnostic commenting and annotation backend for the entire Sképtou system. Every comment, margin note, annotation, and feedback thread across any module is stored here and only here — no module maintains its own comment tables.

Scholia serves two distinct audiences in Phase 2+:

1. **Cam himself** — margin notes on energeia drafts, notes on aristeia publications, commentary on strategia reports. Document-level or positionally anchored. Private by default; never visible to anyone else unless Cam explicitly routes them.
2. **External recipients via phero** — reviewers, editors, colleagues who hold a phero share link and want to leave comments. Self-identified by name + optional email. Subject to Cam's moderation; zero auth-core account required.

In Phase 1, only Cam can comment (via auth-core session). Recipient comments and the embeddable overlay are Phase 2.

### §I.2 — What scholia enables

- **Margin notes on any Sképtou document** — Cam annotates his own papers, publications, and reports within the system. Notes survive document version promotions because they are indexed to `source_ref`, not to a specific document snapshot.
- **Recipient feedback on shared documents** — A search-committee reviewer holding a phero link can leave marginal comments without creating an account. Cam sees all comments in a unified inbox.
- **Threaded discussion** — Comments can be threaded (replies to a specific comment) or top-level on a document.
- **Resolution tracking** — Cam marks comments resolved (e.g., "addressed this in rev 2") and archives them when no longer relevant. Resolved ≠ deleted: the full thread history is preserved.
- **Unified inbox** — `GET /api/scholia/inbox` returns all unresolved non-Cam comments across all modules, newest first. Cam's command center for feedback management.
- **Extensibility** — Any future Sképtou module (paideia, kleos, elenchus) can integrate scholia without schema changes: they pass a new `source_module` value and a `source_ref` slug.

### §I.3 — What scholia is not

- Not a public forum or discussion board. Access to comment on a share requires possession of the phero share link; no public commenting surface.
- Not a full document review system (no diff-based comments, no suggestion-mode, no accept/reject). Comments are annotations only; they do not modify upstream documents.
- Not a storage layer. Comments reference upstream documents by slug; scholia holds no document bytes.
- Not a CMS for Cam's own writing. Cam's notes here are working annotations, not published commentary.

---

## §II — Architecture overview

### §II.1 — Stack

| Layer | Technology |
|---|---|
| Compute | Cloudflare Worker (`scholia-worker`) |
| Database | Cloudflare D1 (`skeptou-scholia`) — single table with JSON-typed position column |
| Notifications | Resend API (Phase 3) — triggered via `ctx.waitUntil()` on `POST /api/scholia/comments` |
| Auth (Cam) | `@skeptou/auth-client` (`requireCamSession()`) |
| Auth (recipients) | Self-declared identity + phero share-scoped cookie forwarded to scholia |
| Auth (cross-module reads) | Service tokens scoped per calling module |
| Management UI | Static HTML at `scholia.skeptou.com/manage` |
| Embeddable overlay | JS module served from `scholia.skeptou.com/overlay.js` (Phase 2) |

### §II.2 — Module position in the Sképtou graph

Scholia is a **leaf-node service consumer** at the annotation layer. It reads nothing from other modules' D1 databases; it receives comment writes from modules (or from the overlay which the modules host) and returns comment reads on demand.

```
energeia ──┐
aristeia ──┼──→ scholia.skeptou.com (comment store + UI)
strategia ──┤
phero ─────┘
```

Data flow per request type:
- **Cam annotates a document**: Cam's viewer page (energeia / aristeia / strategia) posts to `POST /api/scholia/comments` with Cam's auth-core session cookie.
- **Recipient leaves feedback**: Phero viewer overlay posts to `POST /api/scholia/comments` with a phero-session cookie (which scholia validates against phero's share table via Worker-to-Worker service token call) and a self-declared identity.
- **Any viewer loads comments**: `GET /api/scholia/comments?source_module=X&source_ref=Y` — requires either Cam session (returns all comments) or phero-session cookie (returns all comments on that specific share).

### §II.3 — CF Access gate

`scholia.skeptou.com/manage/*` is behind a CF Access policy (standard private-subdomain pattern). The public overlay endpoint (`/overlay.js`) and the read/write comment API are intentionally not behind CF Access: recipient commenters hold no Access credentials. Worker-level auth governs who can read and write what.

---

## §III — Identity model

### §III.1 — Three author kinds

Every comment carries an `author_kind` distinguishing three identity classes:

| `author_kind` | Who | Auth mechanism |
|---|---|---|
| `cam` | Cameron Hubbard | auth-core session cookie (`requireCamSession()`) |
| `recipient` | External party holding a phero share link | phero share-scoped cookie + self-declared name |
| `service_token` | Machine actor (future: another Worker writing on behalf of a module) | Bearer token with scholia-write scope |

Recipient and service_token comments are never allowed on Cam-private documents (energeia / aristeia / strategia). Recipient commenting is only valid in the context of an active phero share (`source_module = 'phero'`).

### §III.2 — Cam (auth-core session)

Cam's comments are attributed automatically via `requireCamSession()`. `author_label` is set to `cam`; `author_email` is Cam's address from auth-core. No UI prompt at comment creation.

### §III.3 — Recipient (phero share–scoped identity)

When a phero recipient's first comment arrives:
1. The overlay prompts "Comment as: ___" and "Email (optional — for replies)".
2. `author_label` is stored as the supplied name (required; blank label rejected).
3. `author_email` is stored if supplied (not required; not verified in Phase 2).
4. A `scholia-identity-<share-slug>` cookie is set by the scholia Worker:
   - Stores an HMAC-signed `{author_label, author_email}` blob
   - `HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` (30 days; refreshed on comment activity)
   - Scoped to `Path=/` on `phero.skeptou.com` — same domain as the share, so no cross-origin cookie issue
5. On subsequent comments from the same recipient, identity is read from the cookie; no re-prompt.

The recipient identity cookie does not confer any access rights beyond commenting on that share. It is a convenience layer, not an auth credential.

**Recipient identity isolation:** Two recipients commenting on different shares with the same self-declared name are always distinct records. Identity is not unified across shares. If Cam wants to link two recipient identities (e.g., "this is the same reviewer"), that is a future manual tagging feature (deferred).

### §III.4 — Service token (future)

`author_kind = 'service_token'` is reserved for machine actors. Schema supports it; no Phase 1 or Phase 2 implementation required. Service tokens will carry a `scholia-write` scope in auth-core's service token table when provisioned.

---

## §IV — Comment model

### §IV.1 — Document-level vs. positional comments

Comments are either:
- **Document-level** (`position = null`) — applies to the document as a whole, not to any specific location. Default for quick comments.
- **Positional** — anchored to a specific location in the document. Format is module-specific (see §IV.2).

The position column is stored as a JSON string. The scholia Worker does not interpret or validate position content beyond ensuring it is valid JSON. Each module's viewer is responsible for rendering position-anchored comments in context.

### §IV.2 — Position JSON schema

| Module | Position format |
|---|---|
| PDF (phero, aristeia, strategia) | `{"type":"pdf","page":<int>,"x":<0–1>,"y":<0–1>}` — normalized page coordinates |
| Markdown (energeia) | `{"type":"md","line":<int>,"char_start":<int>,"char_end":<int>}` — 0-indexed |
| Generic offset | `{"type":"offset","start":<int>,"end":<int>}` — character offset in plaintext |
| Document-level | `null` |

Position format is not validated server-side in Phase 1; the module viewer is responsible for meaningful position use. This keeps scholia module-agnostic.

### §IV.3 — Threading

`parent_comment_id` is nullable. A comment with `parent_comment_id = null` is a root comment on the document. A comment with a non-null `parent_comment_id` is a reply. Threading is single-level in Phase 1 (replies to root comments only; no replies-to-replies). The schema supports arbitrary depth; the management UI and overlay enforce single-level threading in Phase 1.

### §IV.4 — Comment lifecycle

```
OPEN  ──(Cam: mark resolved)──→  RESOLVED  ──(Cam: archive)──→  ARCHIVED
  │                                                                  │
  └──(Cam: archive)──────────────────────────────────────────────────┘
```

- **Open**: default state. Visible in inbox. Recipient can still edit own comment (within 15-minute window — enforced by `created_at + 900s` check).
- **Resolved**: Cam has acted on the comment. No longer appears in inbox by default (filter: `resolved_at IS NULL`). Still visible in per-document comment view with "Resolved" badge.
- **Archived**: Hidden from all views by default. Appears only with explicit `?include_archived=true` filter on GET. Soft delete — row is never removed.

Cam can move a comment from Resolved back to Open (re-open). No state machine enforcement; PATCH sets the timestamp columns directly.

---

## §V — D1 schema

### §V.1 — Migration files

```
modules/scholia/migrations/
  0001_initial_schema.sql
  0002_indexes.sql
```

### §V.2 — `0001_initial_schema.sql`

```sql
-- ============================================================
-- Scholia comment store — skeptou-scholia D1 database
-- Sképtou / specs/scholia.md rev 1
-- ============================================================

CREATE TABLE IF NOT EXISTS scholia_comments (
  comment_id         TEXT    PRIMARY KEY,     -- 22-char base64url CSPRNG (same scheme as phero slugs)
  source_module      TEXT    NOT NULL,        -- 'phero' | 'energeia' | 'aristeia' | 'strategia' | ...
  source_ref         TEXT    NOT NULL,        -- slug / token identifying the upstream item
  parent_comment_id  TEXT    REFERENCES scholia_comments(comment_id),
  author_kind        TEXT    NOT NULL CHECK (author_kind IN ('cam','recipient','service_token')),
  author_label       TEXT    NOT NULL,        -- display name; 'cam' for Cam, self-declared for recipients
  author_email       TEXT,                   -- optional; used for notifications
  position           TEXT    NOT NULL DEFAULT 'null',  -- JSON blob or literal 'null'
  body               TEXT    NOT NULL CHECK (length(body) > 0 AND length(body) <= 10000),
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  edited_at          TEXT,                   -- set on PATCH body update (author-only, within 15 min)
  resolved_at        TEXT,                   -- set by Cam; clears on re-open
  archived_at        TEXT,                   -- soft delete; set by Cam
  metadata           TEXT    NOT NULL DEFAULT '{}'
);
```

### §V.3 — `0002_indexes.sql`

```sql
-- Primary lookup: all comments for a given source item
CREATE INDEX IF NOT EXISTS idx_scholia_source
  ON scholia_comments(source_module, source_ref, created_at DESC);

-- Threading: replies to a given parent
CREATE INDEX IF NOT EXISTS idx_scholia_parent
  ON scholia_comments(parent_comment_id)
  WHERE parent_comment_id IS NOT NULL;

-- Inbox query: unresolved non-Cam comments, newest first
CREATE INDEX IF NOT EXISTS idx_scholia_inbox
  ON scholia_comments(author_kind, resolved_at, archived_at, created_at DESC);

-- Per-module filter
CREATE INDEX IF NOT EXISTS idx_scholia_module
  ON scholia_comments(source_module, created_at DESC);

-- Live view: non-archived comments only
CREATE VIEW IF NOT EXISTS live_comments AS
  SELECT * FROM scholia_comments
  WHERE archived_at IS NULL;
```

---

## §VI — API surface

### §VI.1 — `GET /api/scholia/comments`

Returns comments for a specific source item. Required query params: `source_module`, `source_ref`.

Optional params:
- `include_archived=true` — include archived comments (Cam-only; `author_kind=cam` check)
- `include_resolved=true` — include resolved comments (default: true; resolved comments are visible in per-document view)
- `limit` (default 100, max 500)
- `offset`

Auth:
- Cam session → returns all comments (open + resolved; optionally archived)
- Phero-session cookie for `source_module=phero` with matching `source_ref` → returns all non-archived comments on that share. Validated by Worker-to-Worker call to phero's `GET /api/shares/:slug` (using `PHERO_SERVICE_TOKEN`).
- No auth → `403`. Comments are never publicly readable without either a Cam session or a valid phero share session.

Response:
```json
{
  "source_module": "phero",
  "source_ref": "my-paper-2026",
  "total": 3,
  "comments": [
    {
      "comment_id": "aBcDeFgHiJkLmNoPqRsTuV",
      "parent_comment_id": null,
      "author_kind": "recipient",
      "author_label": "Jane Smith",
      "position": {"type": "pdf", "page": 3, "x": 0.5, "y": 0.72},
      "body": "The argument on p.3 is unclear — what does 'constitutive' mean here?",
      "created_at": "2026-05-17T14:00:00Z",
      "resolved_at": null,
      "replies": [
        {
          "comment_id": "xYzAbCdEfGhIjKlMnOpQrS",
          "parent_comment_id": "aBcDeFgHiJkLmNoPqRsTuV",
          "author_kind": "cam",
          "author_label": "cam",
          "body": "Good catch — will clarify in rev 2.",
          "created_at": "2026-05-17T16:00:00Z",
          "resolved_at": null
        }
      ]
    }
  ]
}
```

Replies are nested in the parent comment object in the response (client-side assembly from `parent_comment_id`).

### §VI.2 — `POST /api/scholia/comments`

Creates a comment. Auth: Cam session or valid phero share session (for recipient comments on phero shares only).

Request body:
```typescript
interface CreateCommentBody {
  source_module:       string;          // 'phero' | 'energeia' | 'aristeia' | 'strategia'
  source_ref:          string;          // slug / token identifying the document
  parent_comment_id?:  string;          // reply to an existing comment; omit for root
  author_label?:       string;          // required for recipients; ignored for Cam (auto-set)
  author_email?:       string;          // optional for recipients
  position?:           object | null;   // see §IV.2; null = document-level
  body:                string;          // 1–10,000 chars
}
```

Auth enforcement:
- If Cam session: `author_kind = 'cam'`, `author_label = 'cam'`, `author_email` from auth-core.
- If phero session cookie: `author_kind = 'recipient'`; `author_label` required; `source_module` must be `'phero'`; `source_ref` must match the share slug in the phero cookie.
- Any other combination: `403`.

Response `201`:
```json
{
  "comment_id": "aBcDeFgHiJkLmNoPqRsTuV",
  "source_module": "phero",
  "source_ref": "my-paper-2026",
  "author_kind": "recipient",
  "author_label": "Jane Smith",
  "created_at": "2026-05-17T14:00:00Z"
}
```

### §VI.3 — `PATCH /api/scholia/comments/:id`

Partial update. Supported fields:

| Field | Who can set | Effect |
|---|---|---|
| `body` | Original author (within 15 min of `created_at`); Cam always | Updates body; sets `edited_at` |
| `resolved_at` | Cam only | Pass ISO string to resolve; pass `null` to re-open |
| `archived_at` | Cam only | Pass ISO string to archive; pass `null` to unarchive |

Returns `200` with updated comment object. Returns `403` if caller lacks permission for the requested field. Returns `409` if body edit is outside 15-minute window and caller is not Cam.

### §VI.4 — `DELETE /api/scholia/comments/:id`

Cam-only. Sets `archived_at = now()` (soft delete). Does not remove the row. Returns `200`.

Note: `DELETE` is an alias for `PATCH { archived_at: <now> }`. It is provided for REST convention; the underlying operation is identical.

### §VI.5 — `GET /api/scholia/inbox`

Cam-only. Returns all unresolved, non-archived comments where `author_kind != 'cam'`, ordered by `created_at DESC`. This is Cam's unified cross-module feedback inbox.

Query params:
- `source_module` (filter by module)
- `since` (ISO date; only comments created after this date)
- `limit` (default 50, max 200)
- `offset`

Response:
```json
{
  "total_unresolved": 7,
  "comments": [
    {
      "comment_id": "...",
      "source_module": "phero",
      "source_ref": "my-paper-2026",
      "author_label": "Jane Smith",
      "body": "The argument on p.3 is unclear...",
      "created_at": "2026-05-17T14:00:00Z",
      "resolved_at": null
    }
  ]
}
```

### §VI.6 — Auth matrix

| Endpoint | Cam session | Phero share session | No auth |
|---|---|---|---|
| `GET /api/scholia/comments` (phero source) | ✓ all | ✓ own share only | ✗ 403 |
| `GET /api/scholia/comments` (other modules) | ✓ | ✗ 403 | ✗ 403 |
| `POST /api/scholia/comments` (phero source) | ✓ | ✓ own share only | ✗ 403 |
| `POST /api/scholia/comments` (other modules) | ✓ | ✗ 403 | ✗ 403 |
| `PATCH /api/scholia/comments/:id` (body) | ✓ always | ✓ own comment, within 15 min | ✗ |
| `PATCH /api/scholia/comments/:id` (resolve/archive) | ✓ | ✗ 403 | ✗ |
| `DELETE /api/scholia/comments/:id` | ✓ | ✗ 403 | ✗ |
| `GET /api/scholia/inbox` | ✓ | ✗ 403 | ✗ |

---

## §VII — Embeddable overlay (Phase 2)

### §VII.1 — Integration approach

Each module viewer page (phero, energeia, aristeia, strategia) embeds a scholia overlay by loading a script from `scholia.skeptou.com`:

```html
<script
  src="https://scholia.skeptou.com/overlay.js"
  data-source-module="phero"
  data-source-ref="my-paper-2026"
  data-role="recipient"
></script>
```

The overlay script (`overlay.js`):
1. Injects a comment panel component into the host page (right-side drawer or floating widget).
2. Makes CORS-authenticated requests to `GET /api/scholia/comments` and `POST /api/scholia/comments` using the cookies already present (auth-core session cookie for Cam; phero share-scoped cookie for recipients).
3. Handles identity prompt for recipients (first-comment "Comment as: ___" modal).
4. Emits `scholia:comment` custom DOM events for position-anchored comments; the host viewer page listens and renders anchor indicators.

No iframe sandboxing is used — the overlay runs in the host page context to enable DOM access for positional anchoring (PDF.js page coordinates, markdown editor line numbers). This means `overlay.js` must be treated as trusted code served from the scholia Worker.

### §VII.2 — CORS configuration

The scholia Worker must allow cross-origin requests from all Sképtou module subdomains:

```typescript
const ALLOWED_ORIGINS = new Set([
  'https://phero.skeptou.com',
  'https://energeia.skeptou.com',
  'https://aristeia.skeptou.com',
  'https://strategia.skeptou.com',
  'https://scholia.skeptou.com',
]);

function corsHeaders(origin: string): HeadersInit {
  if (!ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}
```

Each module viewer page must also include scholia in its `connect-src` CSP directive:

```
Content-Security-Policy: ... connect-src 'self' https://scholia.skeptou.com; ...
```

### §VII.3 — Recipient auth in overlay

When a recipient visits a phero share and the overlay loads:
1. Overlay checks for `scholia-identity-<share-slug>` cookie.
2. If present and valid HMAC: identity is pre-loaded; comment box shows "Commenting as: Jane Smith".
3. If absent or invalid: comment form is shown with `author_label` + `author_email` fields. On first comment submission, scholia sets the identity cookie.

The identity cookie is set by scholia on `phero.skeptou.com` via the `Set-Cookie` header in the `POST /api/scholia/comments` response. Because `phero.skeptou.com` is the request origin (the overlay script runs in that context), the cookie is scoped to that domain.

Phero share validity is verified by scholia on every comment write: scholia calls `GET https://phero.skeptou.com/api/shares/:slug` using `PHERO_SERVICE_TOKEN` to confirm the share is active and not revoked. If the share has expired or been revoked, comment writes return `403` with reason "share no longer active".

---

## §VIII — Notifications to Cam (Phase 3)

### §VIII.1 — Email via Resend

On `POST /api/scholia/comments` where `author_kind != 'cam'`, scholia triggers a notification via `ctx.waitUntil()`:

- **Per-comment mode**: sends one email immediately per new recipient comment.
- **Daily digest mode**: accumulates comments in a `notifications_queue` KV namespace; a scheduled Worker fires once daily and sends a summary.

Mode is a Worker variable (`NOTIFICATION_MODE = 'immediate' | 'digest'`); default is `'immediate'`. Open question SQ-1 covers this choice.

Email template (immediate mode):
```
Subject: New comment on "{source_ref}" (via {source_module})

{author_label} commented on "{source_ref}":
"{body}"

—
View on scholia: https://scholia.skeptou.com/manage?source_ref={source_ref}
```

### §VIII.2 — In-app comment badge

The scholia management UI shows a badge count (`total_unresolved` from `GET /api/scholia/inbox`) at page load. No real-time push in Phase 3; badge updates on page refresh.

Modules that embed the overlay can optionally request a per-share comment count from scholia to display a "3 comments" badge on the phero management UI. This requires a service-token call from phero to `GET /api/scholia/comments?source_module=phero&source_ref=<slug>` and reading `total`.

### §VIII.3 — Notification deduplication

If Cam replies to a comment thread, subsequent replies from the original recipient do not trigger email for 24 hours (cool-down to avoid email ping-pong). Implemented via KV key `notification-cooldown-{comment_id}-{author_email}` with 24-hour TTL.

---

## §IX — Comment management UI

### §IX.1 — Unified inbox (`scholia.skeptou.com/manage`)

Default view: all unresolved non-Cam comments, newest first.

| Column | Source |
|---|---|
| Module | `source_module` badge |
| Document | `source_ref` (links to source document viewer if integrations live) |
| Author | `author_label` + `author_email` (if present) |
| Comment | `body` (truncated 200 chars) |
| Position | `position` (PDF p.3, MD line 42, or "Document-level") |
| Time | `created_at` (relative) |
| Status | Open / Resolved badge |
| Actions | Reply, Mark resolved, Archive |

### §IX.2 — Per-document view

`scholia.skeptou.com/manage?source_module=phero&source_ref=my-paper-2026` shows all comments (open + resolved, excluding archived unless filtered in) for a specific document. Rendered as a threaded list with parent/reply grouping.

### §IX.3 — Filters

Available on both inbox and per-document views:
- `source_module` — filter to a specific module
- Author name / email (substring match)
- Date range (`since` / `until`)
- Status: Open only / Resolved only / All (excluding archived) / All (including archived)

### §IX.4 — Per-comment actions

| Action | Who | Effect |
|---|---|---|
| Reply | Cam | Opens inline reply form; creates comment with `parent_comment_id` |
| Mark resolved | Cam | Sets `resolved_at`; removes from inbox |
| Re-open | Cam | Clears `resolved_at`; returns to inbox |
| Archive | Cam | Soft delete; hides from all views by default |
| Edit | Cam (own comments) | Updates `body` + `edited_at`; no time limit for Cam |

---

## §X — Auth + scopes

### §X.1 — Cam session

`requireCamSession()` from `@skeptou/auth-client`. Same session cookie as all other Sképtou modules. Cam's auth-core actor_id is attached to every Cam comment at creation.

### §X.2 — Recipient session (phero share)

The scholia Worker validates recipient comment writes by:
1. Reading the phero share cookie from the request (`Cookie: phero-session-<slug>=<HMAC>`).
2. Calling `GET https://phero.skeptou.com/api/shares/<slug>` with `Authorization: Bearer <PHERO_SERVICE_TOKEN>` to confirm the share is active.
3. If active: comment write proceeds. If not: `403`.

The phero share cookie is forwarded in the overlay's fetch call via `credentials: 'include'` (CORS must allow credentials — see §VII.2).

### §X.3 — Worker-to-Worker service tokens

Scholia issues read-only service tokens to other modules for comment-count queries:

```sql
-- In auth-core's service_tokens table (see specs/auth-core.md)
INSERT INTO service_tokens (token_id, role_slug, module, scope)
VALUES (
  'ENERGEIA_SCHOLIA_TOKEN', 'energeia-reader', 'energeia',
  '["scholia:read:own"]'
);
```

Scope `scholia:read:own` allows `GET /api/scholia/comments?source_module={own-module}&source_ref=*` only. No inbox access, no cross-module reads.

### §X.4 — wrangler.toml secrets

```
COOKIE_SIGNING_KEY         ← HMAC key for scholia-identity cookies
PHERO_SERVICE_TOKEN        ← calls phero GET /api/shares/:slug for recipient validation
RESEND_API_KEY             ← email notifications (Phase 3)
CAM_NOTIFICATION_EMAIL     ← destination address for comment notifications
```

---

## §XI — Security posture

### §XI.1 — Recipient comment rate limiting

CF Rate Limiting on `POST /api/scholia/comments` for non-Cam callers: 10 comments per share per hour per IP. Returns `429`. Prevents recipient spam; Cam is not rate-limited.

### §XI.2 — Comment body sanitization

Comment body is stored as plaintext. No HTML is accepted or stored. The management UI and overlay must escape HTML when rendering (do not use `innerHTML` on comment bodies; use `textContent` or equivalent). Rich text is out of scope for Phase 1 and Phase 2 (open question SQ-4).

### §XI.3 — CORS lockdown

`Access-Control-Allow-Origin` is restricted to the Sképtou subdomain allowlist (§VII.2). Wildcards are not used. Cross-origin requests from unknown origins receive `403` before auth checks run.

### §XI.4 — Phero share revocation cascade

When a phero share is revoked, recipient comments on that share are not deleted — they remain in scholia's D1. Cam can still read and manage them via `GET /api/scholia/comments?source_module=phero&source_ref=<slug>` from the management UI. The revocation only prevents new writes (phero service token call will return the share as inactive, so new `POST /api/scholia/comments` will be blocked). Existing comments are preserved for Cam's reference.

### §XI.5 — `author_label` length limit

Recipient self-declared names: 1–128 chars. Enforced at API level. Prevents label-stuffing or XSS via author display names.

---

## §XII — Cross-module integration notes

### §XII.1 — Phase 4 integration cascade order

When energeia, aristeia, and strategia integrate scholia overlays (Phase 4), the recommended integration order is:
1. **aristeia** first — published PDFs with margin notes; straightforward PDF position anchoring
2. **strategia** second — report viewer; same PDF position model
3. **energeia** last — draft papers in Obsidian markdown; MD line anchor model is more complex

Each module integration requires:
- `overlay.js` embed in viewer pages
- `connect-src` update in CSP
- Service token provisioned in auth-core (`{module}_SCHOLIA_TOKEN`)
- QA verification: Cam can annotate; comments appear in scholia inbox

### §XII.2 — phero comment count on share management UI

Phero Phase 2+ can show a comment count badge per share in the phero management list. Implementation:

```typescript
// In phero Worker, for GET /api/shares list response
const commentCounts = await fetch(
  `${SCHOLIA_BASE_URL}/api/scholia/comments?source_module=phero&source_ref=${slug}&limit=0`,
  { headers: { 'Authorization': `Bearer ${PHERO_SCHOLIA_TOKEN}` } }
).then(r => r.json()).then(d => d.total);
```

This is a Phase 2+ enhancement; not required for scholia Phase 1.

---

## §XIII — Phasing

### Phase 1 — D1 schema + CRUD + Cam dashboard (Cam comments only)

**Scope:** D1 schema applied. Cam can create, read, update, resolve, and archive comments on any source_module/source_ref pair. Management UI at `scholia.skeptou.com/manage`. No embeddable overlay; no recipient comments; no notifications. Cam-only usage.

**Deliverables:**
- D1 migrations applied; `wrangler d1 info skeptou-scholia` shows 1 table + 1 view
- `POST /api/scholia/comments` — Cam creates comments; `author_kind = 'cam'`; position JSON stored as-is
- `GET /api/scholia/comments?source_module=X&source_ref=Y` — returns comments with nested replies
- `PATCH /api/scholia/comments/:id` — body edit, resolve/re-open, archive
- `DELETE /api/scholia/comments/:id` — soft delete (alias for archive PATCH)
- `GET /api/scholia/inbox` — Cam's unified inbox; unresolved non-Cam comments (empty in Phase 1 since no recipient comments yet; endpoint live for Phase 2 readiness)
- Cam management UI at `/manage`: inbox view, per-document filter, comment list, reply, resolve, archive

**Verification:**
- Cam creates comment on `source_module=aristeia, source_ref=hubbard-2024-grounding, position=null` → appears in `GET /api/scholia/comments`
- Cam creates reply to above comment → reply nested under parent in GET response
- Cam marks comment resolved → disappears from inbox; still visible in per-document view with Resolved badge
- Cam re-opens resolved comment → reappears in inbox
- Cam edits own comment body → `edited_at` set
- Unauthenticated `GET /api/scholia/comments` → `403`

### Phase 2 — Embeddable overlay + phero recipient comments

**Scope:** `overlay.js` deployed. Phero viewer embeds overlay. Recipients can comment on phero shares. Scholia validates recipient identity via phero share cookie. Recipient identity cookie set on first comment.

**Deliverables:**
- `overlay.js` served from `scholia.skeptou.com/overlay.js`
- CORS configuration covering all Sképtou subdomains
- Recipient comment flow: identity prompt, `scholia-identity-<slug>` cookie, repeat-visit identity recall
- Phero viewer page updated to embed overlay
- `POST /api/scholia/comments` for recipients: phero-session validation via Worker-to-Worker call
- Scholia management UI shows recipient comments in inbox

**Pre-condition:** Phero Phase 1 live; `GET /api/shares/:slug` endpoint live on phero Worker.

### Phase 3 — Notifications (Resend email + in-app badge)

**Scope:** Email notification to Cam on new recipient comment. Badge count in management UI.

**Deliverables:**
- `RESEND_API_KEY` provisioned; Resend integration wired to `POST /api/scholia/comments` handler
- `NOTIFICATION_MODE` set per Cam's SQ-1 preference (immediate vs. digest)
- Daily digest: scheduled Worker + `notifications_queue` KV namespace (if digest mode)
- Management UI: `total_unresolved` badge count at load time

### Phase 4 — energeia / aristeia / strategia integration cascade

**Scope:** Overlay embedded in all remaining module viewers. Cam can annotate his own documents across all modules. Position anchoring tested per module.

**Deliverables (per module):**
- Overlay embed in viewer pages
- CSP `connect-src` update
- Service token provisioned + `scholia:read:own` scope
- QA: Cam annotation creates comment in inbox; position anchor renders in viewer

---

## §XIV — Open questions for Cam

| # | Question | Blocks | Recommendation |
|---|---|---|---|
| SQ-1 | **Notification cadence:** per-comment email immediately, or daily digest? | Phase 3 | Immediate is simpler; daily digest reduces noise if shares get active. Recommend immediate for Phase 3, revisit if noisy. |
| SQ-2 | **Attached files in comments:** can recipients (or Cam) attach an image or PDF annotation alongside comment text? Requires scholia R2 bucket. | Schema (adds `attachment_r2_key` column) | Out of scope Phase 1–3; defer to Phase 4+ if ever needed. Recommend plain text only. |
| SQ-3 | **Recipient identity across multiple shares:** if the same person (same email) comments on two different phero shares, treat them as one identity or always distinct? | Phase 2 UX | Distinct by default; no cross-share identity linking. Simpler. |
| SQ-4 | **Rich text vs. plain text comment body:** allow markdown formatting (bold, italic, links) in comment bodies, or plain text only? | Rendering approach | Recommend plain text in Phase 1–2. Markdown opt-in is a Phase 3+ addition. |
| SQ-5 | **Voice-note comments:** audio file attached via R2, for richer feedback on papers? | Schema + R2 bucket | Interesting but niche; recommend permanently deferred unless Cam identifies a specific workflow where it's needed. |
| SQ-6 | **Reaction-only responses:** lightweight "+1 / 👍 / ❓" reactions without a text body, for recipient acknowledgment of Cam's replies? | Schema (adds `reactions` JSON column to `scholia_comments`, or separate `reactions` table) | Defer to Phase 3+; Phase 1 comment CRUD is sufficient. |

---

## §XV — Out of scope

- Storage of document bytes or attachments (Phase 1–3; see SQ-2 and SQ-5)
- Real-time comment push notifications (WebSocket / SSE); management UI refreshes on load
- Public or discoverable comment feeds — all comment reads require either Cam session or valid phero share session
- Version-aware comment migration (if a document is promoted to a new version in energeia, position anchors referencing the old version may no longer be valid — scholia stores what was submitted and does not auto-migrate positions)
- Comment moderation by anyone other than Cam (no recipient self-delete after 15-minute window)
- Integration with any external commenting system (Disqus, Hypothesis, etc.)
- Comment export or backup in Phase 1–3 (D1 data can be exported via `wrangler d1 export` as a manual operation)

---

## §XVI — Definition of done

**Phase 1:**
- [ ] D1 `skeptou-scholia` created; migrations applied; `live_comments` view verified
- [ ] `POST /api/scholia/comments` with Cam session creates comment; `author_kind = 'cam'` enforced
- [ ] `POST /api/scholia/comments` without Cam session → `403`
- [ ] `GET /api/scholia/comments?source_module=aristeia&source_ref=test-slug` → returns comment with nested replies
- [ ] `PATCH /api/scholia/comments/:id` — resolve sets `resolved_at`; re-open clears it
- [ ] `PATCH /api/scholia/comments/:id` — body edit sets `edited_at`; 15-minute window enforced for non-Cam
- [ ] `DELETE /api/scholia/comments/:id` — sets `archived_at`; comment excluded from subsequent GET
- [ ] `GET /api/scholia/inbox` — returns empty list (no recipient comments yet); `total_unresolved = 0`
- [ ] Management UI inbox view loads; per-document filter works; resolve + archive actions work
- [ ] CF Access gate on `/manage/*` verified by QA

**Phase 2:**
- [ ] `overlay.js` served from `scholia.skeptou.com`; loads in phero viewer without console errors
- [ ] CORS headers present for phero.skeptou.com origin; `Access-Control-Allow-Credentials: true`
- [ ] Recipient visits phero share → comment box shown → "Comment as: ___" prompt on first submit
- [ ] `scholia-identity-<slug>` cookie set after first recipient comment; identity recalled on reload
- [ ] Recipient comment write validates phero share is active (Worker-to-Worker call to phero)
- [ ] Revoked phero share → recipient `POST /api/scholia/comments` → `403`
- [ ] Recipient comment appears in `GET /api/scholia/inbox` for Cam
- [ ] Rate limit: 11th recipient comment in 1 hour from same IP → `429`

**Phase 3:**
- [ ] New recipient comment → Cam receives Resend email within 60 seconds (immediate mode)
- [ ] Management UI shows `total_unresolved` badge count
