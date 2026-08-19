# Module Spec — `skeptou.com` (Apex)

**Slot:** 0  
**Owner:** Lead Dev / Architect  
**Status:** DRAFT — ready for engineer review  
**Last revised:** 2026-05-14 (rev 4 — watermark reinstated on apex; image source: assets/branding/watermark/skeptou-watermark.png; fixed/cover/4% opacity)

---

## §I. Purpose and Scope

`skeptou.com` is the sole public-facing surface of the Sképtou infrastructure. It is a personal academic website serving three audiences: hiring committees evaluating Cam's profile for faculty and postdoctoral positions, philosophers and researchers finding and citing his work, and any visitor seeking professional contact.

### §I.1 Content-authoring policy

**All user-facing prose is authored by Cam. The engineer and Lead Dev produce no personal-website content.**

The build pipeline, templates, and YAML schemas define *slots* — named placeholders Cam fills in. Unfilled slots either render nothing (if optional) or cause a build warning (if required). The spec documents every content slot explicitly:

- YAML files use empty-string values (`""`) or `null` for unfilled slots, with inline comments: `# CAM:`
- Markdown files that Cam writes are listed in §III.1 with their purpose and a one-line brief for Cam
- HTML templates use `<!-- CAM: <slot name> -->` comment markers where inline prose is expected

No engineer or Lead Dev action is required for content: once the build pipeline is working, Cam fills in YAML and markdown files in `agora/website/` and pushes. The site redeploys automatically.

### §I.2 Career-stage framing

Cam is at the early-career stage (PhD candidate, ~2–3 years from initial market cycle). Field convention at this stage favours a lean, clean profile: 3–4 substantive pages. This spec implements a **3-page v1 baseline** (Home / Research / Teaching) with contact information folded into Home and CV deferred to Phase 5.

A dedicated Talks page is Phase 5+. An About / Bio page is Phase 5+. A CV page integrates with the paper-sharing module (phero) and is deferred accordingly.

### §I.3 Page inventory

| Page | URL | Phase |
|---|---|---|
| Home | `/` | Phase 3 v1 |
| Research | `/research/` | Phase 3 v1 |
| Teaching | `/teaching/` | Phase 3 v1 |
| CV | `/cv/` | Phase 5+ (deferred; integrates with phero) |
| Talks (standalone) | `/talks/` | Phase 5+ |
| About / Bio | `/about/` | Phase 5+ |
| Writing / Blog | `/writing/` | Phase 5+ |

### §I.4 In scope (Phase 3)

- Three public pages: Home, Research, Teaching
- Contact information folded into Home page
- Agora content pipeline: `agora/website/` as single source of truth for all prose and data
- Cross-reference to energeia: public-eligible papers pulled from `agora/energeia/slugs.yaml` at build time
- PDF assets: teaching statement PDF, 1–3 syllabi PDFs — hosted on apex
- Structured metadata: JSON-LD `Person` + `ScholarlyArticle`, OpenGraph, Twitter Card, canonical URLs, sitemap.xml
- GitHub Actions deploy pipeline to Cloudflare Pages (apex project, already provisioned)
- robots.txt allowing full indexing

### §I.5 Out of scope (Phase 3)

- CV page — deferred; see §XIV
- Standalone Talks, About, Blog pages — Phase 5+
- Hosting unpublished paper drafts as PDFs — pre-acceptance drafts available on request only (§VI.3)
- Auth gating — this is the only ungated module
- Contact form — email link only
- Dynamic content at runtime — entirely static; no Workers
- References / letter-writer names published — field anti-pattern; not supported anywhere in the schema (§XI.2)
- Background watermark on private subdomains uses `body::before` pattern per ARCHITECTURE.md §VI

---

## §II. Architecture

### §II.1 Module location

```
skeptou/ (monorepo)
  modules/
    apex/
      build/
        build.js              ← main build script (Node.js)
        render-page.js        ← HTML templating (Nunjucks)
        ingest-slugs.js       ← reads agora/energeia/slugs.yaml; filters public papers
        generate-sitemap.js   ← emits sitemap.xml
        generate-jsonld.js    ← emits JSON-LD per page
        tokens-inline.js      ← reads assets/branding/tokens/design-tokens.css; inlines at build
        validate-slots.js     ← warns on required empty content slots at build time
      templates/
        base.njk              ← HTML shell (head, nav, footer)
        home.njk
        research.njk
        teaching.njk
        components/
          nav.njk
          footer.njk
          paper-entry.njk     ← single paper row (research + home recent-work)
          footnote.njk
          rule.njk            ← <hr class="sk-rule">
      styles/
        apex.css              ← apex-specific rules (font override, layout, components)
        apex-overrides.css    ← :root override of --font-body → var(--font-apex-body)
        print.css             ← print stylesheet
      static/
        robots.txt
        favicon.ico
        favicon.svg
      out/                    ← build output (gitignored; deployed to CF Pages)
      package.json
      .nvmrc
```

### §II.2 Build tool: custom Node.js + Nunjucks

The apex does not use Quartz. A custom Nunjucks build gives precise per-page layout control at minimal dependency cost.

```json
{
  "name": "@skeptou/apex",
  "scripts": {
    "build": "node build/build.js",
    "watch": "node build/build.js --watch"
  },
  "dependencies": {
    "nunjucks": "^3.2.4",
    "js-yaml":  "^4.1.0",
    "marked":   "^12.0.0",
    "chokidar": "^3.6.0",
    "sharp":    "^0.33.0"
  }
}
```

`sharp` is used only during CI to generate a WebP copy of the headshot if `show_headshot: true` and `headshot.jpg` is present. Not required otherwise.

Build output target: < 5 seconds total.

### §II.3 `validate-slots.js` — content slot validation

The build script calls `validate-slots.js` after loading all YAML. It checks every **required** slot and emits a `WARN` (not a fatal error) for any that are empty. Build succeeds regardless; warnings appear in CI output so Cam can see what remains to be filled.

Required slots (warn if empty):
- `site-meta.yaml`: `tagline`, `aos[0]`
- `contact.yaml`: `email_href`, `email_display`
- `bio-home.md`: file must exist and be non-empty

Optional slots (silently skip rendering if empty/absent):
- `site-meta.yaml`: `home_recent`, `aoc`
- `contact.yaml`: `philpapers_id`, `google_scholar_id`, `orcid`, `departmental_page`, `office`
- `website/assets/headshot.jpg`: if absent, headshot block is omitted

### §II.4 Agora content checkout

Build script reads from `$AGORA_PATH` (env var set by GitHub Action):
- `$AGORA_PATH/website/` — all prose and structured data
- `$AGORA_PATH/energeia/slugs.yaml` — paper registry

Both `main` branch content (`website/`) and `energeia` branch compiled PDFs are needed for post-acceptance PDF hosting. The Action handles this via branch-aware file pulls (§II.6).

### §II.5 Cloudflare Pages project

- **Project name:** `skeptou-apex`
- **Production branch:** `main`
- **Build command:** `cd modules/apex && npm ci && npm run build`
- **Build output directory:** `modules/apex/out`
- **Custom domain:** `skeptou.com`
- **No Access policy** — fully public

### §II.6 GitHub Actions workflow

File: `.github/workflows/deploy-apex.yml`

```yaml
name: Deploy — skeptou.com (Apex)
on:
  push:
    branches: [main]
    paths: ['modules/apex/**', 'assets/branding/tokens/**']
  workflow_dispatch:
  repository_dispatch:
    types: [agora-website-updated, energeia-slugs-updated]

jobs:
  build-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Checkout agora (main)
        uses: actions/checkout@v4
        with:
          repository: <cam-github-account>/agora
          ssh-key: ${{ secrets.AGORA_DEPLOY_KEY }}
          path: agora-content
          fetch-depth: 0

      - name: Pull energeia-branch compiled PDFs
        run: |
          git -C agora-content fetch origin energeia
          git -C agora-content checkout energeia -- papers/

      - uses: actions/setup-node@v4
        with:
          node-version-file: modules/apex/.nvmrc

      - run: npm ci
        working-directory: modules/apex

      - run: node build/build.js
        working-directory: modules/apex
        env:
          AGORA_PATH: ${{ github.workspace }}/agora-content

      - uses: cloudflare/pages-action@v1
        with:
          apiToken:    ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId:   ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          projectName: skeptou-apex
          directory:   modules/apex/out
```

---

## §III. Content Architecture — `agora/website/`

All prose, metadata, and assets live in `agora/website/` on the `main` branch. The monorepo holds only build tooling and templates. Cam owns and authors all content files.

### §III.1 Directory tree and content-slot manifest

```
agora/
  website/
    site-meta.yaml          ← CAM: site-wide metadata (§III.2)
    bio-home.md             ← CAM: 2–4 sentence prose blurb for Home page
    research-overview.md    ← CAM (optional): 1–2 paragraph overview for Research page
    teaching-philosophy.md  ← CAM (optional): inline pedagogical philosophy for Teaching page
    teaching-courses.yaml   ← CAM: structured course list (§VIII)
    contact.yaml            ← CAM: email, office, profile links (§III.3)
    awards.yaml             ← CAM (optional): awards and honours (used on CV when added)
    service.yaml            ← CAM (optional): service roles (used on CV when added)
    cv-data.yaml            ← CAM (deferred): structured CV data — not used in v1
    assets/
      headshot.jpg          ← CAM (optional): academic portrait; ≤150KB; 400×500px recommended
                               omit entirely if not providing; build skips headshot block
      teaching-statement.pdf ← CAM (optional): dossier teaching statement
      syllabi/
        <code>-<term>.pdf   ← CAM: 1–3 syllabi; filenames referenced in teaching-courses.yaml
```

**Content-slot summary for Cam:**

| File | Required? | What to write |
|---|---|---|
| `bio-home.md` | Yes | 2–4 sentence prose introduction. Should name position and AOS naturally. |
| `site-meta.yaml` | Yes (partial) | Name, tagline, institution, AOS/AOC — see §III.2 |
| `contact.yaml` | Yes (email) | Public email address (spelled-out form + href) — see §III.3 |
| `research-overview.md` | No | 1–2 paragraph research overview for Research page; omit to open directly with paper list |
| `teaching-philosophy.md` | No | Inline pedagogical philosophy; omit to link to PDF only |
| `teaching-courses.yaml` | No | Course list; omit for empty Teaching page |
| `assets/headshot.jpg` | No | Photo provision is Cam's responsibility; omit to suppress headshot block |
| `assets/teaching-statement.pdf` | No | Upload PDF; omit if not sharing publicly |
| `assets/syllabi/*.pdf` | No | 1–3 syllabi PDFs; referenced from teaching-courses.yaml |

### §III.2 `site-meta.yaml`

```yaml
# CAM: fill in all fields marked "CAM:" before first deploy
# Fields left as "" or [] are silently skipped by the build

name: "Cameron Hubbard"
name_display: "Cameron Hubbard"       # as displayed in site nav and page titles

# CAM: position tagline — rendered as prose below your name on Home
# Field convention: state position naturally in a sentence, not as a labeled block
# e.g., "PhD candidate in philosophy at the University of California, Riverside"
tagline: ""

institution: "University of California, Riverside"
department: "Department of Philosophy"
department_url: ""                     # CAM: link to UCR department page

# CAM: expected degree year — used in JSON-LD and CV (when added)
position_year_expected: 2027

base_url: "https://skeptou.com"

# CAM: Areas of specialization — confirm exact phrasing
# e.g., ["Practical Philosophy", "Ethics", "Aesthetics and Agency"]
aos: []

# CAM: Areas of competence — confirm exact phrasing
# e.g., ["Moral Psychology", "Metaethics", "Philosophy of Action"]
aoc: []

# Job market flag — set true during active market cycle; set false off-cycle
# When true: job-market paper badge activates on Research page
# Anti-pattern: leaving this true after the market cycle (§XI.2)
job_market: false
job_market_cycle: ""                   # CAM: e.g., "2027–2028"; only shown when job_market: true

# CAM: Recent work callout on Home — list of up to 5 paper slugs or free-text strings
# e.g., ["style-constraint-agency", "Some other paper title"]
# Omit or leave [] to suppress the callout section entirely
home_recent: []

# Headshot: set true only when assets/headshot.jpg is present and Cam wants it displayed
# Photo provision is Cam's responsibility — this flag is a switch, not a request
# Philosophy convention: photos are optional, not expected
# No default photo will ever be added by the engineer
show_headshot: false

# CAM: site description for meta tags and JSON-LD (1–2 sentences)
description: ""
```

### §III.3 `contact.yaml`

```yaml
# CAM: fill in before first deploy — email is required

# Email displayed on site.
# Field convention: spell out the address to defeat scrapers.
# email_display is what appears in the HTML text (human-readable)
# email_href  is what goes in the mailto: attribute (actual address)
# e.g.:
#   email_display: "cameron [dot] hubbard [at] ucr [dot] edu"
#   email_href: "cameron.hubbard@ucr.edu"
email_display: ""                 # CAM: required
email_href: ""                    # CAM: required

# CAM (optional): office address — include only if Cam wants it listed
office: ""
office_url: ""                    # link to building map, optional

# CAM (optional): external profiles
# Omit (leave "") any profile not actively maintained — build skips blank entries
# Field convention: PhilPapers + Google Scholar + departmental page minimum for early-career
philpapers_id: ""                 # CAM: e.g., "hubbard-cameron"
google_scholar_id: ""             # CAM: e.g., Google Scholar user ID
orcid: ""                         # CAM: placed on CV page (when added); not Home
departmental_page: ""             # CAM: URL to UCR graduate profile page
academia_edu: ""                  # CAM (declining convention; include only if actively maintained)
```

---

## §IV. Design System — Apex

### §IV.1 CSS structure

Three CSS files produced in `out/`:

```
out/
  styles/
    design-tokens.css     ← verbatim copy from assets/branding/tokens/ at build
    apex.css              ← compiled from apex.css + apex-overrides.css
    print.css             ← print-only rules
```

`design-tokens.css` is inlined as a `<style>` block in every page's `<head>` (not a `<link>`) to eliminate a render-blocking request.

### §IV.2 Font override (apex-specific)

```css
/* apex-overrides.css — merged into apex.css at build */
:root {
  --font-body: var(--font-apex-body);   /* Cormorant replaces Borges-Gris */
}
```

Google Fonts load in `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant:ital,wght@0,300;0,400;0,600;1,300;1,400;1,600&family=Cormorant+SC:wght@300;400;600&family=Cinzel:wght@400;600&display=swap">
```

`Cormorant SC` — small-caps section headers and structural labels. `Cinzel` — display (name on Home, nav brand). When Borges public-web licensing is resolved, only `apex-overrides.css` changes.

### §IV.3 Watermark

The apex includes the background watermark, using Cam's image at `assets/branding/watermark/skeptou-watermark.png`.

**Rendering decision: fixed, cover, single instance (no tile).** Rationale: the ucr-borges LaTeX convention places one centered background element behind the text layer — a single structural mark, not a repeating pattern. Tiling would introduce visual rhythm not present in the LaTeX source and would read as a web texture rather than a document watermark. Fixed positioning keeps the image anchored while text scrolls over it, which is the correct document-like behaviour. This matches the `body::before` pattern specified in ARCHITECTURE.md §VI for private subdomains; the apex uses identical CSS, only the image path differs.

```css
/* apex.css — watermark (identical pattern to private subdomains) */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  background-image: url('/assets/branding/watermark.png');
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  opacity: var(--watermark-opacity);   /* 0.04 — from design-tokens.css */
  pointer-events: none;
  z-index: -1;
}
```

**Asset path note:** The monorepo path for this image is `assets/branding/watermark/skeptou-watermark.png` (Cam places the file). The build script copies it to `out/assets/branding/watermark.png` at build time so the CSS `url()` reference above resolves correctly without encoding the subdirectory into the stylesheet.

```javascript
// build/build.js — asset copy step
fs.copyFileSync(
  path.join(rootDir, 'assets/branding/watermark/skeptou-watermark.png'),
  path.join(outDir, 'assets/branding/watermark.png')
);
```

If the file is absent at build time, the build script emits `WARN: watermark image not found — body::before will render but background-image will 404` and continues. The CSS rule stays in the output regardless; the 404 is silent on page load (no visible error).

### §IV.4 Layout and typography

```css
/* apex.css — key rules */

body {
  background-color: var(--color-parchment);
  color: var(--color-purple);
  font-family: var(--font-body);          /* Cormorant */
  font-size: 1.125rem;
  line-height: var(--line-height);        /* 1.5 */
  hyphens: auto;
  -webkit-font-smoothing: antialiased;
}

.content-wrap {
  max-width: 68ch;
  margin-inline: auto;
  padding-inline: 1.5rem;
}

/* Section headings: small caps, Mauve, §Roman prefix */
body { counter-reset: section-counter; }
h2 {
  font-family: 'Cormorant SC', serif;
  font-weight: 400;
  color: var(--color-mauve);
  counter-increment: section-counter;
  margin-block-start: var(--section-margin-lg);
  margin-block-end: calc(var(--section-margin) / 2);
}
h2::before {
  content: '§' counter(section-counter, upper-roman) '\2002';
  color: var(--color-mauve);
}

hr.sk-rule {
  border: none;
  border-top: var(--rule-weight) solid var(--rule-color);
  margin-block: var(--section-margin);
}

strong, .wine   { color: var(--color-wine); font-weight: 600; }
.secondary      { color: var(--color-quartz); font-size: 0.9em; }

/* Paper status badge */
.status-badge {
  font-size: 0.78em;
  font-variant-caps: small-caps;
  letter-spacing: 0.06em;
  color: var(--color-quartz);
  border: var(--rule-weight) solid var(--color-quartz);
  padding: 0.1em 0.5em;
  border-radius: 2px;
  white-space: nowrap;
}
.status-badge.published    { color: var(--color-mauve); border-color: var(--color-mauve); }
.status-badge.forthcoming  { color: var(--color-steel);  border-color: var(--color-steel); }
.status-badge.job-market   { color: var(--color-wine);   border-color: var(--color-wine);  }
```

### §IV.5 Navigation

Three links (CV not in nav until Phase 5):

```
Cameron Hubbard                   Research   Teaching
```

Name in Cinzel; links in Cormorant SC (small caps). Active page: Mauve underline, `text-underline-offset: 0.2em`. Mobile (< 640px): hamburger collapses to vertical drawer, CSS-only (`<input type="checkbox">` + `<label>`; no JS required).

### §IV.6 Footer

```
────────────────────────────────────────────────
Cameron Hubbard · Department of Philosophy      [year]
```

`var(--color-quartz)` at 0.85em. Mauve rule above. No icons. No logo. No tagline.

### §IV.7 Responsive breakpoints

| Breakpoint | Behaviour |
|---|---|
| < 640px | Single column; nav collapses; 1rem padding; font 1rem |
| 640–1024px | Single column; horizontal nav; 1.25rem padding; font 1.05rem |
| > 1024px | Single column centred at 68ch; full nav |

### §IV.8 Print stylesheet

```css
@media print {
  body     { background: white; color: black; font-size: 11pt; }
  nav, footer { display: none; }
  .content-wrap { max-width: 100%; padding: 0; }
  a[href]::after { content: ' (' attr(href) ')'; font-size: 0.8em; color: #444; }
  h2::before { color: #444; }
  hr.sk-rule { border-top-color: #bbb; }
}
```

---

## §V. Page Specifications

### §V.1 Home (`/`)

**Purpose:** First impression. Communicates identity, position, AOS, and primary contact information within a 5-second scan. Contact folded here; no separate Contact page in v1.

**Field convention:** Position stated in prose, not as a labeled block. Headshot is optional and not conventional in philosophy; included only if `show_headshot: true` and `headshot.jpg` is present.

**Template:** `templates/home.njk`

**Layout:**

```
[nav]
────────────────────────────────────────────────────────

Cameron Hubbard                              [Cinzel, display]
──────────────────────────────────────       [Mauve hairline rule]

<!-- CAM: bio-home.md rendered here -->
<!-- Engineer: render bio-home.md via marked(); if file absent or empty,
     build warns "WARN: bio-home.md is empty — required slot" and
     renders nothing (no placeholder text) -->

[if show_headshot: true AND headshot.jpg present:]
  <picture>
    <source type="image/webp" srcset="/assets/headshot.webp">
    <img src="/assets/headshot.jpg" alt="Cameron Hubbard"
         width="400" height="500" loading="eager" fetchpriority="high">
  </picture>
  <!-- Right-floated on ≥640px; block above name on mobile -->
  <!-- CAM: provision headshot.jpg in website/assets/ -->

[if home_recent non-empty:]
  ────────────────────────────────────────
  Recent work

  [each entry in home_recent:]
    <!-- Slug entries resolved via loadPublicPapers(); free-text entries rendered verbatim -->
    [title]  [status badge]  [year]
    <!-- Abstract NOT shown on Home; title + status + year only -->

────────────────────────────────────────
Contact

  <!-- CAM: email rendered from contact.yaml email_display / email_href -->
  [email — spelled-out display form; mailto href]

  [if departmental_page:] [Department page link]
  [if philpapers_id:]      [PhilPapers profile link]
  [if google_scholar_id:]  [Google Scholar link]
  <!-- ORCID is on CV only per field convention; not rendered here -->

[footer]
```

**Email display pattern (anti-scraper):**

```html
<!-- Template: home.njk -->
<a href="mailto:{{ contact.email_href }}" class="email-link"
   aria-label="Email Cameron Hubbard">
  {{ contact.email_display }}
</a>
```

`email_display` is the human-readable spelled-out form Cam writes in `contact.yaml`. Scrapers reading the text see the spelled-out form; the `mailto:` href remains functional for humans.

**Data sources:** `site-meta.yaml`, `bio-home.md`, `contact.yaml`, `agora/energeia/slugs.yaml` (for `home_recent` slug resolution), `website/assets/headshot.{jpg,webp}` (conditional).

### §V.2 Research (`/research/`)

**Purpose:** Canonical record of scholarly output for hiring committees and the profession.

**Template:** `templates/research.njk`

**Field convention:** Status-grouped, reverse chronological within each group. Research statement is dossier-only; site carries a 1–2 paragraph overview (`research-overview.md`) authored by Cam, or opens directly with the paper list if omitted. Job-market paper flag activates only when `job_market: true` in `site-meta.yaml`. Pre-submission drafts not posted.

**Layout:**

```
<!-- CAM: research-overview.md rendered here if file present and non-empty -->
<!-- Engineer: if absent, skip; do not insert placeholder prose -->

[if job_market: true in site-meta.yaml:]
╔════════════════════════════════════════════════════════╗
║  Job Market Paper · [job_market_cycle]                ║
║  [job-market paper entry — full paper-entry template] ║
╚════════════════════════════════════════════════════════╝

§I  Published
    [papers with status: published — reverse chrono]
    [section omitted if no published papers]

§II  Forthcoming
    [papers with status: forthcoming — reverse chrono]
    [section omitted if no forthcoming papers]

§III  Under Review
    [papers with status: under_review]
    [section omitted if empty]

§IV  In Progress
    [papers with status: in_progress — title only; no abstract]
    [section omitted if empty]
```

Each paper entry (`templates/components/paper-entry.njk`):

```html
<article class="paper-entry">
  <h3 class="paper-title">
    "{{ paper.title }}"
    <span class="status-badge {{ paper.status }}">{{ statusLabel(paper.status) }}</span>
    {% if paper.job_market_paper and siteMeta.job_market %}
      <span class="status-badge job-market">Job Market Paper</span>
    {% endif %}
  </h3>
  {% if paper.venue and paper.status in ('published', 'forthcoming') %}
    <p class="secondary">{{ paper.venue }}{% if paper.year %} · {{ paper.year }}{% endif %}</p>
  {% endif %}
  {% if paper.abstract %}
    {# Desktop: always visible. Mobile: collapses under <details> #}
    <details class="abstract-wrap" {% if not isMobile %}open{% endif %}>
      <summary class="abstract-toggle">Abstract</summary>
      <p class="abstract">{{ paper.abstract }}</p>
    </details>
  {% endif %}
  <p class="paper-links">
    {% if paper.doi %}
      <a href="https://doi.org/{{ paper.doi }}">Published version</a>
    {% endif %}
    {% if paper.philarchive_url %}
      <a href="{{ paper.philarchive_url }}">PhilArchive</a>
    {% endif %}
    {% if paper.pdf_hosted and paper.status in ('published', 'forthcoming') %}
      <a href="/papers/{{ paper.slug }}.pdf">PDF</a>
    {% endif %}
    {% if paper.status in ('under_review', 'in_progress') %}
      <span class="secondary">
        Draft available on request —
        <a href="mailto:{{ contact.email_href }}">email</a>
      </span>
    {% endif %}
  </p>
  {% if paper.award %}
    <p class="award secondary">{{ paper.award }}</p>
  {% endif %}
</article>
<hr class="sk-rule">
```

**Data sources:** `agora/energeia/slugs.yaml` (via `ingest-slugs.js`), `research-overview.md`, `site-meta.yaml` (job_market flag, job_market_cycle), `contact.yaml` (email_href for "available on request" link).

### §V.3 Teaching (`/teaching/`)

**Purpose:** Evidence of pedagogical range for hiring committees. APA Blog standard: 1–3 sample syllabi; teaching statement; pedagogical philosophy.

**Template:** `templates/teaching.njk`

**Layout:**

```
§I  Pedagogical Philosophy
    <!-- CAM: teaching-philosophy.md rendered here if present -->
    <!-- Engineer: if absent, skip section heading and content entirely -->
    [if assets/teaching-statement.pdf present:]
      <a href="/assets/teaching-statement.pdf">Teaching statement (PDF)</a>
    <!-- Engineer: link renders only if file exists in build; no broken link -->

§II  Courses — Instructor of Record
    [teaching-courses.yaml entries where role: instructor]
    [section omitted entirely if no instructor entries]

§III  Courses — Teaching Assistant
    [teaching-courses.yaml entries where role: ta]
    [section omitted entirely if no ta entries]
```

Each course entry:

```html
<div class="course-entry">
  <p class="course-title">
    <span class="course-code secondary">{{ course.code }}</span>
    {{ course.title }}
  </p>
  <p class="secondary">
    {{ course.institution }} · {{ course.terms | formatTerms }}
    {% if course.enrolment %} · {{ course.enrolment }} students{% endif %}
  </p>
  {% if course.syllabus %}
    <p><a href="/assets/syllabi/{{ course.syllabus }}">Syllabus (PDF)</a></p>
  {% endif %}
  {% if course.eval_summary %}
    <p class="secondary">{{ course.eval_summary }}</p>
    <!-- CAM: aggregate summary only — never full numerical breakdowns -->
  {% endif %}
  {% if course.demo_video_url %}
    <p><a href="{{ course.demo_video_url }}">Teaching demo</a></p>
    <!-- Link out only; no embedded video -->
  {% endif %}
</div>
```

**Data sources:** `teaching-philosophy.md`, `teaching-courses.yaml`, `website/assets/teaching-statement.pdf`, `website/assets/syllabi/*.pdf`.

---

## §VI. Research Page — Energeia Cross-Link

### §VI.1 Apex-specific fields added to `agora/energeia/slugs.yaml`

These fields extend the existing energeia schema without affecting the energeia pipeline:

```yaml
papers:
  style-constraint-agency:
    # ... existing energeia fields ...
    # ── Apex-specific additions ──────────────────────────────────
    public: true                   # include on skeptou.com Research page
    status: under_review           # published | forthcoming | under_review | in_progress
    venue: ""                      # CAM: journal/book; only for published/forthcoming
    year: 2026                     # CAM: publication year, or year of current version
    doi: ""                        # CAM: DOI if published
    philarchive_url: ""            # CAM: PhilArchive preprint URL if posted
    philpapers_entry_id: ""        # CAM: PhilPapers bibliographic entry ID
    abstract: >                    # CAM: abstract text
      ""
    job_market_paper: false        # CAM: true during active market cycle only
    award: ""                      # CAM: e.g., "Graduate Essay Prize, Pacific APA, 2025"
    # PDF hosting: published/forthcoming only — see §VI.3
    pdf_hosted: false              # true only when status is published or forthcoming
```

### §VI.2 Build-time ingest (`build/ingest-slugs.js`)

```javascript
const yaml = require('js-yaml');
const fs   = require('fs');
const path = require('path');

const STATUS_ORDER = { published: 0, forthcoming: 1, under_review: 2, in_progress: 3 };

function loadPublicPapers(agoraPath) {
  const slugsPath = path.join(agoraPath, 'energeia', 'slugs.yaml');
  if (!fs.existsSync(slugsPath)) return [];
  const raw = yaml.load(fs.readFileSync(slugsPath, 'utf8'));
  return Object.entries(raw.papers ?? {})
    .filter(([, e]) => e.public === true)
    .map(([slug, e]) => ({ slug, ...e }))
    .sort((a, b) => {
      const sd = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
      return sd !== 0 ? sd : (b.year ?? 0) - (a.year ?? 0);
    });
}

module.exports = { loadPublicPapers };
```

### §VI.3 PDF hosting policy

**Post-acceptance papers only** (`status: published` or `status: forthcoming`) may be hosted as PDFs. If `pdf_hosted: true` the build copies `$AGORA_PATH/energeia/papers/<slug>/<slug>.pdf` to `out/papers/<slug>.pdf`.

**Pre-submission drafts (`under_review`, `in_progress`) are never hosted.** The template renders "Draft available on request — [email]" for these entries. The build script validates this at build time:

```javascript
if (paper.pdf_hosted && ['under_review', 'in_progress'].includes(paper.status)) {
  console.warn(`[apex/build] WARN: ${paper.slug} has pdf_hosted:true but status ${paper.status}. Skipping PDF copy.`);
  paper.pdf_hosted = false;
}
```

---

## §VII. Teaching Courses Structure (`teaching-courses.yaml`)

```yaml
# CAM: fill in course entries

instructor:
  - code: ""              # CAM: e.g., "PHIL 101"
    title: ""             # CAM: course title
    institution: "University of California, Riverside"
    terms:
      - quarter: ""       # CAM: e.g., "Fall"
        year:             # CAM: e.g., 2024
    enrolment:            # CAM (optional): number
    syllabus: ""          # CAM (optional): filename in website/assets/syllabi/
    eval_summary: ""      # CAM (optional): aggregate summary only — never full breakdowns
    demo_video_url: ""    # CAM (optional): link to teaching demo recording

ta:
  - code: ""
    title: ""
    instructor: ""        # CAM: instructor of record name
    institution: "University of California, Riverside"
    terms:
      - quarter: ""
        year:
```

---

## §VIII. Agora → Apex Trigger

```yaml
# agora/.github/workflows/notify-apex.yml
name: Notify apex of content update
on:
  push:
    branches: [main]
    paths: ['website/**', 'energeia/slugs.yaml']

jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@v7
        with:
          github-token: ${{ secrets.SKEPTOU_DISPATCH_PAT }}
          script: |
            await github.rest.repos.createDispatchEvent({
              owner: '<cam-github-account>',
              repo: 'skeptou',
              event_type: 'agora-website-updated',
            });
```

`SKEPTOU_DISPATCH_PAT` is a fine-grained PAT scoped to `skeptou` repo, `contents: write`. Stored as an agora Actions secret.

---

## §IX. SEO and Structured Data

### §IX.1 Per-page `<head>`

```html
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="{{ pageDescription }}">
<link rel="canonical" href="https://skeptou.com{{ pagePath }}">
<meta property="og:type" content="website">
<meta property="og:title" content="{{ pageTitle }} — Cameron Hubbard">
<meta property="og:description" content="{{ pageDescription }}">
<meta property="og:url" content="https://skeptou.com{{ pagePath }}">
{% if siteMeta.show_headshot %}
  <meta property="og:image" content="https://skeptou.com/assets/headshot.jpg">
  <meta name="twitter:card" content="summary_large_image">
{% else %}
  <meta name="twitter:card" content="summary">
{% endif %}
<meta name="twitter:title" content="{{ pageTitle }} — Cameron Hubbard">
<meta name="twitter:description" content="{{ pageDescription }}">
```

### §IX.2 JSON-LD

**Home — `Person`** (generated by `build/generate-jsonld.js`):

```json
{
  "@context": "https://schema.org",
  "@type": "Person",
  "name": "Cameron Hubbard",
  "url": "https://skeptou.com",
  "jobTitle": "PhD Candidate in Philosophy",
  "worksFor": {
    "@type": "CollegeOrUniversity",
    "name": "University of California, Riverside",
    "url": "[department_url if set]"
  },
  "alumniOf": [
    { "@type": "CollegeOrUniversity", "name": "Stanford University" },
    { "@type": "CollegeOrUniversity", "name": "University of Oxford" }
  ],
  "knowsAbout": ["[AOS entries]"],
  "email": "[email_href]",
  "sameAs": ["[philpapers URL if set]", "[google_scholar URL if set]", "[orcid URL if set]"]
}
```

`sameAs` array is built only from non-empty profile IDs in `contact.yaml`.

**Research — `ScholarlyArticle` per published/forthcoming paper:**

```json
{
  "@context": "https://schema.org",
  "@type": "ScholarlyArticle",
  "headline": "[title]",
  "author": { "@type": "Person", "name": "Cameron Hubbard", "url": "https://skeptou.com" },
  "abstract": "[abstract]",
  "datePublished": "[year]",
  "isPartOf": { "@type": "Periodical", "name": "[venue]" },
  "url": "[doi URL or philarchive_url]"
}
```

Only `published` and `forthcoming` papers emit a `ScholarlyArticle` block.

### §IX.3 Sitemap

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://skeptou.com/</loc><priority>1.0</priority></url>
  <url><loc>https://skeptou.com/research/</loc><priority>0.9</priority></url>
  <url><loc>https://skeptou.com/teaching/</loc><priority>0.7</priority></url>
</urlset>
```

### §IX.4 robots.txt

```
User-agent: *
Allow: /
Sitemap: https://skeptou.com/sitemap.xml
```

---

## §X. Performance Targets

**Lighthouse: 95+ across all four axes.**

| Technique | Implementation |
|---|---|
| No render-blocking JS | No `<script>` in `<head>`; mobile-nav JS at body end with `defer` |
| Inlined critical CSS | Design tokens + apex.css critical path inlined in `<head>` `<style>` |
| Font loading | `preconnect` to Google Fonts; `display=swap`; FOUT acceptable |
| Image optimisation | `headshot.jpg` ≤ 150KB; WebP generated at build by `sharp`; `<picture>` with `srcset`; explicit `width`/`height`; `loading="eager" fetchpriority="high"` (LCP element) — only if `show_headshot: true` |
| No headshot = no LCP image | If `show_headshot: false`, largest contentful paint is the name heading; no image LCP |
| No runtime external deps (except fonts) | All content, CSS, JS self-hosted on CF Pages |
| Immutable cache headers | CF Pages default: `Cache-Control: public, max-age=31536000, immutable` |
| TTFB | CF edge static; target < 200ms |

---

## §XI. Academic Convention Register and Anti-Patterns

### §XI.1 Conventions the spec honours

| Convention | Implementation |
|---|---|
| Position in prose, not a labeled block | `bio-home.md` is free prose; no `<label>Position:</label>` pattern in templates |
| Photos optional, not conventional | `show_headshot: false` default; no engineer-sourced photo ever added |
| Watermark at 4% opacity, fixed/cover | §IV.3 — `body::before` pattern; image from `assets/branding/watermark/skeptou-watermark.png`; matches private-subdomain convention |
| Pre-submission drafts not posted | §VI.3 — "available on request" + build-time guard |
| Email spelled out against scrapers | `email_display` / `email_href` split in `contact.yaml` |
| ORCID on CV, not landing page | `contact.yaml` `orcid` field noted as CV-placement; not rendered on Home in v1 |
| Job-market flag off-cycle by default | `job_market: false` default in `site-meta.yaml`; comment notes the anti-pattern |
| PhilPapers + Google Scholar minimum | Fields present in `contact.yaml`; build skips empty entries |
| All user-facing prose is Cam's | Content-slot policy (§I.1) — no engineer or Lead Dev drafts personal prose |

### §XI.2 Anti-patterns the spec actively prevents

| Anti-pattern | Spec safeguard |
|---|---|
| **Stale site** | Content in agora; any agora push triggers redeploy. Update friction is near-zero. |
| **AOS/position mismatch** | `site-meta.yaml` is single source for AOS and position string across all pages and JSON-LD. |
| **Decorative template feel** | No stock photos by default; no animations; no icons; hairline Mauve dividers only. |
| **No accessible papers** | Published/forthcoming: DOI or PDF link. Under review: "available on request" + email link. |
| **Uncurated talk list** | Talks not on public site in v1; in CV only when CV page added. |
| **Committee names / letter writers** | No schema field for these exists anywhere in the YAML. Cannot be accidentally added. |
| **Out-of-date current-position claim** | `tagline` and `position_year_expected` in one file; comment warns about off-cycle `job_market` flag. |
| **Engineer-authored personal prose** | §I.1 policy + `validate-slots.js` renders nothing (not placeholder text) when a slot is empty. |

---

## §XII. Accessibility

WCAG 2.1 AA minimum.

| Requirement | Implementation |
|---|---|
| Color contrast | Purple on Parchment: 13.2:1 (AAA). Mauve on Parchment: 4.6:1 (AA). All pass. |
| Focus indicators | `:focus-visible` outline, Mauve, 2px solid, 2px offset — never removed |
| Skip link | `<a href="#main-content" class="skip-link">Skip to main content</a>` — visible on focus |
| Landmarks | `<nav aria-label="Main">`, `<main id="main-content">`, `<footer>` |
| Abstract collapse on mobile | `<details>` / `<summary>` — accessible without JS |
| PDF links | All PDF links include `(PDF)` in visible text or `aria-label` |
| Email link | `aria-label="Email Cameron Hubbard"` on mailto anchor |
| Language | `<html lang="en">` — required for browser hyphens engine |

---

## §XIII. Phase 5+ Extensions

**CV page (`/cv/`):** Deferred. Integrates with the paper-sharing module (phero, Slot 3) and possibly aristeia (professional documents). `cv-data.yaml` is already specced in the content tree (§III.1) but unused in v1. When Phase 5 adds the CV page:
- Nav gains a fourth link: Research · Teaching · CV
- Sitemap gains `/cv/`
- `cv-data.yaml` Cam fills in
- `assets/cv.pdf` Cam uploads
- No structural change to the build pipeline needed; `render-cv.js` is a new build module

**Talks page (`/talks/`):** Add when the talk list warrants standalone presentation. Data already in `cv-data.yaml talks` block; Nunjucks template + nav link are the only additions.

**About / Bio page (`/about/`):** Add when Cam wants longer biographical narrative. Slots: `bio-long.md`, education from `cv-data.yaml`, awards/service from YAML files already present.

**Writing / Blog (`/writing/`):** Uncommon convention in philosophy. If added, the `home_recent` callout on Home is the appropriate early-career pattern; a dedicated blog page remains Phase 5+.

**Mellor "current position" update:** After TT offer, `tagline` in `site-meta.yaml` shifts to "currently X; assistant professor from [month] [year]" framing. One field change + redeploy.

---

## §XIV. Open Questions

| # | Question | Source | Blocks |
|---|---|---|---|
| 1 | **AOS/AOC language.** Confirm exact phrasing for `site-meta.yaml` `aos` / `aoc` arrays — feeds Home prose, JSON-LD, and (eventually) CV. | Cam | Home, JSON-LD |
| 2 | **Public email address.** Which address to expose: `@skeptou.com` iCloud alias, UCR institutional address, or dedicated alias? Populates `contact.email_display` and `contact.email_href`. | Cam | Home |
| 3 | **Headshot.** Does a suitable photo exist? `show_headshot: false` by default; no image required. Photo provision is entirely Cam's responsibility when/if desired. | Cam | Home (optional) |
| 4 | **Research overview paragraph.** Include 1–2 paragraph overview on Research page, or open directly with paper list? Cam authors if included. | Cam | Research |
| 5 | **Linked profiles.** Which of {PhilPapers, Google Scholar, ORCID, departmental page} are actively maintained? Academia.edu declining. | Cam | Home, JSON-LD |
| 6 | **Domain framing.** `skeptou.com` is thematic rather than name-based. Themed domains are viable precedent (Nguyen's `objectionable.net`, Chalmers's `consc.net`) but name-based is majority convention. Confirm intentional. | MLA | DNS, canonical URLs |
| 7 | **Teaching page: inline philosophy vs. PDF-only.** Spec defaults to: inline `teaching-philosophy.md` if present, plus optional PDF link. PDF-only (no inline text) is also common early-career. Cam's call. | MLA | Teaching |
| 8 | **`home_recent` scope.** Papers only, or papers + recent talks? YAML accepts free-text entries for talks; need to know whether to include talk entries or papers only. | Cam | Home |
