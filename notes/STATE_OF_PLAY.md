# STATE_OF_PLAY — Sképtou

**Authoritative project state. Updated by Lead Dev / Architect after each phase milestone.**  
**Last updated:** 2026-05-11

---

## Current phase: Phase 0 — Foundation

Phase 0 is active. Architecture document filed. Awaiting Cam's review and approval before Phase 1 begins.

## What is done

- `CLAUDE.md` authored and placed at project root
- `ARCHITECTURE.md` filed at project root covering all six Phase 0 topics:
  - Monorepo decision (recommendation: monorepo, pending Cam approval)
  - Branch / PR / tag conventions for `energeia`
  - Cloudflare Access policy patterns (per-subdomain; Service Tokens for Worker-to-Worker)
  - `graphe` as shared bibliography resource
  - CSS design-token sharing strategy
  - LaTeX → web aesthetic translation
- Directory scaffolding created: `modules/`, `assets/branding/`, `specs/`, `notes/`, `.auto-memory/`

## What is in progress

- Cam review of `ARCHITECTURE.md`
- `specs/phronesis.md` finalized (2026-05-12); all Cam decisions resolved; ready for engineer brief

## What is blocked

- Phase 1 cannot begin until Cam resolves:
  1. Monorepo approval (or override)
  2. GitHub account / repo name for the monorepo
  3. Cloudflare Access identity provider choice (GitHub OAuth vs. Google vs. one-time PIN)
- Phase 2 engineer brief ready to fire; two pre-conditions must clear first:
  1. Phase 1 complete (Access gate verified on phronesis subdomain)
  2. PM-O&P schema extension (prestige + requirement fields on opp-*.md; backfill 8 existing files; confirm plan-file path + .ics export path) — sub-routing action in specs/phronesis.md §IX

## What comes next (Phase 1)

1. DevOps: DNS audit of current `skeptou.com` registrar records (document all existing records before any cutover)
2. DevOps: Cloudflare account setup + DNS migration with iCloud MX preservation
3. DevOps: `phronesis.skeptou.com` empty placeholder deploy + Access policy attached
4. QA: Verify Access gating blocks unauthenticated requests from all device/browser combos
5. QA: Verify iCloud email flows post-migration (send + receive from `@skeptou.com`)
6. Lead Dev: Write `specs/phronesis.md` after Phase 1 infrastructure clears

## Standing constraints active

- iCloud MX records (`mx01.mail.icloud.com`, `mx02.mail.icloud.com`) must be preserved through all DNS changes — hard prerequisite, non-negotiable
- Access gate must be verified before any content deploys to any private subdomain
- Dispatch fires Code tasks; management roles produce routing recommendation documents only

## Open questions requiring Cam decision

| # | Question | Blocks |
|---|---|---|
| 1 | Monorepo approved? | Phase 1 |
| 2 | GitHub account / repo name | Phase 1 |
| 3 | Cloudflare Access identity provider | Phase 1 |
| 4 | iCloud .ics export: filename + vault path | Phase 2 build script |
| 5 | Canonical plan-file directory in O&P vault (assumed: projects/) | Phase 2 Worker |
| 6 | Slot 15 name and function | Phase 5+ |
| 5 | Borges public-web licensing | Phase 3 (apex) |
| 6 | Parchment contrast adjustment needed? | Phase 3 QA |
| 7 | Line-height by medium adjustments | Module specs |
