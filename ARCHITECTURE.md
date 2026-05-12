# ARCHITECTURE.md — Sképtou

**Owner:** Lead Dev / Architect  
**Status:** Phase 0 — authoritative foundation document  
**Last revised:** 2026-05-11

---

## §I. Repository Structure: Monorepo

**Decision: Monorepo.**

The 18 modules are independent in function but tightly coupled along two axes that make a monorepo the correct choice: shared aesthetic assets and shared infrastructure dependencies. Splitting into per-module repositories would require either duplicating the font distribution, the design-token file, and the LaTeX source across every repo, or establishing a separate assets repository with submodule or package dependencies — adding coordination overhead without meaningful isolation benefit.

The monorepo structure is as follows:

```
skeptou/                          ← repo root
  ARCHITECTURE.md
  CLAUDE.md
  README.md (minimal)

  assets/
    branding/
      fonts/                      ← Borges font faces + license verification
      tokens/
        design-tokens.css         ← single source of truth for all web tokens
        tokens.json               ← machine-readable export for tooling
      latex/
        ucr-borges.sty            ← LaTeX style package (reference copy)
        ucr-borges-tokens.tex     ← token definitions extracted for cross-reference

  modules/
    apex/                         ← skeptou.com (Slot 0)
    phronesis/                    ← Slot 1 (FOUNDATION)
    energeia/                     ← Slot 2
    phero/                        ← Slot 3
    paideia/                      ← Slot 4
    aristeia/                     ← Slot 5
    kairos/                       ← Slot 6
    katharsis/                    ← Slot 7 (stub only until specified)
    strategia/                    ← Slot 8
    graphe/                       ← Slot 9 (shared resource — see §IV)
    phobos/                       ← Slot 10
    epistole/                     ← Slot 11
    elenchus/                     ← Slot 12
    angelos/                      ← Slot 13
    logos/                        ← Slot 14
    scholia/                      ← Slot 16
    thesauros/                    ← Slot 17
    kleos/                        ← Slot 18

  .github/
    workflows/
      deploy-phronesis.yml
      deploy-energeia.yml
      sync-graphe.yml
      ...                         ← one workflow file per module

  specs/                          ← Lead Dev–authored module specs
  notes/
    STATE_OF_PLAY.md
    DISPATCH_LOG.md
  .auto-memory/
    journal/
```

Each `modules/<name>/` directory is self-contained: its own `package.json` or `wrangler.toml`, its own build output, its own Cloudflare Pages / Workers config. GitHub Actions workflows are scoped by path filter so that a commit touching only `modules/energeia/` triggers only the energeia pipeline.

**Rationale for monorepo over split-repo:**

The strongest argument against monorepo is independent deployment cadence. That concern is fully addressed by scoped workflow triggers (`paths: ['modules/energeia/**', 'assets/branding/**']`). A change to design tokens correctly triggers all module deploys; a change to one paper triggers only the energeia pipeline. This is the correct behavior, not a bug.

The strongest argument for monorepo is the aesthetic and asset layer. The Borges font faces are licensed for Access-gated subdomains. Managing distribution across 18 separate repos introduces version skew risk and makes it impossible to enforce the "no logos" and "no black body text" constraints from a single authoritative location. A single `assets/branding/` directory, referenced by all modules, closes that risk.

---

## §II. Branch / PR / Tag Conventions — `energeia`

`energeia.skeptou.com` (Slot 2) is the papers and writing pipeline. Its branching strategy must accommodate the lifecycle of academic papers: drafts that sit for months, submission events, revision cycles, and publication states that deserve permanent record.

### Branch structure

```
main                              ← deployed to energeia.skeptou.com; only finalized states
draft/<paper-slug>                ← active drafting; does NOT trigger deploy
review/<paper-slug>               ← submitted for internal/external review; PR opened against main
submitted/<paper-slug>            ← submitted to venue; merged to main on submission
published/<paper-slug>            ← post-acceptance version; merged to main on acceptance
revised/<paper-slug>              ← R&R or post-submission revision; branches from submitted/<slug>
```

`main` is always deployed. All other branches accumulate changes. A paper advances through states by opening a PR against `main`; the PR title carries the state transition.

### PR conventions

PR title format: `[<paper-slug>] <state transition description>`

Examples:
- `[epistemic-akrasia] Submit to Philosophical Studies — v2`
- `[testimony-paper] Accept revisions from BJPS — R1`
- `[dissertation-ch3] Finalize for committee distribution`

PR body template (in `modules/energeia/.github/PULL_REQUEST_TEMPLATE.md`):

```markdown
## Paper
<!-- slug and full title -->

## State transition
<!-- e.g., draft → submitted, submitted → accepted -->

## Venue / recipient
<!-- journal, conference, or committee -->

## Compile status
<!-- GitHub Action compile result; paste link or "✓ clean" -->

## Changes since last merge
<!-- brief summary of what changed in this version -->
```

### Tags

Tags mark permanent submission/publication events and are the canonical record for when a paper was in a given state.

Tag format: `<paper-slug>@<status>-<YYYYMMDD>`

Examples:
- `epistemic-akrasia@submitted-20260512`
- `epistemic-akrasia@r1-20261103`
- `testimony-paper@accepted-20260301`
- `testimony-paper@published-20260615`

Tags are applied by the engineer Code task that runs the deploy pipeline, triggered on merge to `main`. The GitHub Action reads the PR title, extracts the slug and status, and applies the tag programmatically. This means tags are always tied to a clean, compiled, deployed state.

### Deploy pipeline (PR-merge-deploy-bump)

1. PR merged to `main`
2. GitHub Action triggers on `push` to `main` with `paths: ['modules/energeia/**']`
3. Action compiles LaTeX sources in `modules/energeia/papers/<slug>/` → PDF artifacts
4. Action bumps `modules/energeia/VERSION` (semver patch; minor on new paper; major reserved)
5. Action deploys compiled output to Cloudflare Pages (`energeia.skeptou.com`)
6. Action applies git tag per the convention above
7. Action uploads PDF to the Cloudflare Pages artifact store for `energeia`

Compile-diff: the Action stores the previous compiled PDF checksum in a workflow artifact. On each run it computes the diff and writes a `compile-diff/<slug>-<YYYYMMDD>.txt` to the repo. This gives a lightweight audit trail of what changed in each compiled version without requiring a full diff tool.

---

## §III. Cloudflare Access Policy Patterns

### Policy architecture

**Per-subdomain Access policies, shared identity provider.**

Each private subdomain gets its own Access Application in the Cloudflare dashboard. A single identity provider configuration (GitHub OAuth tied to Cam's personal account, or Google, depending on preference) is shared across all applications. This provides independent revocation and per-subdomain audit logs while avoiding repeated IdP setup.

Standard policy template for every new private subdomain:

```
Application name:   <Greek-name> — Sképtou
Application domain: <slug>.skeptou.com/*
Identity provider:  [GitHub / Google — Cam's personal account]
Policy rule:        Email is camh502@alumni.stanford.edu
Session duration:   24 hours
Allowed cookie:     SameSite=Strict; Secure; HttpOnly
```

24-hour sessions are the default. This may be relaxed to 7 days for stable, low-sensitivity modules (e.g., `thesauros`, `kleos`) once they're in steady-state; that adjustment is per-module and requires an explicit decision.

### Activation sequence per new subdomain

This is the non-negotiable gate:

1. DevOps creates the Cloudflare Pages project (or Worker route) with an empty placeholder page — styled with the Sképtou aesthetic (parchment background, Purple "Coming soon" text in Borges-Gris or Cormorant at apex), but no content.
2. DevOps attaches the Access Application and policy before the first deploy.
3. QA verifies the gate from: (a) desktop browser authenticated session, (b) desktop browser incognito, (c) mobile browser, (d) mobile browser private mode. All unauthenticated requests must receive the Cloudflare Access login prompt, not the placeholder page.
4. QA signs off in `notes/STATE_OF_PLAY.md`.
5. Only after QA sign-off does any real content deploy.

### Worker-to-Worker authentication

Some modules call other modules at runtime (e.g., `energeia` Workers components querying `graphe` bib data; `kairos` scheduler calling `epistole` inbox). These calls use **Cloudflare Service Tokens**, not user-session cookies. Service Tokens are long-lived machine credentials scoped to specific source-destination pairs. They bypass the user-facing Access login page while still enforcing authenticated access.

Service Token pairs to establish:
- `graphe` (consumer: `energeia`, `aristeia`, `strategia`, `paideia`) — one service token per consumer
- `kairos` (consumer: `epistole`) — for scheduler → inbox writes
- `graphe` GitHub Action sync — a dedicated Service Token scoped only to the `graphe` KV write path

Service Tokens are stored as GitHub Actions secrets and Cloudflare environment secrets; they never appear in committed code.

### `logos.skeptou.com` — Cloudflare Tunnel

`logos` (Slot 14) is the local LLM frontend routed via Cloudflare Tunnel. It requires a different policy pattern:

- Cloudflare Tunnel routes traffic from `logos.skeptou.com` to `localhost:<port>` on Cam's desktop machine
- Access Application is identical to other private subdomains (email policy, 24h session)
- The tunnel is only active when Cam's machine is running `cloudflared`; the Access Application is always active and blocks all access regardless of tunnel state

---

## §IV. `graphe` as Shared Bibliography Resource

`graphe.skeptou.com` (Slot 9) is not merely a module; it is shared infrastructure consumed by at least four other modules. Its architecture is documented here at the ARCHITECTURE level, not deferred to a module spec, because decisions here constrain the consuming modules.

### Storage

Cloudflare KV. Each bibliography entry is stored as:
- **Key:** `bib:<citekey>` (e.g., `bib:plantinga1974nature`)
- **Value:** JSON-serialized entry with fields: `citekey`, `type`, `author`, `title`, `year`, `venue`, `doi`, `url`, `abstract` (truncated), `raw_bibtex`

A secondary index key `bib:index` stores an array of all citekeys for enumeration.

### Sync pipeline

A GitHub Action (`sync-graphe.yml`) runs on push to `main` when files under `modules/graphe/data/` change. The `data/` directory contains Cam's exported `.bib` file (synced from Obsidian vault or Zotero export). The Action:

1. Parses the `.bib` file with a lightweight Node.js parser (no heavy dependencies)
2. Diffs against the current KV index (via Cloudflare API)
3. Writes new or changed entries to KV; removes deleted entries
4. Logs a sync report to `modules/graphe/logs/sync-<YYYYMMDD>.json`

The sync is additive by default; deletion requires a flag in the commit message (`[graphe-prune]`) to prevent accidental removal of entries that are still referenced downstream.

### Consumption patterns

**Build-time (for Quartz modules):** `energeia`, `paideia`, `aristeia`, `strategia`  
During the Cloudflare Pages build (triggered by GitHub Actions), the build script fetches bib data from the `graphe` Worker before Quartz renders. Fetched data is written to a local JSON file that Quartz templates can reference. This bakes bibliography data into the static HTML. Staleness is acceptable; the next push to `modules/energeia/` triggers a fresh build.

**Runtime (for Workers modules):** any Workers-based module that generates dynamic content referencing bibliography items  
The consuming Worker fetches `https://graphe.skeptou.com/bib/<citekey>` (authenticated via Service Token). Response is JSON; the Worker renders it inline.

Quartz modules prefer build-time fetch. Workers modules prefer runtime fetch. No module should maintain its own copy of bibliography data — `graphe` is the single source of truth.

---

## §V. CSS Design-Token Sharing

### Single source of truth

`assets/branding/tokens/design-tokens.css` is the authoritative token file. All modules, regardless of rendering environment, consume tokens from this file or from `tokens.json` (a machine-readable export for any build tooling that needs raw hex values).

No module hardcodes a color, font name, or spacing value. Every instance of `#301934` in module code is a bug; it should be `var(--color-purple)`.

### Token file

```css
/* assets/branding/tokens/design-tokens.css */
/* Sképtou design tokens — ucr-borges web translation */

:root {
  /* ── Color ─────────────────────────────────────── */
  --color-parchment:   #fcf5e5;   /* background */
  --color-purple:      #301934;   /* body text — NOT black */
  --color-mauve:       #915f6d;   /* section headers, dividers, rules */
  --color-wine:        #722f37;   /* emphasis, keyterms */
  --color-quartz:      #51414f;   /* secondary text */
  --color-coral:       #f08080;   /* warm accent — use sparingly */
  --color-light-steel: #b0c4de;   /* cool accent */
  --color-steel:       #4682b4;   /* cool accent, stronger */

  /* ── Typography — private subdomains ───────────── */
  --font-body:         'Borges-Gris', serif;
  --font-body-italic:  'Borges-GrisItalic', serif;
  --font-bold:         'Borges-Negra', serif;
  --font-bold-italic:  'Borges-NegraItalic', serif;
  --font-light:        'Borges-Blanca', serif;
  --font-display:      'Borges-TituloBlanca', serif;
  --font-display-alt:  'Borges-TituloHueca', serif;  /* outline */
  --font-ornament:     'Cinzel', serif;               /* Google Fonts */

  /* ── Typography — public apex only ─────────────── */
  --font-apex-body:    'Cormorant', serif;

  /* ── Spacing ────────────────────────────────────── */
  --line-height:       1.5;
  --section-margin:    1.75rem;   /* ~24pt at 16px base; adjust per medium */
  --section-margin-lg: 2.25rem;   /* ~30pt */

  /* ── Rules ──────────────────────────────────────── */
  --rule-weight:       1px;       /* 0.6pt → 0.8px; 1px is safe screen minimum */
  --rule-color:        var(--color-mauve);

  /* ── Section numbering ──────────────────────────── */
  --section-prefix:    '§';

  /* ── Watermark ──────────────────────────────────── */
  --watermark-opacity: 0.04;      /* 4% — within the 3–5% range */
}
```

`tokens.json` is generated from this file by a small build script (`assets/branding/tokens/build-tokens.js`) invoked during any module's CI run. It exports a flat JSON object with the same keys stripped of `--` prefix and using camelCase.

### Module consumption

**Quartz modules (phronesis, energeia, paideia, aristeia, strategia):**  
Quartz 4 supports a `custom.scss` file and a `Head` component override. Each Quartz module imports `design-tokens.css` via a `<link>` in the `Head` component. The CSS file is served from a shared path — either baked into the Quartz `static/` directory (copied from `assets/branding/tokens/` at build time by the GitHub Action) or fetched from a dedicated Cloudflare Pages asset route.

Recommendation: copy at build time. This avoids a cross-subdomain fetch on every page load and keeps each subdomain fully self-contained for offline / Access-disruption scenarios.

**Workers HTML modules (kairos, graphe, epistole, elenchus, angelos, logos, scholia):**  
The Worker HTML template inlines `design-tokens.css` in a `<style>` block generated at build time. The Action reads `assets/branding/tokens/design-tokens.css` and injects it verbatim into the Worker's HTML template before deploying. This avoids a runtime external fetch for a foundational file.

**Apex (skeptou.com):**  
The apex uses Cormorant instead of Borges (the font variable is `--font-apex-body`, not `--font-body`) and loads from Google Fonts. The same `design-tokens.css` is used, but the apex module overrides `--font-body` with `--font-apex-body` in its local stylesheet:

```css
/* modules/apex/styles/apex-overrides.css */
:root {
  --font-body: var(--font-apex-body);
}
```

This means no module needs to know whether it's the apex or a private subdomain — the token cascade handles it.

---

## §VI. Aesthetic Implementation — LaTeX to Web

The `ucr-borges` LaTeX style package defines Sképtou's visual language. The web translation is a systematic mapping, not a redesign. The following are the canonical equivalences.

### Color

| LaTeX command | Web equivalent |
|---|---|
| `\textcolor{purple}{...}` / body text default | `color: var(--color-purple)` |
| `\textcolor{mauve}{...}` / `\section{}` | `color: var(--color-mauve)` |
| `\textcolor{wine}{...}` / emphasis | `color: var(--color-wine)` |
| `\textcolor{quartz}{...}` / secondary | `color: var(--color-quartz)` |
| `\textcolor{coral}{...}` | `color: var(--color-coral)` |
| Background | `background-color: var(--color-parchment)` |

Body text default is always Purple. Setting `body { color: var(--color-purple); }` in the base stylesheet enforces this globally; no module overrides this default.

### Typography

| LaTeX command | Web equivalent |
|---|---|
| `\textsc{...}` (small caps) | `font-variant-caps: small-caps; letter-spacing: 0.04em` |
| `\onehalfspacing` | `line-height: var(--line-height)` (1.5) |
| `\textbf{...}` | `font-family: var(--font-bold)` (Borges-Negra) |
| `\textit{...}` | `font-family: var(--font-body-italic)` (Borges-GrisItalic) |
| `\textbf{\textit{...}}` | `font-family: var(--font-bold-italic)` (Borges-NegraItalic) |
| Section headings (structural labels) | `font-family: var(--font-body); font-variant-caps: small-caps; color: var(--color-mauve)` |
| Display / title | `font-family: var(--font-display)` (Borges-TituloBlanca) |
| Ornamental / decorative | `font-family: var(--font-ornament)` (Cinzel) |

Small-caps headings are the canonical structural marker. The `font-variant-caps: small-caps` CSS property combined with `letter-spacing: 0.04em` is the correct rendering for headings that use `\textsc{}` in the LaTeX source.

### Section numbering

LaTeX uses `§I`, `§II`, etc. On the web, this is implemented with CSS counters:

```css
.section-numbered {
  counter-increment: section-counter;
}
.section-numbered::before {
  content: '§' counter(section-counter, upper-roman) '\2002';
  color: var(--color-mauve);
  font-variant-caps: small-caps;
}
```

For Quartz, this is injected via the `custom.scss` or a component override. For Workers HTML, it is included in the module's base stylesheet.

### Rules and dividers

| LaTeX command | Web equivalent |
|---|---|
| `\hrule` / `\maquerule` | `border-top: var(--rule-weight) solid var(--rule-color)` |
| Section divider | `<hr class="sk-rule">` rendered as above |
| Margin between sections | `margin-block: var(--section-margin)` |

No decorative box shadows, no thick borders. The Mauve hairline rule is the only structural divider.

### Watermarks

Background watermarks in LaTeX use a low-opacity image placed behind the text layer. The web equivalent:

```css
body::before {
  content: '';
  position: fixed;
  inset: 0;
  background-image: url('/assets/branding/watermark.png');
  background-size: cover;
  background-position: center;
  opacity: var(--watermark-opacity);  /* 0.04 */
  pointer-events: none;
  z-index: -1;
}
```

The watermark asset (`watermark.png`) is a neutral texture or structural mark, NOT a logo. UCR.png and IMG_4719.jpeg are excluded unless explicitly requested per CLAUDE.md.

### Spacing and layout

| LaTeX convention | Web equivalent |
|---|---|
| Generous section margins (18–30pt) | `margin-block: var(--section-margin)` to `var(--section-margin-lg)` |
| `\vspace{1em}` between paragraphs | `margin-bottom: 1em` on `<p>` |
| No indentation (block paragraph style) | `text-indent: 0; margin-top: 0.75em` |
| Max readable line length | `max-width: 68ch` on content containers |

The 68ch max-width preserves the LaTeX-document reading experience on wide screens. Quartz's default content width may need overriding; this is done in `custom.scss`.

---

## §VII. Open Questions (Cam-decisions required)

The following are deferred pending explicit decisions. No engineering work should proceed on these points until they are resolved.

1. **Monorepo vs split-repo (resolved above as monorepo)** — Lead Dev recommendation recorded. Cam confirms or overrides before Phase 1 work begins.
2. **Slot 15 (Applications)** — unnamed and deferred; no architecture work until specified.
3. **Borges public-web licensing** — apex uses Cormorant as placeholder; this decision is deferred. When resolved, apex font token changes in one place (`design-tokens.css`).
4. **Parchment screen contrast** — `#fcf5e5` at 1x display is visually comfortable; at 2x/high-contrast it may need adjustment. Lead Dev notes this as a QA item for Phase 3 (apex deploy). No token change until QA surfaces a specific concern.
5. **Line-height adjustments by medium** — 1.5 is correct for body copy; headings and display elements may warrant tighter leading (1.2–1.3). This is a Quartz-theme and Workers-template detail, deferred to module-spec phase.
6. **GitHub identity for the repo** — monorepo needs a name and GitHub organization or personal account home. Assumed to be Cam's personal GitHub account; confirm before Phase 1.
7. **Cloudflare identity provider choice** — GitHub OAuth vs. Google vs. one-time PIN. The architecture supports any of these; the choice affects the Access policy setup. Cam decides before DevOps runs Phase 1.

---

## §VIII. Phase 0 Completion Criteria

Phase 0 is complete when:

- [x] `CLAUDE.md` present at project root
- [x] `ARCHITECTURE.md` present at project root (this document)
- [ ] Cam reviews and approves (or overrides) the monorepo decision
- [ ] Cam resolves open questions in §VII that are required for Phase 1 (items 6 and 7 are blockers)
- [ ] `notes/STATE_OF_PLAY.md` created (Lead Dev authors after Cam approval)
- [ ] Directory scaffolding committed to GitHub (`modules/`, `assets/branding/`, `specs/`, `notes/`, `.github/workflows/`)

Phase 1 begins immediately after Cam's approval of this document and resolution of the Phase-1 blocking open questions.

---

*Filed by Lead Dev / Architect — Sképtou. Dispatch surfaces to Cam.*
