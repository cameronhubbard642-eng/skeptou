# Module Spec — `phronesis.skeptou.com`

**Slot:** 1 (FOUNDATION)  
**Owner:** Lead Dev / Architect  
**Status:** FINAL — ready for engineer brief  
**Last revised:** 2026-05-12

---

## §I. Purpose and Scope

`phronesis.skeptou.com` is the private planning dashboard. It provides read-only views into Cam's O&P Obsidian vault and interactive controls for advancing project-opportunity decisions. First private subdomain to deploy (Phase 2); functional anchor for the dashboard-planning cluster.

**In scope:**
- Static read-only views: Main Dashboard, Project Manifest, Opportunity Dashboard, Inventory
- Interactive mutations: opportunity Accept / Reject with plan scaffolding on Accept
- Busy-period visualization: heatmap + density gradient, user-toggled
- Quartz + Workers hybrid architecture
- Mobile PWA manifest

**Out of scope:**
- Write-back to arbitrary vault files (only opp frontmatter, PROJECT_MANIFEST.md, and new plan files)
- Real-time calendar sync (calendar data is build-time aggregated from .ics export)
- Multi-user access (single user: Cam only)
- Notification / alert system (deferred to `angelos`)
- `kairos` scheduler integration (Phase 2 stretch; add only if Worker is ready, else defer to patch)

---

## §II. Architecture

**Quartz + Cloudflare Worker hybrid.**

```
phronesis.skeptou.com/           ← Cloudflare Pages (Quartz static output)
  /                              ← Main Dashboard
  /manifest                      ← Project Manifest
  /opportunities                 ← Opportunity Dashboard (Accept/Reject controls)
  /inventory                     ← Inventory view

phronesis.skeptou.com/api/*      ← Cloudflare Pages Function (Worker)
  POST /api/opportunity/accept/:slug
  POST /api/opportunity/reject/:slug
```

The Cloudflare Access policy covers `phronesis.skeptou.com/*` entirely. The Worker at `/api/*` inherits the same Access gate — no unauthenticated requests reach the mutation endpoints.

### Data flow

```
O&P vault (private GitHub repo)
  │
  ├── Push to vault main
  │     └── GitHub Actions: sync-and-build workflow
  │           ├── Step 1: aggregate-busy.js (parse .ics + COMMITMENTS.md → busy-scores.json)
  │           ├── Step 2: Quartz build (reads synced vault files + busy-scores.json)
  │           └── Step 3: Deploy to Cloudflare Pages (phronesis)
  │
  └── Cloudflare Worker (POST /api/opportunity/*)
        ├── Reads CF Access session to confirm authenticated request
        ├── Calls GitHub Contents API (repo-scoped PAT, stored as Worker secret)
        │     ├── Updates opp-<slug>.md frontmatter
        │     ├── Updates PROJECT_MANIFEST.md (on accept)
        │     └── Creates projects/<slug>-plan.md (on accept)
        └── Commit triggers vault push → rebuild loop (above)
```

Rebuild latency after Accept/Reject: ~1–2 minutes. No optimistic UI update in Phase 2; the dashboard reflects new state after the rebuild completes.

---

## §III. Repository and Content Sync

### Vault files synced to phronesis build

A GitHub Actions step (`sync-vault-content`) runs before Quartz build. It fetches the following files from the O&P vault repo into `modules/phronesis/content/`:

```
PROJECT_MANIFEST.md              → content/manifest.md
opp-*.md                         → content/opportunities/
INVENTORY.md                     → content/inventory.md
inventory/*.md                   → content/inventory/
COMMITMENTS.md                   → content/commitments.md  (aggregation input only)
<icloud-calendar-export>.ics     → content/calendar.ics    (aggregation input only)
```

`COMMITMENTS.md` and `calendar.ics` are consumed by the aggregation script and do NOT render as pages. They are excluded from Quartz's content graph via a `.quartz-ignore` pattern or explicit `draft: true` frontmatter added by the sync step.

The iCloud .ics file must be committed to the O&P vault by a recurring export step (manual or automated via Cam's O&P pipeline). **DevOps confirms the export path and filename with Cam before Phase 2 begins.**

### Quartz content structure

```
modules/phronesis/
  content/
    index.md                     ← Main Dashboard (hand-authored, aggregation data injected)
    manifest.md                  ← synced from vault
    opportunities/
      index.md                   ← Opportunity Dashboard (Quartz generates listing)
      opp-*.md                   ← synced from vault
    inventory.md                 ← synced from vault
    inventory/                   ← synced from vault
  src/
    data/
      busy-scores.json           ← output of aggregate-busy.js
  scripts/
    aggregate-busy.js            ← build-time aggregation script
    sync-vault.js                ← (or shell script) vault file sync helper
  static/
    design-tokens.css            ← copied from assets/branding/tokens/ at build time
    skeptou.css                  ← phronesis-specific stylesheet + font declarations
  quartz.config.ts
  quartz.layout.ts
```

### Quartz theme and design tokens

`static/skeptou.css` imports `design-tokens.css` and applies the site-wide token treatment:

```css
/* skeptou.css — phronesis */
@import './design-tokens.css';

/* Font faces — Borges (private subdomain license confirmed) */
/* Source files: assets/fonts/borges/*.ttf — Engineer: uncomment all @font-face blocks */
@font-face {
  font-family: 'Borges-Gris';
  src: url('/fonts/borges/BorgesGris.ttf') format('truetype');
  font-weight: 300;
  font-style: normal;
}
@font-face {
  font-family: 'Borges-GrisItalic';
  src: url('/fonts/borges/BorgesGrisItalic.ttf') format('truetype');
  font-weight: 300;
  font-style: italic;
}
@font-face {
  font-family: 'Borges-Negra';
  src: url('/fonts/borges/BorgesNegra.ttf') format('truetype');
  font-weight: 700;
  font-style: normal;
}
@font-face {
  font-family: 'Borges-NegraItalic';
  src: url('/fonts/borges/BorgesNegraItalic.ttf') format('truetype');
  font-weight: 700;
  font-style: italic;
}
@font-face {
  font-family: 'Borges-Blanca';
  src: url('/fonts/borges/BorgesBlanca.ttf') format('truetype');
  font-weight: 200;
  font-style: normal;
}
@font-face {
  font-family: 'Borges-TituloBlanca';
  src: url('/fonts/borges/BorgesTituloBlanca.ttf') format('truetype');
  font-weight: 200;
  font-style: normal;
}
/* (Remaining faces: SuperNegra, TituloHueca, Poema — add @font-face blocks per available .ttf) */

/* Base */
body {
  font-family: var(--font-body);
  color: var(--color-purple);
  background-color: var(--color-parchment);
  line-height: var(--line-height);
}

/* Section headers */
h1, h2, h3, h4 {
  font-family: var(--font-body);
  font-variant-caps: small-caps;
  letter-spacing: 0.04em;
  color: var(--color-mauve);
}

/* Dividers */
hr.sk-rule {
  border: none;
  border-top: var(--rule-weight) solid var(--rule-color);
  margin-block: var(--section-margin);
}

/* Body text max-width */
.page-content {
  max-width: 68ch;
}
```

The Borges `.ttf` files are to be served from `static/fonts/borges/` (Cloudflare Pages serves everything in `static/` at the root). **Engineer: copy `assets/fonts/borges/*.ttf` into `modules/phronesis/static/fonts/borges/` as part of the build setup step.**

---

## §IV. Read-Only Views

### §IV.1 Main Dashboard (`/`)

Aggregated overview. Content is a mix of Quartz-rendered markdown (hand-authored `index.md`) and data injected at build time.

**Sections:**
1. **Status summary** — counts injected by a Quartz plugin or build-time template substitution:
   - Active projects: N (linked to `/manifest`)
   - Pending decisions: N (linked to `/opportunities`)
   - Confirmed-pursuing: N
2. **Busy-period visualization** — the heatmap/density toggle (§VII); the `busy-scores.json` data is embedded in the page as an inline `<script>` block or referenced as a static JSON file
3. **Quick links** — Manifest / Opportunities / Inventory; styled as Mauve small-caps navigation links

The injected counts are computed by the sync-and-build workflow by reading the synced `opp-*.md` frontmatter and writing a `src/data/manifest-stats.json` that the build step reads.

### §IV.2 Project Manifest (`/manifest`)

Direct Quartz rendering of the synced `manifest.md`. No transformation beyond Quartz's standard markdown rendering plus the skeptou.css token treatment.

Table styling: headers in small-caps, Mauve rule beneath the header row, Purple body text, no heavy borders.

### §IV.3 Opportunity Dashboard (`/opportunities`)

Card-based listing of all `opp-*.md` files. Rendered by a custom Quartz component (`OpportunityList`) that reads opportunity frontmatter and groups by status.

**Grouping and display order:**
1. **Pending decision** (`status: pending-cam-decision`) — shown first; each card has Accept + Reject action buttons
2. **Confirmed pursuing** (`status: confirmed-pursuing`) — shown below; display-only (no action buttons)
3. **Declined** (`status: declined`) — collapsible section at bottom; display-only

**Card fields displayed:**
- Title (from frontmatter `title` or H1 of file)
- Type (from frontmatter `type`)
- Deadline (from frontmatter `deadline`)
- Prestige (from frontmatter `prestige` — displayed as a badge or inline label; empty string displays as blank, not an error)
- Requirement (from frontmatter `requirement` — brief display, truncated at ~80 chars if long)
- Status badge (colored per status: Wine for pending, Steel for confirmed, Quartz for declined)
- Accept / Reject buttons (pending-decision cards only)

**Accept / Reject buttons** are plain HTML `<button>` elements that call the Worker endpoints via `fetch()` with the CF Access session cookie included. On success (202), the page displays a brief "Accepted — rebuilding…" or "Declined — rebuilding…" inline message replacing the buttons. No redirect; the user waits for rebuild to see full updated state.

### §IV.4 Inventory (`/inventory`)

Quartz rendering of the synced `inventory.md` with links to `inventory/*.md` sub-pages. Standard markdown rendering + skeptou.css treatment.

---

## §V. Schema Amendment — Opportunity Files

Two new frontmatter fields are required on `opp-*.md` files. **This is a sub-routing item for PM-O&P (Portfolio Manager — O&P, session `local_1e9b2bc7-…`) — see §IX.**

### Updated `opp-*.md` frontmatter schema

```yaml
---
title: <string>
type: opportunity | project | milestone | commitment | recurring
status: pending-cam-decision | confirmed-pursuing | declined
deadline: <ISO date or human-readable, e.g. "2026-09-01">
prestige: <string — e.g. "High / flagship journal" — OR blank>
requirement: <string — e.g. "Full paper, ~10k words" OR "Abstract + writing sample">
description: <string — brief summary for card display>
---
```

`prestige` and `requirement` are new. They are optional in the sense that blank values are valid and phronesis handles them gracefully (displays empty). They are required for full plan-scaffolding fidelity.

The Worker's accept endpoint must handle absent `prestige` or `requirement` fields without error — fall back to empty string in the scaffolded plan file.

---

## §VI. Dynamic Mutations — Cloudflare Worker

The Worker is a Cloudflare Pages Function at `modules/phronesis/functions/api/opportunity/[action]/[slug].js` (or equivalent Pages Functions routing pattern).

**Authentication:** The Worker reads the `CF-Access-Jwt-Assertion` header (automatically present on requests that have passed the Access gate) and validates it against the Cloudflare Access public keys. Requests without a valid assertion return 401 immediately. The Worker does not re-implement its own auth; it delegates entirely to the Access layer.

**GitHub PAT:** A repo-scoped GitHub Personal Access Token with `contents: write` permission on the O&P vault repo is stored as a Cloudflare Pages secret (`VAULT_GITHUB_PAT`). The Worker uses this for all GitHub Contents API calls.

**Commit identity:** Commits appear as `phronesis-bot <phronesis@skeptou.com>` (a non-deliverable address; just a git author identity). Commit messages follow the format: `phronesis: <accept|reject> <slug> [automated]`.

### `POST /api/opportunity/accept/:slug`

**Inputs:** `slug` path parameter (the filename stem of `opp-<slug>.md`)

**Steps (execute sequentially; abort and return 500 on any GitHub API failure):**

1. Fetch `opp-<slug>.md` from vault repo via GitHub Contents API (`GET /repos/:owner/:repo/contents/opp-<slug>.md`)
2. Base64-decode file content; parse frontmatter (use a minimal JS frontmatter parser — no heavy dependencies)
3. Update frontmatter fields:
   - `status` → `confirmed-pursuing`
   - `date_accepted` → current ISO date (UTC)
4. Re-serialize frontmatter + original body; base64-encode
5. Commit updated `opp-<slug>.md` via `PUT /repos/:owner/:repo/contents/opp-<slug>.md` with the original file SHA
6. Fetch `PROJECT_MANIFEST.md` from vault repo
7. Locate the row containing `opp-<slug>` in the Opportunities section; move it to the Active Projects section (string manipulation — find the row, remove from Opportunities table, append to Active Projects table)
8. Commit updated `PROJECT_MANIFEST.md`
9. Construct plan file content per §VII template
10. Commit new file at `projects/<slug>-plan.md` (the path `projects/` is the canonical plan-file directory in the O&P vault — **DevOps confirms this path with Cam before Phase 2**)
11. Return `202 Accepted` with JSON body `{ "status": "accepted", "slug": "<slug>", "message": "Rebuilding — changes live in ~2 minutes" }`

**File rename:** No. `opp-<slug>.md` filename is preserved. Status field drives display.

### `POST /api/opportunity/reject/:slug`

**Inputs:** `slug` path parameter

**Steps:**

1. Fetch `opp-<slug>.md` from vault repo
2. Parse frontmatter
3. Update:
   - `status` → `declined`
   - `date_declined` → current ISO date (UTC)
4. Commit updated `opp-<slug>.md`
5. Return `202 Accepted` with JSON body `{ "status": "declined", "slug": "<slug>", "message": "Rebuilding — changes live in ~2 minutes" }`

No PROJECT_MANIFEST.md change. No plan file created.

---

## §VII. Plan-Scaffolding Template

On Accept, the Worker creates `projects/<slug>-plan.md` with the following structure.

**Template:**

```markdown
---
title: <opp frontmatter: title>
type: <opp frontmatter: type>
status: confirmed-pursuing
prestige: <opp frontmatter: prestige — or blank if absent>
deadline: <opp frontmatter: deadline — or blank if absent>
requirement: <opp frontmatter: requirement — or blank if absent>
date_accepted: <ISO date of acceptance>
linked_opportunity: opp-<slug>
---

# <opp frontmatter: title>

## Requirement

<opp frontmatter: requirement — or "See linked opportunity file.">

## Deadline

<opp frontmatter: deadline — or "See linked opportunity file.">

## Plan

<!-- Add plan details here -->

## Notes

<!-- -->
```

**Pre-fill logic:**

| Plan field | Source | Fallback if absent |
|---|---|---|
| `title` | `opp.title` | slug (humanized) |
| `type` | `opp.type` | `"opportunity"` |
| `prestige` | `opp.prestige` | `""` (blank) |
| `deadline` | `opp.deadline` | `""` (blank) |
| `requirement` | `opp.requirement` | `""` (blank) |
| `date_accepted` | computed at accept time | — |
| `linked_opportunity` | `opp-<slug>` | — |

The plan file body sections are static template text — the Worker writes them verbatim; Cam populates the Plan and Notes sections manually in Obsidian or Scrivener.

---

## §VIII. Busy-Period Aggregation and Visualization

### §VIII.1 Aggregation script (`aggregate-busy.js`)

Runs as a build step (GitHub Actions, before Quartz build). Node.js. No external package dependencies beyond a minimal iCalendar parser (e.g., `node-ical` or a vendored parser to avoid `npm install` latency in CI).

**Inputs:**
- `content/calendar.ics` — iCloud calendar export committed to vault
- `content/commitments.md` — COMMITMENTS.md synced from vault

**Algorithm:**

```
1. Parse calendar.ics:
   For each VEVENT:
     date = DTSTART (date portion only)
     weight = 1  (calendar events are unweighted; each event = 1 unit)
     Add weight to busy_scores[date]

2. Parse commitments.md:
   For each line matching the pattern: `- [ ] ...` or `- [x] ...`
     Extract date: look for a date in the line (ISO format YYYY-MM-DD or
       Obsidian date-link [[YYYY-MM-DD]]) OR use the nearest heading date
       above the line (COMMITMENTS.md uses date headings)
     Extract priority:
       🔺 → weight = 3
       ⏫ → weight = 2
       🔼 → weight = 1
       (none) → weight = 1
     If task is undone (- [ ]): Add weight to busy_scores[date]
     If task is done (- [x]): Skip (completed tasks don't contribute to busy signal)

3. Output:
   Write src/data/busy-scores.json:
   {
     "generated": "<ISO timestamp>",
     "window_days": 364,
     "scores": {
       "YYYY-MM-DD": <number>,
       ...
     },
     "max_score": <number>   // for color-scale normalization
   }
```

The `window_days` field is 364 (52 weeks). Dates outside the rolling 52-week window from build date are excluded from output. Dates with no events or tasks are omitted from `scores` (not written as 0; the visualization treats absent keys as 0).

### §VIII.2 Visualization — two views, user-toggled

Both visualizations are rendered as inline SVG embedded in the Main Dashboard page. The SVG data is generated at build time from `busy-scores.json` by a second build script (`generate-viz.js`) that runs after `aggregate-busy.js`. Output is two SVG strings written into the Quartz `index.md` via template substitution, or injected via a Quartz plugin into the Head/Body.

A toggle control (two buttons: "Heatmap" / "Density") in the dashboard header switches visibility between the two SVGs via CSS class:

```html
<div class="sk-viz-toggle">
  <button class="sk-viz-btn active" data-target="heatmap">Heatmap</button>
  <button class="sk-viz-btn" data-target="density">Density</button>
</div>
<div id="sk-viz-heatmap" class="sk-viz"><!-- heatmap SVG --></div>
<div id="sk-viz-density" class="sk-viz" hidden><!-- density SVG --></div>
```

Minimal inline JS handles the toggle (no framework):

```js
document.querySelectorAll('.sk-viz-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sk-viz').forEach(v => v.hidden = true);
    document.getElementById('sk-viz-' + btn.dataset.target).hidden = false;
    document.querySelectorAll('.sk-viz-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});
```

**Heatmap SVG spec:**

- Layout: 52 columns (weeks) × 7 rows (days of week), left-to-right = oldest to newest
- Cell size: 12px × 12px; gap: 2px
- Color scale (maps 0 → max_score):
  - 0 (no activity): `#fcf5e5` (Parchment)
  - Low: `#b0c4de` (Light Steel)
  - Medium: `#4682b4` (Steel)
  - High: `#301934` (Purple)
  - Use a 4-stop linear interpolation; threshold at 25% / 50% / 75% of max_score
- Month labels above columns (abbreviated: Jan, Feb, etc.) in Mauve small-caps
- Day-of-week labels left of rows (M, W, F only to avoid crowding) in Quartz color
- Tooltip on hover (SVG `<title>` element per cell): `YYYY-MM-DD — Score: N`
- Total SVG dimensions: approximately 780px × 120px (scales with cell count)
- Mobile: scale down via `viewBox`; maintain aspect ratio

**Density gradient SVG spec:**

- Layout: single area chart, x-axis = time (52-week window), y-axis = busy-score
- Weekly aggregation: sum daily scores into weekly buckets (reduces noise)
- Area fill: Steel (`#4682b4`) at 25% opacity
- Line stroke: Mauve (`#915f6d`) at 1.5px
- Axis labels: x-axis month markers in Mauve small-caps; y-axis omitted (relative density is the signal, not absolute score)
- Grid lines: none (minimalist; consistent with LaTeX aesthetic)
- Total SVG dimensions: approximately 780px × 140px
- Mobile: same `viewBox` scaling as heatmap

Both SVGs use the design token hex values directly (inline SVG; no CSS custom properties in SVG attributes for compatibility). The `generate-viz.js` script hardcodes the token hex values; if tokens change, the script is the single update point.

---

## §IX. Sub-Routing Recommendation — PM-O&P Schema Extension

**This is a recommendation for Dispatch to route to PM-O&P (Portfolio Manager — O&P, Sonnet tier, session `local_1e9b2bc7-…`) before the phronesis engineer Code task runs.**

Two new fields (`prestige` and `requirement`) must be added to the `opp-*.md` frontmatter schema. The current vault has 8 existing opportunity files. These fields are optional in phronesis (graceful fallback to blank), but plan scaffolding and opportunity card display are meaningfully degraded without them.

**PM-O&P work package:**
1. Document the updated `opp-*.md` frontmatter schema (the full schema is specified in §V above)
2. Backfill `prestige` and `requirement` fields on the 8 existing `opp-*.md` files in the vault (Cam's Publication Strategist session may have prestige assessments for the academic opportunities; PM-O&P coordinates)
3. Add the new fields to whatever documentation or convention file governs the O&P vault schema
4. Confirm the canonical plan-file directory path (`projects/` assumed; override here if different)
5. Confirm the iCloud .ics export filename and committed path in the vault (needed by `aggregate-busy.js`)

This work does not block phronesis engineer development (the Worker handles absent fields gracefully) but should complete before the first production deploy of phronesis so that the opportunity cards display fully on launch day.

Dispatch fires this as a separate routing action concurrent with or immediately before the phronesis engineer Code task.

---

## §X. GitHub Actions Workflow — `deploy-phronesis.yml`

```yaml
name: Deploy phronesis

on:
  push:
    branches: [main]
    paths:
      - 'modules/phronesis/**'
      - 'assets/branding/**'

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: cd modules/phronesis && npm ci

      - name: Sync vault content
        env:
          VAULT_GITHUB_PAT: ${{ secrets.VAULT_GITHUB_PAT }}
          VAULT_REPO: ${{ secrets.VAULT_REPO }}  # format: owner/repo
        run: node modules/phronesis/scripts/sync-vault.js

      - name: Aggregate busy-period data
        run: node modules/phronesis/scripts/aggregate-busy.js

      - name: Generate visualizations
        run: node modules/phronesis/scripts/generate-viz.js

      - name: Copy design tokens and fonts
        run: |
          cp assets/branding/tokens/design-tokens.css modules/phronesis/static/
          mkdir -p modules/phronesis/static/fonts/borges
          cp assets/fonts/borges/*.ttf modules/phronesis/static/fonts/borges/

      - name: Build Quartz
        run: cd modules/phronesis && npx quartz build

      - name: Deploy to Cloudflare Pages
        uses: cloudflare/pages-action@v1
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          projectName: phronesis-skeptou
          directory: modules/phronesis/public
          gitHubToken: ${{ secrets.GITHUB_TOKEN }}
```

Secrets required (DevOps provisions):
- `VAULT_GITHUB_PAT` — scoped to O&P vault repo, `contents: read` (sync) + `contents: write` (Worker mutations, also stored as CF Pages secret)
- `VAULT_REPO` — `owner/repo` string for the O&P vault
- `CLOUDFLARE_API_TOKEN` — Cloudflare API token with Pages deploy permission
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID

The same `VAULT_GITHUB_PAT` (with `contents: write`) is stored as a Cloudflare Pages secret for the Worker. DevOps ensures the token has write permission on the vault repo.

---

## §XI. Mobile PWA

`modules/phronesis/static/manifest.json`:

```json
{
  "name": "Phronesis — Sképtou",
  "short_name": "Phronesis",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#fcf5e5",
  "theme_color": "#301934",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

Icon files are simple parchment-background + Cinzel "φ" glyph at 192px and 512px. Engineer generates these programmatically (Node canvas or SVG-to-PNG) as part of the build setup. No external design tool required.

---

## §XII. Effort Estimate (revised)

| Component | Estimate |
|---|---|
| Quartz scaffold + skeptou.css + Borges @font-face | 3–4 hrs |
| Vault content sync script | 2–3 hrs |
| Per-view rendering (dashboard, manifest, opportunity, inventory) + OpportunityList component | 3–5 hrs |
| Worker: accept/reject + GitHub Contents API + plan-scaffold commit | 4–6 hrs |
| aggregate-busy.js + generate-viz.js | 4–6 hrs |
| Heatmap SVG + density SVG + toggle control | 3–4 hrs |
| GitHub Actions workflow + secrets wiring | 2–3 hrs |
| Mobile PWA manifest + icons | 1–2 hrs |
| QA gate prep (Access verification, email, mobile) | 2–3 hrs |
| **Total** | **24–36 hrs ≈ 3–5 focused days** |

Variance drivers: iCloud .ics parsing complexity (if the export format has quirks), Quartz version-specific customization friction, and whether the O&P vault sync step requires auth complexity beyond a plain PAT.

---

## §XIII. Phase 2 Completion Criteria

- [ ] Phase 1 complete (Access gate verified on phronesis subdomain)
- [ ] PM-O&P schema extension complete (§IX) — `prestige` + `requirement` fields backfilled on existing opp files
- [ ] iCloud .ics export path confirmed and committed to vault
- [ ] Canonical plan-file directory path confirmed (`projects/` assumed)
- [ ] Cloudflare Pages project created; Access Application attached; DevOps confirms
- [ ] QA verifies Access gate on phronesis (empty placeholder → QA sign-off → content deploy)
- [ ] Engineer Code task completes all components (§XII)
- [ ] QA end-to-end pass: all four views render; Accept/Reject mutations work; rebuild confirmed; both visualizations render; mobile PWA installs
- [ ] QA verifies no unauthenticated access to `/api/*` endpoints
- [ ] `notes/STATE_OF_PLAY.md` updated by Lead Dev to reflect Phase 2 complete

---

*Filed by Lead Dev / Architect — Sképtou. Dispatch surfaces to Cam; routes PM-O&P schema work; fires engineer Code task.*
