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
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
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
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
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
 *
 * Both formats can appear in the same file (migration window compatibility).
 *
 * Task ID = base64url(vaultRelativePath + '\x00' + cleanTitle)
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

  const tasks = [];

  for (const item of mdFiles) {
    try {
      const content = await fetchFile(item.path);
      if (!content) continue;

      const vaultRelativePath = subtreePrefix ? item.path.slice(subtreePrefix.length) : item.path;
      const fileName = vaultRelativePath.split('/').pop().replace(/\.md$/, '');
      const project  = humanizeSlug(fileName.replace(/-plan$/, '').replace(/^opp-/, ''));

      const lines = content.split('\n');
      for (const line of lines) {
        const m = /^- \[([ x\/])\] (.+)$/.exec(line.trim());
        if (!m) continue;

        const complete = m[1] === 'x';
        let titleRaw   = m[2].trim();

        /* ── Due date ──────────────────────────────────────────────────────── */
        /* Dataview:  [due:: YYYY-MM-DD]
         * Emoji:     📅 YYYY-MM-DD
         * Legacy:    (due: YYYY-MM-DD)
         * Precedence: dataview > emoji > legacy (first match wins) */
        let due = null;
        const dueDV = /\[due::\s*(\d{4}-\d{2}-\d{2})\s*\]/.exec(titleRaw);
        const dueEM = /(?:📅\s*|\(due:\s*)(\d{4}-\d{2}-\d{2})\)?/.exec(titleRaw);
        if (dueDV) {
          due = dueDV[1];
          titleRaw = titleRaw.replace(dueDV[0], '').trim();
        } else if (dueEM) {
          due = dueEM[1];
          titleRaw = titleRaw.replace(dueEM[0], '').trim();
        }

        /* ── Scheduled date ────────────────────────────────────────────────── */
        /* Dataview: [scheduled:: YYYY-MM-DD]   Emoji: 🛫 YYYY-MM-DD */
        let scheduled = null;
        const schedDV = /\[scheduled::\s*(\d{4}-\d{2}-\d{2})\s*\]/.exec(titleRaw);
        const schedEM = /🛫\s*(\d{4}-\d{2}-\d{2})/.exec(titleRaw);
        if (schedDV) {
          scheduled = schedDV[1];
          titleRaw = titleRaw.replace(schedDV[0], '').trim();
        } else if (schedEM) {
          scheduled = schedEM[1];
          titleRaw = titleRaw.replace(schedEM[0], '').trim();
        }

        /* ── Recurring ─────────────────────────────────────────────────────── */
        /* Dataview: [recurring:: interval]   Emoji: 🔁 [interval] */
        let recurring = null;
        const recurDV = /\[recurring::\s*([^\]]*)\]/.exec(titleRaw);
        const recurEM = /🔁\s*([^\s📅🔺⏫🔼🛫]*)/.exec(titleRaw);
        if (recurDV) {
          recurring = recurDV[1].trim() || 'yes';
          titleRaw = titleRaw.replace(recurDV[0], '').trim();
        } else if (recurEM) {
          recurring = recurEM[1].trim() || 'yes';
          titleRaw = titleRaw.replace(recurEM[0], '').trim();
        }

        /* ── Priority ──────────────────────────────────────────────────────── */
        /* Dataview: [priority:: high|medium|low]   Emoji: 🔺 ⏫ 🔼 */
        let priority = 'low';
        const priDV = /\[priority::\s*(high|medium|low)\s*\]/i.exec(titleRaw);
        if (priDV) {
          priority = priDV[1].toLowerCase();
          titleRaw = titleRaw.replace(priDV[0], '').trim();
        } else if (/🔺/.test(titleRaw)) {
          priority = 'high';
        } else if (/⏫/.test(titleRaw)) {
          priority = 'medium';
        }

        /* ── Strip all remaining dataview fields and task-syntax emojis ────── */
        titleRaw = titleRaw
          .replace(/\[[a-z_]+::[^\]]*\]/gi, '')   /* any leftover [field:: value] */
          .replace(/[🔺⏫🔼🔁🛫📅]/gu, '')          /* remaining task emojis */
          .replace(/\s{2,}/g, ' ')
          .trim();

        const id = Buffer.from(vaultRelativePath + '\x00' + titleRaw).toString('base64url');

        tasks.push({ id, title: titleRaw, project, filePath: vaultRelativePath,
                     due, priority, complete,
                     ...(scheduled && { scheduled }),
                     ...(recurring && { recurring }) });
      }
    } catch (e) {
      console.error(`sync-vault: task parse error ${item.path} —`, e.message);
    }
  }

  const tasksPath = path.join(ROOT, 'src', 'data', 'tasks.json');
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(tasksPath, JSON.stringify(tasks, null, 2), 'utf8');
  console.log(`sync-vault: wrote ${tasks.length} tasks → src/data/tasks.json`);
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
