#!/usr/bin/env node
/**
 * sync-vault.js — phronesis build script
 *
 * Syncs the calendar / commitments markdown from the O&P vault into content/
 * so aggregate-busy.js can build the workload heatmap. Runs in CI before the
 * dashboard build (GitHub Actions step).
 *
 * Scope note: structured O&P data (projects, opportunities, tasks, inventory,
 * commitments) now lives in Cloudflare D1 and is served by the phronesis
 * Worker API — see specs/op-d1-migration.md. This script no longer parses O&P
 * markdown or emits src/data/*.json; it syncs only the two files the calendar
 * busy-score aggregation depends on.
 *
 * Files synced (both consumed by aggregate-busy.js → src/data/busy-scores.json):
 *   COMMITMENTS.md               → content/commitments.md
 *   commitments/calendar-sync.md → content/calendar-sync.md
 *
 * Env vars (set in GitHub Actions via repo secrets):
 *   VAULT_GITHUB_PAT  — PAT with contents:read on the vault repo
 *   VAULT_REPO        — "owner/repo"
 *   VAULT_SUBTREE     — path prefix within the vault repo (optional)
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');

const PAT  = process.env.VAULT_GITHUB_PAT;
const REPO = process.env.VAULT_REPO;
/* VAULT_SUBTREE: prefix within the vault repo for all O&P content (e.g.
 * "Organization & Planning" for cameronhubbard642-eng/agora). ghGet() encodes
 * each path segment individually so spaces / ampersands are handled. */
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
/* Both files feed aggregate-busy.js. exclude=true marks the file draft so a
 * Quartz build would not render it as a page. */
const SYNC_MAP = [
  { vault: 'COMMITMENTS.md',               local: 'content/commitments.md',   exclude: true },
  { vault: 'commitments/calendar-sync.md', local: 'content/calendar-sync.md', exclude: true },
];

/* ── GitHub Contents API (minimal, stdlib only) ─────────────────────────── */
/* Encode each path segment individually so folder names containing spaces or
 * special characters (e.g. "Organization & Planning") are handled correctly.
 * encodeURIComponent on the whole path would also encode '/' separators. */
function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

function ghGet(vPath) {
  return new Promise((resolve, reject) => {
    const url = `https://api.github.com/repos/${REPO}/contents/${encodePath(vPath)}`;
    const opts = {
      headers: {
        'Authorization': `Bearer ${PAT}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'phronesis-sync'
      }
    };

    https.get(url, opts, (res) => {
      /* Accumulate raw Buffer chunks before decoding to avoid corrupting
       * multi-byte UTF-8 sequences (e.g. em-dashes) that span chunk boundaries. */
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode !== 200) return reject(new Error(`GET ${vPath}: ${res.statusCode}`));
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`JSON parse error for ${vPath}: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

async function fetchFile(vPath) {
  const data = await ghGet(vPath);
  if (!data) return null;
  if (Array.isArray(data)) return null; /* Directory listing, not a file */
  return Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8');
}

/* ── Sync a single file ──────────────────────────────────────────────────── */
async function syncFile(vPath, localPath, exclude) {
  const absLocal = path.join(ROOT, localPath);
  fs.mkdirSync(path.dirname(absLocal), { recursive: true });

  const content = await fetchFile(vPath);
  if (content === null) {
    console.warn(`sync-vault: not found in vault — ${vPath} (skipping)`);
    return;
  }

  /* If excluded from Quartz rendering, inject draft: true into frontmatter */
  let toWrite = content;
  if (exclude && localPath.endsWith('.md')) {
    toWrite = injectDraft(content);
  }

  fs.writeFileSync(absLocal, toWrite);
  console.log(`sync-vault: ${vPath} → ${localPath}`);
}

/* Inject draft: true into YAML frontmatter so Quartz doesn't render the file as a page */
function injectDraft(raw) {
  if (raw.startsWith('---')) {
    const closeIdx = raw.indexOf('\n---', 3);
    if (closeIdx !== -1) {
      const fm   = raw.slice(0, closeIdx);
      const rest = raw.slice(closeIdx);
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
  console.log(`sync-vault: syncing calendar files from ${REPO}`);

  for (const { vault, local, exclude } of SYNC_MAP) {
    try {
      await syncFile(vaultPath(vault), local, exclude);
    } catch (e) {
      console.error(`sync-vault: error syncing ${vault} —`, e.message);
    }
  }

  console.log('sync-vault: done');
}

main().catch(e => {
  console.error('sync-vault: fatal —', e.message);
  process.exit(1);
});
