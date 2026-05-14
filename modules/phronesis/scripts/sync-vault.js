#!/usr/bin/env node
/**
 * sync-vault.js — phronesis build script
 *
 * Syncs required files from the O&P vault GitHub repo into content/.
 * Runs before Quartz build in CI (GitHub Actions step).
 *
 * iCloud .ics convention:
 *   Vault path:   calendar/icloud-export.ics
 *   Local dest:   content/calendar.ics
 *   DevOps note:  Cam exports and commits iCloud calendar to this vault path.
 *                 Filename is stable; re-export overwrites in place.
 *
 * Canonical plan-file directory:
 *   Vault path:   projects/<slug>-plan.md  (confirmed: projects/)
 *   (Plans are created by the accept Worker; sync does not read them)
 *
 * Env vars (set in GitHub Actions via repo secrets):
 *   VAULT_GITHUB_PAT  — PAT with contents:read on vault repo
 *   VAULT_REPO        — "owner/repo"
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');

const PAT          = process.env.VAULT_GITHUB_PAT;
const REPO         = process.env.VAULT_REPO;
/* VAULT_SUBTREE: prefix within the vault repo for all O&P content.
 * Set to "Organization & Planning" for the agora repo (cameronhubbard642-eng/agora).
 * All vault-relative paths are passed through vaultPath() before API calls.
 * The ghGet() function encodes each path segment individually so spaces and
 * ampersands in the folder name are handled correctly. */
const VAULT_SUBTREE = (process.env.VAULT_SUBTREE || '').replace(/\/$/, '');

if (!PAT || !REPO) {
  console.warn('sync-vault: VAULT_GITHUB_PAT or VAULT_REPO not set — skipping vault sync');
  process.exit(0);
}

/* Prefix a vault-relative path with VAULT_SUBTREE */
function vaultPath(relPath) {
  if (!VAULT_SUBTREE) return relPath;
  if (!relPath)       return VAULT_SUBTREE;
  return VAULT_SUBTREE + '/' + relPath;
}

/* ── Files to sync ────────────────────────────────────────────────────────── */
/* Format: { vaultPath, localPath, exclude: bool }
 * exclude=true means the file is fetched but marked draft (not rendered as page) */
const SYNC_MAP = [
  { vault: 'PROJECT_MANIFEST.md',            local: 'content/manifest.md' },
  { vault: 'INVENTORY.md',                   local: 'content/inventory.md' },
  { vault: 'COMMITMENTS.md',                 local: 'content/commitments.md',    exclude: true },
  /* Calendar is a markdown export from macOS Calendar via AppleScript.
   * Vault path: commitments/calendar-sync.md
   * aggregate-busy.js reads content/calendar-sync.md and parses this format. */
  { vault: 'commitments/calendar-sync.md',   local: 'content/calendar-sync.md',  exclude: true }
];

/* Opportunity files: opp-*.md live in projects/ (not at vault root).
 * Fetch listing of projects/, then each opp-*.md file found there. */
const OPP_PREFIX     = 'opp-';
const OPP_DIR        = 'content/opportunities';
const OPP_VAULT_DIR  = 'projects';

/* ─────────────────────────────────────────────────────────────────────────────
 * RECURRING-TASK EXTRACTOR
 *
 * Convention (confirmed 2026-05-13):
 *   Master line  — one per recurring event, NO [due:: ...]:
 *     - [ ] Phil 003 — Reply to emails [recurring:: every week on Sunday] [priority:: high]
 *     - [ ] Gym — Saturday [recurring:: every week on Saturday] [time:: 13:00-15:30]
 *   Exception line — [-] or [x] with [due:: YYYY-MM-DD], title matches master:
 *     - [-] Gym — Saturday [due:: 2026-05-10]        (cancelled instance)
 *     - [x] Gym — Saturday [due:: 2026-05-17]        (completed instance)
 *
 * Supported recurrence specs:
 *   "every week on {Day}"      — weekly on a specific day
 *   "every {Day}"              — shorthand for the above
 *   "every {N} weeks on {Day}" — every N weeks
 *   "every weekday"            — Mon–Fri
 *   "every week"               — unanchored (flags for diagnosis, no expansion)
 *   "monthly on the {Nth}"     — e.g. "monthly on the 15th"
 *   "daily" / "every day"      — daily
 *   (freeform fallback: flags for diagnosis, returns empty expansion)
 *
 * Look-ahead window:  RECUR_LOOKAHEAD_DAYS env var (default 14).
 * Calendar authority: content/calendar-sync.md is ground truth for iCloud events.
 *                     Masters in other files are supplements.
 *                     Day-of-week mismatches between master spec and calendar
 *                     are logged to src/data/recurring-drift.json.
 * ───────────────────────────────────────────────────────────────────────────── */

/** Look-ahead window for recurring instance expansion (days). Configurable. */
const RECUR_LOOKAHEAD_DAYS = parseInt(process.env.RECUR_LOOKAHEAD_DAYS || '14', 10);

/** Day-of-week name → 0-based index (0 = Sunday). Accepts full names and 3-letter abbreviations. */
const DOW_NAMES = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6
};

/** Today as YYYY-MM-DD in local time (matches what Cam sees in Obsidian). */
function isoToday() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  ].join('-');
}

/** Add n days to an ISO date string, using noon-UTC to avoid DST surprises. */
function isoAddDays(isoDate, n) {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Parse a recurrence spec string into a structured rule.
 * Returns a rule object, or null for unrecognized patterns.
 *
 * Rule shapes:
 *   { type: 'weekly',           dow: 0-6, every: N }
 *   { type: 'weekly-unanchored'                    }
 *   { type: 'weekday'                              }
 *   { type: 'monthly',          dom: 1-31          }
 *   { type: 'daily'                                }
 */
function parseRecurrenceSpec(spec) {
  if (!spec) return null;
  const s = spec.toLowerCase().trim();

  /* "every week on {Day}" or "every {Day}" shorthand */
  let m = /^every week on (\w+)$/.exec(s);
  if (!m) m = /^every (\w+)$/.exec(s);
  if (m && DOW_NAMES[m[1]] !== undefined) {
    return { type: 'weekly', dow: DOW_NAMES[m[1]], every: 1 };
  }

  /* "every {N} weeks on {Day}" */
  m = /^every (\d+) weeks? on (\w+)$/.exec(s);
  if (m && DOW_NAMES[m[2]] !== undefined) {
    const n = parseInt(m[1], 10);
    if (n > 0) return { type: 'weekly', dow: DOW_NAMES[m[2]], every: n };
  }

  /* "every weekday" */
  if (s === 'every weekday') return { type: 'weekday' };

  /* "every week" — weekly but no anchor day */
  if (s === 'every week') return { type: 'weekly-unanchored' };

  /* "monthly on the {Nth}" */
  m = /^monthly on the (\d+)(?:st|nd|rd|th)?$/.exec(s);
  if (m) return { type: 'monthly', dom: parseInt(m[1], 10) };

  /* "daily" / "every day" */
  if (s === 'daily' || s === 'every day') return { type: 'daily' };

  return null; /* unrecognized */
}

/**
 * Expand a recurrence spec into ISO date strings within [today, today+lookaheadDays].
 * @returns {{ dates: string[], unrecognized?: true, unanchored?: true }}
 */
function expandRecurrenceDates(spec, today, lookaheadDays) {
  const rule = parseRecurrenceSpec(spec);
  if (!rule) return { dates: [], unrecognized: true };
  if (rule.type === 'weekly-unanchored') return { dates: [], unanchored: true };

  const endDate = isoAddDays(today, lookaheadDays);
  const dates   = [];

  if (rule.type === 'weekly') {
    const startDow = new Date(today + 'T12:00:00Z').getUTCDay();
    const offset   = (rule.dow - startDow + 7) % 7; /* 0 = today if already the right day */
    let cursor = isoAddDays(today, offset);
    while (cursor <= endDate) {
      dates.push(cursor);
      cursor = isoAddDays(cursor, rule.every * 7);
    }
  } else if (rule.type === 'weekday') {
    for (let i = 0; i <= lookaheadDays; i++) {
      const d   = isoAddDays(today, i);
      const dow = new Date(d + 'T12:00:00Z').getUTCDay();
      if (dow >= 1 && dow <= 5) dates.push(d);
    }
  } else if (rule.type === 'monthly') {
    /* Check current month plus two more (covers any 14-day window) */
    const base = new Date(today + 'T12:00:00Z');
    for (let mo = 0; mo <= 2; mo++) {
      const year  = base.getUTCFullYear() + Math.floor((base.getUTCMonth() + mo) / 12);
      const month = (base.getUTCMonth() + mo) % 12;
      const cand  = new Date(Date.UTC(year, month, rule.dom));
      if (cand.getUTCMonth() !== month) continue; /* overflow, e.g. Feb 31 */
      const iso = cand.toISOString().slice(0, 10);
      if (iso >= today && iso <= endDate) dates.push(iso);
    }
  } else if (rule.type === 'daily') {
    for (let i = 0; i <= lookaheadDays; i++) {
      dates.push(isoAddDays(today, i));
    }
  }

  return { dates };
}

/* ── GitHub Contents API (minimal, stdlib only) ─────────────────────────── */
/* Encode each path segment individually so folder names containing spaces or
 * special characters (e.g. "Organization & Planning") are handled correctly.
 * encodeURIComponent on the whole path would also encode '/' separators. */
function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

function ghGet(vaultPath) {
  return new Promise((resolve, reject) => {
    const url = `https://api.github.com/repos/${REPO}/contents/${encodePath(vaultPath)}`;
    const opts = {
      headers: {
        'Authorization': `Bearer ${PAT}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'phronesis-sync'
      }
    };

    https.get(url, opts, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode !== 200) return reject(new Error(`GET ${vaultPath}: ${res.statusCode}`));
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`JSON parse error for ${vaultPath}: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

async function fetchFile(vaultPath) {
  const data = await ghGet(vaultPath);
  if (!data) return null;
  if (Array.isArray(data)) return null; /* Directory listing, not a file */
  const content = Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8');
  return content;
}

async function fetchDirListing(vaultPath) {
  const data = await ghGet(vaultPath);
  if (!Array.isArray(data)) return [];
  return data;
}

/* ── Sync a single file ──────────────────────────────────────────────────── */
async function syncFile(vaultPath, localPath, exclude) {
  const absLocal = path.join(ROOT, localPath);
  fs.mkdirSync(path.dirname(absLocal), { recursive: true });

  const content = await fetchFile(vaultPath);
  if (content === null) {
    console.warn(`sync-vault: not found in vault — ${vaultPath} (skipping)`);
    return;
  }

  /* If excluded from Quartz rendering, inject draft: true into markdown frontmatter */
  let toWrite = content;
  if (exclude && localPath.endsWith('.md')) {
    toWrite = injectDraft(content);
  }

  fs.writeFileSync(absLocal, toWrite);
  console.log(`sync-vault: ${vaultPath} → ${localPath}`);
}

/* Inject draft: true into YAML frontmatter so Quartz doesn't render the file as a page */
function injectDraft(raw) {
  if (raw.startsWith('---')) {
    const closeIdx = raw.indexOf('\n---', 3);
    if (closeIdx !== -1) {
      const fm    = raw.slice(0, closeIdx);
      const rest  = raw.slice(closeIdx);
      if (!fm.includes('draft:')) {
        return fm + '\ndraft: true' + rest;
      }
      return raw;
    }
  }
  /* No frontmatter — prepend one */
  return '---\ndraft: true\n---\n' + raw;
}

/* ── Main ────────────────────────────────────────────────────────────────── */
async function main() {
  console.log(`sync-vault: syncing from ${REPO}`);

  /* Sync fixed files */
  for (const { vault, local, exclude } of SYNC_MAP) {
    try {
      await syncFile(vaultPath(vault), local, exclude);
    } catch (e) {
      console.error(`sync-vault: error syncing ${vault} —`, e.message);
    }
  }

  /* Sync opp-*.md files from projects/ subdirectory */
  try {
    const listing = await fetchDirListing(vaultPath(OPP_VAULT_DIR));
    const oppFiles = listing.filter(f => f.name && f.name.startsWith(OPP_PREFIX) && f.name.endsWith('.md'));

    fs.mkdirSync(path.join(ROOT, OPP_DIR), { recursive: true });

    for (const f of oppFiles) {
      try {
        await syncFile(f.path, `${OPP_DIR}/${f.name}`, false);
      } catch (e) {
        console.error(`sync-vault: error syncing ${f.path} —`, e.message);
      }
    }

    console.log(`sync-vault: synced ${oppFiles.length} opportunity files`);
  } catch (e) {
    console.error('sync-vault: error listing vault root —', e.message);
  }

  /* Write manifest-stats.json + opportunities.json from synced opp markdown */
  /* Agora status conventions for opp files:
   *   "active"             → Cam hasn't decided yet   → pending-cam-decision
   *   "confirmed-pursuing" → Cam accepted via Worker  → confirmed-pursuing
   *   "declined"           → Cam rejected via Worker  → declined           */
  try {
    const oppDir = path.join(ROOT, OPP_DIR);
    if (fs.existsSync(oppDir)) {
      /* Only process opp-*.md files — guards against stale placeholder files
       * (e.g. index.md, opp-sample.md) that were committed to the repo and
       * would otherwise produce bogus slugs like "index" or "sample". */
      const oppFiles = fs.readdirSync(oppDir).filter(f => f.startsWith('opp-') && f.endsWith('.md'));
      let pending = 0, confirmed = 0, active = 0;
      const opportunities = [];

      for (const f of oppFiles) {
        const raw    = fs.readFileSync(path.join(oppDir, f), 'utf8');
        const rawStatus = extractFrontmatterField(raw, 'status') || 'active';
        /* Map vault status → phronesis decision status */
        const status = rawStatus === 'active'             ? 'pending-cam-decision'
                     : rawStatus === 'confirmed-pursuing' ? 'confirmed-pursuing'
                     : rawStatus === 'declined'           ? 'declined'
                     :                                     'pending-cam-decision';

        /* Slug: derive from filename, never from frontmatter slug field which
         * includes the opp- prefix (frontmatter slug = "opp-apa-central-2027"
         * but the accept/reject Workers expect slug WITHOUT the prefix). */
        const slug = f.replace(/^opp-/, '').replace(/\.md$/, '');

        /* Prestige: agora stores a 0-100 score; convert to label for the card */
        const prestigeScore = Number(extractFrontmatterField(raw, 'prestige') || 0);
        const prestige = prestigeText(prestigeScore);

        opportunities.push({
          slug,
          title:       extractFrontmatterField(raw, 'title') || humanizeSlug(slug),
          /* opportunity_class is more descriptive than generic "opportunity" */
          type:        extractFrontmatterField(raw, 'opportunity_class') ||
                       extractFrontmatterField(raw, 'type') || 'opportunity',
          status,
          deadline:    extractFrontmatterField(raw, 'deadline') || null,
          prestige,
          requirement: extractFrontmatterField(raw, 'requirement') || '',
          /* agora opp files have no description field; use next_action as proxy */
          description: extractFrontmatterField(raw, 'next_action') || ''
        });

        if (status === 'pending-cam-decision') pending++;
        if (status === 'confirmed-pursuing')   { confirmed++; active++; }
      }

      const dataDir = path.join(ROOT, 'src', 'data');
      fs.mkdirSync(dataDir, { recursive: true });

      fs.writeFileSync(path.join(dataDir, 'manifest-stats.json'), JSON.stringify({
        active_projects: active,
        pending_decisions: pending,
        confirmed_pursuing: confirmed
      }, null, 2));
      console.log('sync-vault: wrote manifest-stats.json');

      fs.writeFileSync(path.join(dataDir, 'opportunities.json'),
        JSON.stringify(opportunities, null, 2));
      console.log(`sync-vault: wrote ${opportunities.length} opportunities → src/data/opportunities.json`);
    }
  } catch (e) {
    console.error('sync-vault: opp data error —', e.message);
  }

  /* Extract tasks from all vault markdown files */
  try {
    await extractTasks();
  } catch (e) {
    console.error('sync-vault: task extraction error —', e.message);
  }

  /* Build manifest.json from proj-*.md project files */
  try {
    await extractProjects();
  } catch (e) {
    console.error('sync-vault: project extraction error —', e.message);
  }

  /* Build inventory.json from inventory/ category files */
  try {
    await extractInventory();
  } catch (e) {
    console.error('sync-vault: inventory extraction error —', e.message);
  }

  console.log('sync-vault: done');
}

/* ── Git Trees API — single call returns full recursive tree ─────────────── */
function ghGetTree() {
  return new Promise((resolve, reject) => {
    const url  = `https://api.github.com/repos/${REPO}/git/trees/HEAD?recursive=1`;
    const opts = {
      headers: {
        'Authorization': `Bearer ${PAT}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'phronesis-sync'
      }
    };
    https.get(url, opts, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`GET git/trees: ${res.statusCode}`));
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('JSON parse error for git/trees: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

/* ── Task extraction — full subtree walk via Git Trees API ─────────────── */
/* Supports two interchangeable syntaxes — both produce identical records.
 *
 * Emoji format (legacy):
 *   - [ ] Task title 📅 2026-06-15 🔺
 *   Priority:  🔺 high · ⏫ medium · 🔼 low  (anywhere in line)
 *   Due date:  📅 YYYY-MM-DD  OR  (due: YYYY-MM-DD)
 *   Scheduled: 🛫 YYYY-MM-DD
 *   Recurring: 🔁 [interval]
 *
 * Dataview field format (new — Obsidian Dataview plugin convention):
 *   - [ ] Task title [due:: 2026-06-15] [priority:: high]
 *   Due:       [due:: YYYY-MM-DD]
 *   Priority:  [priority:: high|medium|low]
 *   Scheduled: [scheduled:: YYYY-MM-DD]
 *   Recurring: [recurring:: interval]
 *   Time:      [time:: HH:MM-HH:MM]    (for recurring events with a fixed time)
 *
 * Master recurring tasks (new convention, 2026-05-13):
 *   - [ ] Gym [recurring:: every week on Saturday] [time:: 13:00-15:30]
 *   NO [due:: ...] on the master line.  Extractor expands into RECUR_LOOKAHEAD_DAYS
 *   concrete instances.  Exception lines ([-] or [x] with [due:: ...] and
 *   a matching title) suppress the corresponding date from expansion.
 *
 * Both formats can appear in the same file (migration window compatibility).
 *
 * Task ID:
 *   Regular task:          base64url(filePath + '\x00' + cleanTitle)
 *   Expanded instance:     base64url(filePath + '\x00' + cleanTitle + '\x00' + date)
 * vaultRelativePath does NOT include VAULT_SUBTREE — Workers apply it.
 */
async function extractTasks() {
  const treeData      = await ghGetTree();
  const subtreePrefix = VAULT_SUBTREE ? VAULT_SUBTREE + '/' : '';

  const mdFiles = (treeData.tree || []).filter(function(item) {
    if (item.type !== 'blob') return false;
    if (!item.path.endsWith('.md')) return false;
    if (subtreePrefix && !item.path.startsWith(subtreePrefix)) return false;
    return !item.path.split('/').some(function(seg) { return seg.startsWith('.'); });
  });

  const tasks      = [];
  const driftLog   = [];  /* flags for recurring-drift.json */
  const allMasters = [];  /* collected across all files for calendar drift check */
  const today      = isoToday();

  for (const item of mdFiles) {
    try {
      const content = await fetchFile(item.path);
      if (!content) continue;

      const vaultRelativePath = subtreePrefix ? item.path.slice(subtreePrefix.length) : item.path;
      const fileName = vaultRelativePath.split('/').pop().replace(/\.md$/, '');
      const project  = humanizeSlug(fileName.replace(/-plan$/, '').replace(/^opp-/, ''));

      const { tasks: fileTasks, masters: fileMasters } =
        parseFileTasks(content, vaultRelativePath, project, today, driftLog);

      tasks.push(...fileTasks);
      allMasters.push(...fileMasters);
    } catch (e) {
      console.error(`sync-vault: task parse error ${item.path} —`, e.message);
    }
  }

  /* ── Calendar drift detection ─────────────────────────────────────────── */
  /* calendar-sync.md is synced earlier in main(); read it from disk here.  */
  const calSyncPath = path.join(ROOT, 'content', 'calendar-sync.md');
  if (fs.existsSync(calSyncPath)) {
    try {
      const calContent = fs.readFileSync(calSyncPath, 'utf8');
      const calEvents  = parseCalendarSyncForDrift(calContent, today, RECUR_LOOKAHEAD_DAYS);
      const calDrift   = detectCalendarDrift(allMasters, calEvents);
      driftLog.push(...calDrift);
    } catch (e) {
      console.warn('sync-vault: calendar-sync drift detection error —', e.message);
    }
  }

  /* ── Write tasks.json ─────────────────────────────────────────────────── */
  const tasksPath = path.join(ROOT, 'src', 'data', 'tasks.json');
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(tasksPath, JSON.stringify(tasks, null, 2), 'utf8');
  console.log(`sync-vault: wrote ${tasks.length} tasks → src/data/tasks.json`);

  /* ── Write recurring-drift.json ───────────────────────────────────────── */
  const driftPath = path.join(ROOT, 'src', 'data', 'recurring-drift.json');
  fs.writeFileSync(driftPath, JSON.stringify(driftLog, null, 2), 'utf8');
  if (driftLog.length > 0) {
    console.warn(`sync-vault: ⚠ ${driftLog.length} recurring drift/diagnosis flag(s) → src/data/recurring-drift.json`);
  } else {
    console.log('sync-vault: no recurring drift flags');
  }
}

/* ── Per-file task parser (called by extractTasks for each .md file) ──────── */
/**
 * Two-pass parse of a single file's task lines.
 *
 * Pass 1 — classify each task line as:
 *   MASTER           — has [recurring:: ...], NO [due:: ...], open checkbox ([ ])
 *   OLD-STYLE RECUR  — has BOTH [recurring:: ...] AND [due:: ...] (backward compat)
 *   EXCEPTION CAND.  — [-] or [x] with [due:: ...] and no [recurring:: ...]
 *   REGULAR          — everything else
 *
 * Pass 2 — resolve exception candidates against masters:
 *   If title matches a master → EXCEPTION (add to exception set; emit [x] as
 *   completed task, suppress [-])
 *   If no match → emit as regular task
 *
 * Pass 3 — expand each MASTER into concrete instances within the look-ahead
 *   window, filtering out exception dates.
 *
 * @param {string}   content            Raw file content
 * @param {string}   vaultRelativePath  Vault-relative file path
 * @param {string}   project            Human-readable project label
 * @param {string}   today              ISO date string (YYYY-MM-DD)
 * @param {Object[]} driftLog           Mutable array; push diagnostic flags here
 * @returns {{ tasks: Object[], masters: Object[] }}
 */
function parseFileTasks(content, vaultRelativePath, project, today, driftLog) {
  const masters      = []; /* { titleClean, spec, priority, time } */
  const excCands     = []; /* { titleClean, due, marker, priority, time, scheduled } */
  const regularTasks = []; /* fully-formed task records */

  /* ── Pass 1: scan lines ─────────────────────────────────────────────────── */
  for (const rawLine of content.split('\n')) {
    /* Accept [ ], [x], [-], [/] task markers */
    const m = /^- \[([ x\-\/])\] (.+)$/.exec(rawLine.trim());
    if (!m) continue;

    const marker   = m[1]; /* ' ', 'x', '-', '/' */
    let   titleRaw = m[2].trim();

    /* ── Due date: [due:: YYYY-MM-DD] > 📅 YYYY-MM-DD > (due: YYYY-MM-DD) ── */
    let due = null;
    const dueDV = /\[due::\s*(\d{4}-\d{2}-\d{2})\s*\]/.exec(titleRaw);
    const dueEM = /(?:📅\s*|\(due:\s*)(\d{4}-\d{2}-\d{2})\)?/.exec(titleRaw);
    if (dueDV) { due = dueDV[1]; titleRaw = titleRaw.replace(dueDV[0], '').trim(); }
    else if (dueEM) { due = dueEM[1]; titleRaw = titleRaw.replace(dueEM[0], '').trim(); }

    /* ── Scheduled: [scheduled:: YYYY-MM-DD] or 🛫 YYYY-MM-DD ─────────────── */
    let scheduled = null;
    const schedDV = /\[scheduled::\s*(\d{4}-\d{2}-\d{2})\s*\]/.exec(titleRaw);
    const schedEM = /🛫\s*(\d{4}-\d{2}-\d{2})/.exec(titleRaw);
    if (schedDV) { scheduled = schedDV[1]; titleRaw = titleRaw.replace(schedDV[0], '').trim(); }
    else if (schedEM) { scheduled = schedEM[1]; titleRaw = titleRaw.replace(schedEM[0], '').trim(); }

    /* ── Recurring: [recurring:: spec] or 🔁 spec ───────────────────────── */
    let recurring = null;
    const recurDV = /\[recurring::\s*([^\]]*)\]/.exec(titleRaw);
    const recurEM = /🔁\s*([^\s📅🔺⏫🔼🛫]*)/.exec(titleRaw);
    if (recurDV) { recurring = recurDV[1].trim() || 'yes'; titleRaw = titleRaw.replace(recurDV[0], '').trim(); }
    else if (recurEM) { recurring = recurEM[1].trim() || 'yes'; titleRaw = titleRaw.replace(recurEM[0], '').trim(); }

    /* ── Priority: [priority:: high|medium|low] or 🔺/⏫/🔼/🔽 ─────────── */
    let priority = 'low';
    const priDV = /\[priority::\s*(high|medium|low)\s*\]/i.exec(titleRaw);
    if (priDV) { priority = priDV[1].toLowerCase(); titleRaw = titleRaw.replace(priDV[0], '').trim(); }
    else if (/🔺/.test(titleRaw)) priority = 'high';
    else if (/⏫/.test(titleRaw)) priority = 'medium';

    /* ── Time: [time:: HH:MM-HH:MM] (new field for recurring events) ──────── */
    let time = null;
    const timeDV = /\[time::\s*([^\]]*)\]/.exec(titleRaw);
    if (timeDV) { time = timeDV[1].trim(); titleRaw = titleRaw.replace(timeDV[0], '').trim(); }

    /* ── Strip remaining metadata ───────────────────────────────────────── */
    titleRaw = titleRaw
      .replace(/\[[a-z_]+::[^\]]*\]/gi, '')         /* leftover [field:: value] */
      .replace(/✅\s*\d{4}-\d{2}-\d{2}/g, '')        /* ✅ completion date */
      .replace(/❌\s*\d{4}-\d{2}-\d{2}/g, '')        /* ❌ cancellation date */
      .replace(/⏰\s*\d{2}:\d{2}/g, '')              /* ⏰ time reminder */
      .replace(/[🔺⏫🔼🔽🔁🛫📅]/gu, '')              /* task-syntax emojis */
      .replace(/\s{2,}/g, ' ')
      .trim();

    const complete = (marker === 'x');

    /* ── Classify ───────────────────────────────────────────────────────── */

    /* MASTER: [recurring:: ...], no [due:: ...], open checkbox */
    if (recurring && !due && marker === ' ') {
      masters.push({ titleClean: titleRaw, spec: recurring, priority, time });
      continue;
    }

    /* OLD-STYLE: has BOTH [recurring:: ...] AND [due:: ...] → emit as-is */
    if (recurring && due) {
      const id = Buffer.from(vaultRelativePath + '\x00' + titleRaw).toString('base64url');
      regularTasks.push({
        id, title: titleRaw, project, filePath: vaultRelativePath,
        due, priority, complete,
        ...(scheduled && { scheduled }),
        recurring
      });
      continue;
    }

    /* EXCEPTION CANDIDATE: [-] or [x] with [due:: ...] and no [recurring:: ...]
     * May match a master in Pass 2; defer decision. */
    if ((marker === '-' || marker === 'x') && due && !recurring) {
      excCands.push({ titleClean: titleRaw, due, marker, priority, time, scheduled });
      continue;
    }

    /* REGULAR task */
    const id = Buffer.from(vaultRelativePath + '\x00' + titleRaw).toString('base64url');
    regularTasks.push({
      id, title: titleRaw, project, filePath: vaultRelativePath,
      due, priority, complete,
      ...(scheduled && { scheduled }),
      ...(time && { time })
    });
  }

  /* ── Pass 2: resolve exception candidates ──────────────────────────────── */
  const masterTitleSet = new Set(masters.map(function(ms) { return ms.titleClean.toLowerCase(); }));

  /* exceptions: Map<lowerTitle, Set<isoDate>> */
  const exceptions = new Map();

  for (const cand of excCands) {
    const lowerTitle = cand.titleClean.toLowerCase();

    if (masterTitleSet.has(lowerTitle)) {
      /* Confirmed exception — add date to exception set */
      if (!exceptions.has(lowerTitle)) exceptions.set(lowerTitle, new Set());
      exceptions.get(lowerTitle).add(cand.due);

      /* [x] completed instance: still emit as completed task */
      if (cand.marker === 'x') {
        const id = Buffer.from(
          vaultRelativePath + '\x00' + cand.titleClean + '\x00' + cand.due
        ).toString('base64url');
        regularTasks.push({
          id, title: cand.titleClean, project, filePath: vaultRelativePath,
          due: cand.due, priority: cand.priority, complete: true,
          ...(cand.scheduled && { scheduled: cand.scheduled }),
          ...(cand.time && { time: cand.time }),
          recurring_instance: true
        });
      }
      /* [-] cancelled instance: suppressed entirely */

    } else {
      /* No matching master — emit as a regular task */
      const id = Buffer.from(vaultRelativePath + '\x00' + cand.titleClean).toString('base64url');
      regularTasks.push({
        id, title: cand.titleClean, project, filePath: vaultRelativePath,
        due: cand.due, priority: cand.priority,
        complete: (cand.marker === 'x'),
        ...(cand.scheduled && { scheduled: cand.scheduled }),
        ...(cand.time && { time: cand.time })
      });
    }
  }

  /* ── Pass 3: expand masters into concrete instances ────────────────────── */
  const expandedTasks = [];

  for (const master of masters) {
    const { dates, unrecognized, unanchored } =
      expandRecurrenceDates(master.spec, today, RECUR_LOOKAHEAD_DAYS);

    if (unrecognized) {
      driftLog.push({
        type: 'unrecognized-recurrence-spec',
        event: master.titleClean,
        spec: master.spec,
        filePath: vaultRelativePath,
        note: 'Spec not recognized — no instances generated. Check for typos or add support.'
      });
      continue;
    }
    if (unanchored) {
      driftLog.push({
        type: 'unanchored-recurrence-spec',
        event: master.titleClean,
        spec: master.spec,
        filePath: vaultRelativePath,
        note: '"every week" without a day anchor cannot be expanded. Use "every week on {Day}".'
      });
      continue;
    }

    const exSet       = exceptions.get(master.titleClean.toLowerCase()) || new Set();
    const activeDates = dates.filter(function(d) { return !exSet.has(d); });

    for (const date of activeDates) {
      const id = Buffer.from(
        vaultRelativePath + '\x00' + master.titleClean + '\x00' + date
      ).toString('base64url');
      expandedTasks.push({
        id,
        title:              master.titleClean,
        project,
        filePath:           vaultRelativePath,
        due:                date,
        priority:           master.priority,
        complete:           false,
        recurring:          master.spec,
        recurring_expanded: true,  /* flag: generated by extractor, not written in vault */
        ...(master.time && { time: master.time })
      });
    }
  }

  return {
    tasks:   [...regularTasks, ...expandedTasks],
    masters: masters.map(function(ms) {
      return Object.assign({}, ms, { filePath: vaultRelativePath, project });
    })
  };
}

/* ── Calendar-sync drift detection ────────────────────────────────────────── */
/**
 * Parse calendar-sync.md events for the look-ahead window.
 *
 * Expected format (per aggregate-busy.js convention):
 *   - YYYY-MM-DD (Day)  [HH:MM–HH:MM  ]Title
 *
 * @returns {{ date: string, title: string, time: string|null }[]}
 */
function parseCalendarSyncForDrift(content, today, lookaheadDays) {
  const endDate = isoAddDays(today, lookaheadDays);
  const events  = [];

  for (const rawLine of content.split('\n')) {
    const m = /^-\s+(\d{4}-\d{2}-\d{2})\s+\([^)]+\)\s+(?:(\d{1,2}:\d{2}[–\-]\d{1,2}:\d{2})\s+)?(.+)$/.exec(rawLine.trim());
    if (!m) continue;
    const date = m[1];
    if (date < today || date > endDate) continue;
    events.push({ date, time: m[2] || null, title: m[3].trim() });
  }

  return events;
}

/**
 * Detect drift between master recurring tasks and calendar-sync.md events.
 *
 * Only "day-shift" drift is flagged (master says Wednesday, calendar says Thursday).
 * "Missing in calendar" is NOT drift — masters may supplement non-iCloud events.
 *
 * When both sources reference the same event, calendar-sync.md is authoritative.
 *
 * @param {{ titleClean, spec, filePath }[]} masters
 * @param {{ date, title }[]}               calEvents
 * @returns {Object[]} drift log entries
 */
function detectCalendarDrift(masters, calEvents) {
  const DOW_LABELS  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const driftEntries = [];

  for (const master of masters) {
    const rule = parseRecurrenceSpec(master.spec);
    /* Only check weekly rules — those have a clear expected day of week */
    if (!rule || rule.type !== 'weekly') continue;

    const masterLower = master.titleClean.toLowerCase();

    /* Find calendar events whose title fuzzy-matches the master title */
    const matchingEvents = calEvents.filter(function(ev) {
      const evLower = ev.title.toLowerCase();
      return evLower.includes(masterLower) || masterLower.includes(evLower);
    });

    if (matchingEvents.length === 0) continue; /* not in calendar — not drift */

    for (const ev of matchingEvents) {
      const evDow = new Date(ev.date + 'T12:00:00Z').getUTCDay();
      if (evDow !== rule.dow) {
        driftEntries.push({
          type:        'day-shift',
          event:       master.titleClean,
          masterSpec:  master.spec,
          masterDow:   DOW_LABELS[rule.dow],
          calendarDow: DOW_LABELS[evDow],
          calendarDate: ev.date,
          filePath:    master.filePath,
          note: `Master expects every ${DOW_LABELS[rule.dow]} but calendar shows ${ev.title} on ${DOW_LABELS[evDow]} (${ev.date}). calendar-sync.md is authoritative.`
        });
      }
    }
  }

  return driftEntries;
}

function humanizeSlug(slug) {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
}

function extractFrontmatterField(raw, field) {
  const re = new RegExp(`^${field}:\\s*(.+)$`, 'm');
  const m = re.exec(raw);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

/* Map a 0-100 prestige score to a human label for display */
function prestigeText(score) {
  if (!score || score <= 0) return '';
  if (score >= 80) return `Very high (${score}/100)`;
  if (score >= 60) return `High (${score}/100)`;
  if (score >= 40) return `Medium (${score}/100)`;
  return `Low (${score}/100)`;
}

/* Extract priority from manifest/opp rich-text priority strings.
 * Patterns: "🔺 P1 ...", "⏫ P1 (proposed)...", "🔼 P2...", "Highest...",
 *           "[priority:: high]" (dataview field format) */
function parsePriority(raw) {
  if (!raw) return 'medium';
  const dvMatch = /\[priority::\s*(high|medium|low)\s*\]/i.exec(raw);
  if (dvMatch) return dvMatch[1].toLowerCase();
  if (/🔺/.test(raw) || /highest/i.test(raw)) return 'high';
  if (/⏫/.test(raw)) return 'medium';
  if (/🔼/.test(raw)) return 'low';
  return 'medium';
}

/* ── Project extraction (non-opp .md files from vault projects/ dir) ─────── */
/* Builds src/data/manifest.json: { active: [{title, type, status, ...}] }   */
/* All non-opp-*.md files are candidates; status: done|reference are skipped. */
async function extractProjects() {
  const listing = await fetchDirListing(vaultPath(OPP_VAULT_DIR));
  const allMd     = listing.filter(f => f.name && f.name.endsWith('.md'));
  /* Include every non-opp .md file; opp-*.md are handled by extractOpportunities() */
  const projFiles = allMd.filter(f => !f.name.startsWith('opp-'));

  console.log(`sync-vault: found ${projFiles.length} proj-*.md files in vault`);
  const projects = [];
  for (const f of projFiles) {
    try {
      const content = await fetchFile(f.path);
      if (!content) continue;
      const status   = extractFrontmatterField(content, 'status') || 'active';
      if (status === 'done' || status === 'reference') {
        console.log(`sync-vault: skipping ${f.name} (status: ${status})`);
        continue;
      }
      const priority = parsePriority(extractFrontmatterField(content, 'priority') || '');
      const title    = extractFrontmatterField(content, 'title') ||
        humanizeSlug(f.name.replace(/^proj-/, '').replace(/\.md$/, ''));
      projects.push({
        title,
        type:     extractFrontmatterField(content, 'type')   || 'project',
        status,
        priority,
        deadline: extractFrontmatterField(content, 'deadline') || null,
        domain:   extractFrontmatterField(content, 'domain')   || ''
      });
    } catch (e) {
      console.error(`sync-vault: project parse error ${f.name} —`, e.message);
    }
  }

  const manifestPath = path.join(ROOT, 'src', 'data', 'manifest.json');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({ active: projects }, null, 2));
  console.log(`sync-vault: wrote ${projects.length} projects → src/data/manifest.json`);

  /* Patch active_projects in manifest-stats.json to reflect actual project count */
  const statsPath = path.join(ROOT, 'src', 'data', 'manifest-stats.json');
  try {
    const existing = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    existing.active_projects = projects.length;
    fs.writeFileSync(statsPath, JSON.stringify(existing, null, 2));
  } catch (_) {}
}

/* ── Inventory extraction (inventory/ category files) ────────────────────── */
/* Builds src/data/inventory.json: { sections: [{title, items:[{name,note}]}] }
 * Format: each entry is a ### heading followed by bullet-list fields.         */
async function extractInventory() {
  const categories = [
    { title: 'Books',         rel: 'inventory/books.md' },
    { title: 'Papers',        rel: 'inventory/papers.md' },
    { title: 'Software',      rel: 'inventory/software.md' },
    { title: 'Subscriptions', rel: 'inventory/subscriptions.md' }
  ];

  const sections = [];
  for (const cat of categories) {
    let items = [];
    try {
      const content = await fetchFile(vaultPath(cat.rel));
      if (content) items = parseInventoryEntries(content);
    } catch (_) { /* category file not yet created — treat as empty */ }
    sections.push({ title: cat.title, items });
  }

  const invPath = path.join(ROOT, 'src', 'data', 'inventory.json');
  fs.mkdirSync(path.dirname(invPath), { recursive: true });
  fs.writeFileSync(invPath, JSON.stringify({ sections }, null, 2));
  const total = sections.reduce((n, s) => n + s.items.length, 0);
  console.log(`sync-vault: wrote ${total} inventory items → src/data/inventory.json`);
}

/* Parse ### Name entries + bullet fields from inventory category markdown */
function parseInventoryEntries(raw) {
  const items = [];
  let currentName = null;
  let note = '';

  for (const line of raw.split('\n')) {
    const h3 = /^### (.+)$/.exec(line);
    if (h3) {
      if (currentName) items.push({ name: currentName, note: note.trim() });
      currentName = h3[1].trim();
      note = '';
      continue;
    }
    if (!currentName) continue;
    const notesM  = /^- \*\*Notes\*\*:\s*(.+)$/.exec(line);
    const statusM = /^- \*\*Status\*\*:\s*(.+)$/.exec(line);
    if (notesM && notesM[1].trim())   note = notesM[1].trim();
    else if (!note && statusM && statusM[1].trim()) note = statusM[1].trim();
  }
  if (currentName) items.push({ name: currentName, note: note.trim() });
  return items;
}

main().catch(e => {
  console.error('sync-vault: fatal —', e.message);
  process.exit(1);
});
