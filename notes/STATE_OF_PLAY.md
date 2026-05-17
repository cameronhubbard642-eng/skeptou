# STATE_OF_PLAY — Sképtou

**Authoritative project state. Updated by Lead Dev / Architect after each phase milestone.**  
**Last updated:** 2026-05-17 (specs/phero.md rev 4; brief-phero-phase1.md rev 2; specs/scholia.md rev 1 drafted)

---

## Current phase: Phase 0 — Foundation

Phase 0 is active. Architecture document filed. Awaiting Cam's review and approval before Phase 1 begins.

## What is done

- `CLAUDE.md` authored and placed at project root
- `ARCHITECTURE.md` filed at project root covering all six Phase 0 topics:
  - Monorepo decision (recommendation: monorepo, pending Cam approval)
  - Branch / PR / tag conventions for `energeia` (superseded by `specs/energeia.md` §II — worktree model)
  - Cloudflare Access policy patterns (per-subdomain; Service Tokens for Worker-to-Worker)
  - `graphe` as shared bibliography resource
  - CSS design-token sharing strategy
  - LaTeX → web aesthetic translation
- Directory scaffolding created: `modules/`, `assets/branding/`, `specs/`, `notes/`, `.auto-memory/`
- `specs/phronesis.md` finalized (2026-05-12); all Cam decisions resolved; ready for engineer brief
- `specs/energeia.md` finalized at rev 4 (2026-05-12); mirror-back eliminated; major/minor promotion classifier; working/ auto-commit; all Cam decisions resolved; ready for engineer brief
- `specs/auth-core.md` drafted rev 1 (2026-05-13); email-only (Resend); 30-day sliding / 90-day absolute session; two-deployment model (skeptou + glossolalia); awaiting Cam review
- `specs/apex-site.md` revised to rev 4 (2026-05-14); watermark reinstated; content-slot policy; CV deferred; 3-page v1; awaiting Cam review
- `specs/runtime-fetch-cache.md` rev 1 filed (2026-05-14); **SUPERSEDED** same day — Cam pivoted O&P data to D1; file retained as archive with superseded notice at top
- `specs/op-d1-migration.md` revised to rev 4 (2026-05-15); commitments table added; opportunities recast as decision queue; tasks parent_kind/parent_id polymorphic; accept/reject flows with SAA dispatch; declined_opportunities view; §VIII migration script struck; initial population via O&P specialist API writes; all decisions resolved; engineer-ready
- `specs/strategia.md` rev 2 — ratified Cam 2026-05-15; all open Qs resolved; R2+D1 document viewer for Claude-generated reports; PDF.js in-app viewer; specialist-scoped service tokens; tombstone delete (Cam-session-only); 3-phase plan; 6 open questions for Cam; awaiting Cam review
- `specs/aristeia.md` rev 2 — ratified Cam 2026-05-15; all open Qs resolved; R2+D1 in-perpetuity professional publications archive; energeia pull model; versioned imports (publications + import_history two-table); Cam-only writes; Worker-to-Worker ENERGEIA_SERVICE_TOKEN; soft delete (tombstone; R2 retained); citation metadata; 3-phase plan; 6 open Qs for Cam; awaiting Cam review
- `specs/phero.md` **rev 4** — ratified Cam 2026-05-15; all P-1–P-8 resolved; P-9/P-10 open (low priority); OTP dropped entirely (P-7); single share model (link + 7-day scoped cookie); custom slugs (Cam-set or 22-char random); `label` annotation field; per-link view tracking via `share_views` table (cf_country, user_agent, referrer); 45-day default expiry; 3-phase plan; ready for engineer brief
- `specs/brief-phero-phase1.md` **rev 2** — drafted 2026-05-17; reflects rev 4 schema (share_views, validateCustomSlug, generateRandomSlug); management UI with view-history drill-down; ready for engineer
- `specs/scholia.md` **rev 1** — drafted 2026-05-17; module-agnostic commenting/annotation backend (Slot 16 — σχόλια); D1 single-table schema; 5-endpoint API; Cam management UI; embeddable overlay for all module viewers (Phase 2+); phero recipient identity model; Resend notifications (Phase 3); 4-phase plan; 6 open Qs (SQ-1–SQ-6); awaiting Cam ratification

## What is in progress

- Cam review of `ARCHITECTURE.md`
- Cam review of `specs/auth-core.md` (rev 1)
- Cam review of `specs/apex-site.md` (rev 4)
- Cam review of `specs/strategia.md`, `specs/aristeia.md`, `specs/phero.md` (rev 2 / rev 2 / rev 4 respectively)
- `feat/strategia-spec` branch has feat/strategia-spec: rev 1 merged as PR #52; rev 2 pending push + PR; **push to GitHub pending** (Lead Dev session has no GitHub credentials; needs DevOps session or manual push by Cam — see below)

## What is blocked

- Phase 1 cannot begin until Cam resolves:
  1. Monorepo approval (or override)
  2. GitHub account / repo name for the monorepo
  3. Cloudflare Access identity provider choice (GitHub OAuth vs. Google vs. one-time PIN)
- Phase 2 engineer brief ready to fire; pre-conditions:
  1. Phase 1 complete (Access gate verified on phronesis subdomain)
  2. PM-O&P schema extension (prestige + requirement fields on opp-*.md; backfill 8 existing files; confirm plan-file path + .ics export path) — sub-routing action in specs/phronesis.md §IX
  3. op-d1-migration.md Phase 1 complete before any phronesis content build begins (D1 is now the data layer for phronesis)
- **Combined spec PR (strategia + aristeia + phero):** `feat/strategia-spec` branch has commits for strategia rev 2, aristeia rev 2, phero rev 4, briefs for all three modules, and brief-energeia-content-endpoint.md. To open the PR:
  - Cam runs: `git push origin feat/strategia-spec` from the skeptou repo, then opens PR on GitHub
  - PR title: `docs(strategia,aristeia,phero,scholia): module specs rev 2 + engineer briefs + scholia rev 1`
  - Or route through DevOps session (`local_33cdf795-990d-4872-8cbd-291c09838b35`) which holds GitHub credentials

## What comes next (Phase 1)

1. DevOps: DNS audit of current `skeptou.com` registrar records (document all existing records before any cutover)
2. DevOps: Cloudflare account setup + DNS migration with iCloud MX preservation
3. DevOps: `phronesis.skeptou.com` empty placeholder deploy + Access policy attached
4. QA: Verify Access gating blocks unauthenticated requests from all device/browser combos
5. QA: Verify iCloud email flows post-migration (send + receive from `@skeptou.com`)
6. Dispatch: Fire PM-O&P sub-routing action (opp-*.md schema extension) per `specs/phronesis.md §IX`
7. DevOps: Create `skeptou-op` D1 database; apply migration SQL (op-d1-migration.md §III)

## Standing constraints active

- iCloud MX records (`mx01.mail.icloud.com`, `mx02.mail.icloud.com`) must be preserved through all DNS changes — hard prerequisite, non-negotiable
- Access gate must be verified before any content deploys to any private subdomain
- Dispatch fires Code tasks; management roles produce routing recommendation documents only
- **PR workflow (effective 2026-05-13):** All work merges to `main` via pull request — no direct pushes.
  - `modules/energeia/` and non-apex paths: self-merge after PR review is acceptable.
  - `modules/apex/` and `agora/website/` (public surface): wait for explicit Cam approval before merging — no self-merge.

## Open questions requiring Cam decision

| # | Question | Blocks | Recommendation |
|---|---|---|---|
| 1 | Monorepo approved? | Phase 1 | — |
| 2 | GitHub account / repo name | Phase 1 | — |
| 3 | Cloudflare Access identity provider | Phase 1 | — |
| 4 | iCloud .ics export: filename + vault path | Phase 2 build script | — |
| 5 | Canonical plan-file directory in O&P vault (assumed: projects/) | Phase 2 Worker | — |
| 6 | energeia: bibliography option A (main:vault/ sparse checkout) vs B (energeia branch master.bib) | Phase 4 compile pipeline | — |
| 7 | energeia: Cam's active papers need migrating to agora/papers/ before Phase 4 ships | Phase 4 pre-condition | — |
| 8 | Slot 15 name and function | Phase 5+ | — |
| 9 | Borges public-web licensing | Phase 3 (apex) | — |
| 10 | Parchment contrast adjustment needed? | Phase 3 QA | — |
| 11 | Line-height by medium adjustments | Module specs | — |
| 12 | auth-core: ADMIN_EMAIL for skeptou + glossolalia deployments | auth-core bootstrap | — |
| 13 | auth-core: public email for allowlist seeding | auth-core bootstrap | — |
| 14 | auth-core: PII minimisation preference (audit log plaintext vs SHA-256 prefix) | auth-core audit log | — |
| 15 | auth-core: 90-day absolute session cap acceptable, or longer? | auth-core session design | — |
| 16 | auth-core: Glossolalia current auth mechanism (what is being replaced?) | auth-core §XIII migration | — |
| 17 | apex: AOS/AOC exact phrasing for site-meta.yaml | Phase 3 Home, JSON-LD | — |
| 18 | apex: public contact email address | Phase 3 Home | — |
| 19 | apex: domain framing (thematic skeptou.com vs name-based) — confirm intentional | Phase 3 DNS | — |
| 20 | strategia: **soft vs tombstone delete** — tombstone recommended (D1 row retained, R2 purged immediately); full hard delete (D1 row also purged) also viable | Phase 2 delete handler | Tombstone |
| 21 | strategia: **agora-auto-publish** — webhook Worker auto-uploads `agora/reports/<team>/` commits to strategia; deferred to Phase 3 by default | Phase 3 scope | Defer to Phase 3 |
| 22 | strategia: **`.docx` support** — requires Mammoth.js conversion step to render in-browser; out of scope for v1 | Phase 1 MIME allowlist | Out of scope v1 |
| 23 | strategia: **service token table location** — share phronesis `service_tokens` D1 (add `module` column) vs separate `skeptou-strategia` table | Phase 3 token provisioning | Share phronesis table |
| 24 | strategia: **max upload size** — R2 Workers cap at 100MB; annotated PDFs may approach 50–80MB; is 100MB sufficient? | Phase 2 upload handler | Assume sufficient |
| 25 | strategia: **share links** — time-limited links for external collaborators? Permanently out of scope for strategia; belongs to `phero` | Future | Out of scope |
| — | ~~op-d1: DASHBOARD.md mitigation~~ | **Resolved 2026-05-14 — Option D: drop DASHBOARD.md entirely (accept loss)** | — |
| — | ~~op-d1: Audit dual-write~~ | **Resolved 2026-05-14 — No. D1 `audit_log` + 30-day Time Travel only.** | — |
| — | ~~op-d1: Migration timing~~ | **Resolved 2026-05-14 — Hybrid: verify D1 data, then await explicit Cam confirmation before `git rm`.** | — |
| — | ~~op-d1: Markdown retention~~ | **Resolved 2026-05-14 — Delete (`git rm`). Clean vault.** | — |
| — | ~~op-d1: Write PAT~~ | **Resolved 2026-05-14 — Cam's existing classic PAT. No separate fine-grained PAT.** | — |
| — | ~~op-d1: Service token TTL~~ | **Resolved 2026-05-14 — 90 days.** | — |
| — | ~~op-d1: inventory.md format~~ | **Resolved 2026-05-14 — Empty at present. No migration parser. Table starts empty, populated via API.** | — |
