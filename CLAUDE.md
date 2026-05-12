# CLAUDE.md — Sképtou

Personal-domain infrastructure for `skeptou.com` and a constellation of private Greek-labeled subdomains.

## Project metadata

- **Canonical name:** Sképtou (σκέπτου)
- **Type:** Convergent (dev project producing working code + deployed infrastructure)
- **Domain:** `skeptou.com`
- **Cowork space:** Sképtou
- **Auto-memory source of truth:** `.auto-memory/project_personal_domain_infrastructure_plan.md` at the Cowork-host level (always read this first)
- **Mission:** Build out a personal-infrastructure hub at `skeptou.com` — a public personal website at the apex + private Cloudflare-Access-gated subdomains hosting Cam's dashboard, papers, professional materials, teaching materials, scheduler, integrations with Claude team outputs, and other personal services.

## Architecture

Multi-subdomain personal-site on Cloudflare Pages + Workers. Each module → distinct subdomain. Public apex is the only public-facing element; everything else is Cloudflare Access–gated.

Stack:

- **Cloudflare Pages** — static-site hosting per subdomain (free tier)
- **Cloudflare Workers** — dynamic modules (scheduler, inbox, surveys, LLM proxy, email integration)
- **Cloudflare Access** — auth gating per subdomain
- **Cloudflare Tunnel** — for `logos.skeptou.com` (LLM-on-desktop proxy)
- **GitHub** — private repo(s) for module source; GitHub Actions for build pipelines
- **Quartz** — static-site generator from Obsidian vault content (powers modules with prose / markdown content)

## Module roster (Greek-labeled)

| Slot | Subdomain | Function | Tech tier |
|---|---|---|---|
| 0 | `skeptou.com` (apex) | Public personal website | Static |
| 1 | `phronesis.skeptou.com` | Dashboard / planning **(FOUNDATION)** | Quartz from O&P vault |
| 2 | `energeia.skeptou.com` | Papers / writing pipeline | Quartz nav + GitHub Action LaTeX compile |
| 3 | `phero.skeptou.com` | Document share | Static + Access |
| 4 | `paideia.skeptou.com` | Teaching materials | Quartz |
| 5 | `aristeia.skeptou.com` | Professional documents | Quartz + PDF artifacts |
| 6 | `kairos.skeptou.com` | Scheduler | Workers + KV |
| 7 | `katharsis.skeptou.com` | Docclean (future) | TBD |
| 8 | `strategia.skeptou.com` | Reports | Quartz nav + linked PDFs |
| 9 | `graphe.skeptou.com` | Bibliography sync | GitHub Action + Workers query |
| 10 | `phobos.skeptou.com` | CoC portal | Quartz + Workers/KV |
| 11 | `epistole.skeptou.com` | Quick-capture inbox | Workers + GitHub API |
| 12 | `elenchus.skeptou.com` | Survey module | Workers + KV |
| 13 | `angelos.skeptou.com` | Email integration | Workers (IMAP-direct) |
| 14 | `logos.skeptou.com` | Local LLM frontend | Workers + Cloudflare Tunnel |
| 15 | *(unnamed, deferred)* | Applications | — |
| 16 | `scholia.skeptou.com` | Feedback | Workers + KV |
| 17 | `thesauros.skeptou.com` | Archive | Static |
| 18 | `kleos.skeptou.com` | Hall of Fame | Static |

**High-priority modules** (architecture locked down now; everything else stays open until later):

- Slot 1 — `phronesis.skeptou.com` (dashboard / planning, FOUNDATION)
- Slot 2 — `energeia.skeptou.com` (papers / writing pipeline)

Other modules are sketched, not specified. Cam returns to specify when ready.

## Team roster

| Role | Session ID | Tier | Function |
|---|---|---|---|
| Lead Dev / Architect — Sképtou | `local_4b9fdaa7-0637-43da-8875-616dac6a0504` | Sonnet | Architecture, spec writing, PR review, design consulting |
| DevOps / Deploy — Sképtou | `local_33cdf795-990d-4872-8cbd-291c09838b35` | Sonnet | Cloudflare infra, DNS, Access, GitHub Actions, deploy pipelines |
| Quality Assurance — Sképtou | `local_5e3213ed-3ad0-42a4-b7a8-b1096ad4cf85` | Sonnet | End-to-end verification, Access-gating gate, mobile-PWA, security audit |

Three Sonnet management roles. Code tasks carry the implementation work; Dispatch fires them per the standing rule (`feedback_team_coordinator_no_downstream_dispatch.md`).

## Aesthetic foundation

Derived from Cam's `ucr-borges` LaTeX style package. Bedrock for `skeptou.com` and every child subdomain.

**Color palette:**

| Name | Hex | Use |
|---|---|---|
| Parchment | `#fcf5e5` | Background |
| Purple | `#301934` | **Body text** (NOT pure black; Cam: "Designed to be dark enough to read well — like black from a distance — but more aesthetically interesting.") |
| Mauve | `#915f6d` | Section headers, dividers, rules |
| Wine | `#722f37` | Emphasis, keyterms |
| Quartz | `#51414f` | Secondary text |
| Coral | `#f08080` | Warm accent (sparing) |
| Light Steel | `#b0c4de` | Cool accent |
| Steel | `#4682b4` | Cool accent (stronger) |

**Typography:**

- **Private subdomains:** Borges font family (Cam-verified license for Access-gated subdomains). Faces: Borges-Gris (regular/light), Borges-GrisItalic, Borges-Negra (bold), Borges-NegraItalic, Borges-Blanca (extra light), Borges-BlancaItalic, Borges-SuperNegra (extra bold), Borges-TituloBlanca, Borges-TituloHueca (outline), Borges-Poema (slanted display).
- **Public apex (`skeptou.com`):** Cormorant (Google Fonts) as placeholder until Borges public-web licensing is revisited.
- **Display / ornamental:** Cinzel (Google Fonts).
- **Default treatment:** Borges-Gris light upright on Access-gated subdomains; Cormorant regular on public apex. Line-height 1.5 (onehalfspacing). Body text in Purple, always.

**Visual principles:**

- Small caps for section headers, author names, structural labels
- Mauve hairline rules (~0.6pt) as section dividers
- `§Roman` section numbering style (e.g., `§I`, `§II`)
- Generous whitespace; 18–30pt section margins
- Color hierarchy: Purple primary, Mauve secondary/headers, Wine emphasis
- Subtle background watermarks (3–5% opacity); **NO LOGOS** (UCR.png + IMG_4719.jpeg excluded by default) unless Cam specifically requests
- Thin borders only (no heavy borders)

**Document-type templates** (LaTeX side, for `aristeia` to mirror on web):
- Article title block
- Handout title block
- Abstract title block
- CV templates
- Letterhead + envelope

## Security posture (PRIORITY)

**Cloudflare Access gating must be VERIFIED before any personal info content is deployed.** Personal info (calendar, project state, professional materials, committee notes) hits `phronesis.skeptou.com` first; Access must lock down before any real content lands.

Pattern per new subdomain:
1. DevOps deploys empty Access-gated placeholder ("Coming soon")
2. QA verifies gating blocks unauthenticated access from multiple devices (desktop browser, phone browser, incognito, fresh session)
3. Only after QA clears: real content deploys

This gate is non-negotiable.

## Existing infrastructure to PRESERVE

`skeptou.com` already has **iCloud custom-domain email** configured. Cam's iCloud mailbox uses `@skeptou.com` addresses. When migrating DNS to Cloudflare:

- **iCloud MX records must be preserved:** `mx01.mail.icloud.com`, `mx02.mail.icloud.com`
- **SPF record preserved:** `v=spf1 include:icloud.com ~all`
- **DKIM + DMARC records preserved** as configured
- DevOps audits existing DNS before any cutover; QA verifies email still flows post-migration (send + receive test)

Email service cannot break during infrastructure rollout. Hard prerequisite.

## Standing constraints (inherited from Cam-architecture)

- **`dispatch-briefing` skill loaded every substantive turn** (`feedback_dispatch_briefing_always_load.md`)
- **Dispatch is thin pass-through in the middle** (`feedback_dispatch_thin_passthrough.md`) — surfaces only at briefing, final round-up, genuine blockers
- **PM roles redefined to routing/compiling/synthesizing/consulting** (`feedback_deprecate_pm_coordinator_role.md`) — they don't fire downstream sessions; Dispatch does
- **Coordinator-doesn't-dispatch architectural constraint** (`feedback_team_coordinator_no_downstream_dispatch.md`)
- **NotebookLM-first for research tasks** (`feedback_notebooklm_first_for_search.md`)
- **Model-tier discipline** — Sonnet for management sessions + most Code tasks; Opus reserved for substantive judgment work (`feedback_efficient_model_choice.md` + `code-task-model-selection` skill)
- **`[TRACE ON]` prefix vocabulary** when active: `{Dispatch → ROLE}` / `{Dispatch → ROLE_A + ROLE_B}` / `{Dispatch ↻ ROLE}` / `{Dispatch}` / `{Dispatch → Code}` / `{Dispatch ⤆ from ROLE}`

## Filing conventions

- **Architecture documents:** `ARCHITECTURE.md` at project root (Lead Dev owns)
- **Module specs:** `specs/<module-name>.md` (Lead Dev writes; engineer Code tasks consume)
- **Status:** `notes/STATE_OF_PLAY.md` (Lead Dev maintains; authoritative truth-of-the-project)
- **Dispatch log:** `notes/DISPATCH_LOG.md` (Dispatch's working notes)
- **Code:** monorepo OR split-repo per Lead Dev's decision; source in `modules/<name>/` if monorepo
- **Assets:** `assets/branding/` for Borges fonts + LaTeX `.sty` + design tokens
- **Memory:** `.auto-memory/` per-project; canonical project-domain plan inherited from the host-level `.auto-memory/project_personal_domain_infrastructure_plan.md`

## Phase plan

- **Phase 0 (now):** Team activation; Lead Dev writes `ARCHITECTURE.md` covering monorepo decision, branch/PR/tag conventions for `energeia`, Access policy patterns, design-token strategy
- **Phase 1:** DNS audit + Cloudflare account setup + DNS migration preserving iCloud MX; `phronesis.skeptou.com` placeholder deploy with Access policy; QA verifies gating end-to-end
- **Phase 2:** `phronesis.skeptou.com` content build — Quartz from O&P Obsidian vault; scheduler (`kairos`) integrated; mobile PWA manifest; QA pass
- **Phase 3:** Public apex `skeptou.com` (Cormorant font placeholder); minimal initial content
- **Phase 4:** `energeia.skeptou.com` papers pipeline — Obsidian/Scrivener external-folder sync; GitHub Action LaTeX compile; branch/PR/tag versioning; compile-diff
- **Phase 5+:** Subsequent modules per Cam's priority (`aristeia` `strategia` `graphe` `phero` likely next)

## Cam-decisions still open

- Slot 15 (Applications) — unnamed, deferred
- Borges public-web licensing (apex font; Cormorant placeholder until revisited)
- Parchment background screen-contrast adjustment (or use #fcf5e5 directly)
- 1.5 line-height adjustments by medium (per Lead Dev research)
- Monorepo vs split-repo (Lead Dev recommends in `ARCHITECTURE.md`)

## How to apply

When Dispatch routes work to this project:
- New module spec / design question → Lead Dev / Architect
- Infrastructure / deploy / DNS / Access policy → DevOps / Deploy
- Verification / Access-gating-gate / aesthetic compliance → Quality Assurance
- Implementation (writing actual code) → fresh Code task spawned by Dispatch with Sonnet tier per `code-task-model-selection`

The three management roles produce routing recommendations as documents; Dispatch fires the Code tasks per the standing rule.