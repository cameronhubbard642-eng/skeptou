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

  /* Write manifest-stats.json from opp frontmatter for dashboard counts */
  try {
    const oppDir = path.join(ROOT, OPP_DIR);
    if (fs.existsSync(oppDir)) {
      const oppFiles = fs.readdirSync(oppDir).filter(f => f.endsWith('.md'));
      let pending = 0, confirmed = 0, active = 0;

      for (const f of oppFiles) {
        const raw = fs.readFileSync(path.join(oppDir, f), 'utf8');
        const status = extractFrontmatterField(raw, 'status');
        if (status === 'pending-cam-decision') pending++;
        if (status === 'confirmed-pursuing')   { confirmed++; active++; }
      }

      const statsPath = path.join(ROOT, 'src', 'data', 'manifest-stats.json');
      fs.mkdirSync(path.dirname(statsPath), { recursive: true });
      fs.writeFileSync(statsPath, JSON.stringify({
        active_projects: active,
        pending_decisions: pending,
        confirmed_pursuing: confirmed
      }, null, 2));
      console.log('sync-vault: wrote manifest-stats.json');
    }
  } catch (e) {
    console.error('sync-vault: manifest-stats error —', e.message);
  }

  /* Write opportunities.json from synced opp markdown frontmatter */
  try {
    const oppDir = path.join(ROOT, OPP_DIR);
    if (fs.existsSync(oppDir)) {
      const oppFiles = fs.readdirSync(oppDir).filter(f => f.endsWith('.md'));
      const opportunities = [];

      for (const f of oppFiles) {
        const raw = fs.readFileSync(path.join(oppDir, f), 'utf8');
        const slug = extractFrontmatterField(raw, 'slug') ||
          f.replace(/^opp-/, '').replace(/\.md$/, '');
        opportunities.push({
          slug:        slug,
          title:       extractFrontmatterField(raw, 'title') || humanizeSlug(slug),
          type:        extractFrontmatterField(raw, 'type') || 'opportunity',
          status:      extractFrontmatterField(raw, 'status') || 'pending-cam-decision',
          deadline:    extractFrontmatterField(raw, 'deadline') || null,
          prestige:    extractFrontmatterField(raw, 'prestige') || '',
          requirement: extractFrontmatterField(raw, 'requirement') || '',
          description: extractFrontmatterField(raw, 'description') || ''
        });
      }

      const oppsPath = path.join(ROOT, 'src', 'data', 'opportunities.json');
      fs.mkdirSync(path.dirname(oppsPath), { recursive: true });
      fs.writeFileSync(oppsPath, JSON.stringify(opportunities, null, 2));
      console.log(`sync-vault: wrote ${opportunities.length} opportunities → src/data/opportunities.json`);
    }
  } catch (e) {
    console.error('sync-vault: opportunities.json error —', e.message);
  }

  /* Extract tasks from project plan files */
  try {
    await extractTasks();
  } catch (e) {
    console.error('sync-vault: task extraction error —', e.message);
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
/* Convention:
 *   - Tasks are `- [ ]` / `- [x]` / `- [/]` lines in any .md file
 *   - Priority emojis anywhere in title: 🔺 high · ⏫ medium · 🔼 low
 *   - Due date: `📅 YYYY-MM-DD` or `(due: YYYY-MM-DD)` inline
 *   - Task ID = base64url(vaultRelativePath + '\x00' + title)
 *     vaultRelativePath does NOT include VAULT_SUBTREE — Workers apply it.
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

        /* Due date: 📅 YYYY-MM-DD or (due: YYYY-MM-DD) */
        let due = null;
        const dueM = /(?:📅\s*|\(due:\s*)(\d{4}-\d{2}-\d{2})\)?/.exec(titleRaw);
        if (dueM) { due = dueM[1]; titleRaw = titleRaw.replace(dueM[0], '').trim(); }

        /* Priority detection (anywhere in title) then strip emojis */
        let priority = 'low';
        if (/🔺/.test(titleRaw))      priority = 'high';
        else if (/⏫/.test(titleRaw)) priority = 'medium';
        titleRaw = titleRaw.replace(/[🔺⏫🔼]/gu, '').trim();

        const id = Buffer.from(vaultRelativePath + '\x00' + titleRaw).toString('base64url');

        tasks.push({ id, title: titleRaw, project, filePath: vaultRelativePath,
                     due, priority, complete });
      }
    } catch (e) {
      console.error(`sync-vault: task parse error ${item.path} —`, e.message);
    }
  }

  const tasksPath = path.join(ROOT, 'src', 'data', 'tasks.json');
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(tasksPath, JSON.stringify(tasks, null, 2));
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

main().catch(e => {
  console.error('sync-vault: fatal —', e.message);
  process.exit(1);
});
