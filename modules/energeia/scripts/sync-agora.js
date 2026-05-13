#!/usr/bin/env node
/**
 * sync-agora.js — fetch paper metadata from agora:energeia for build
 *
 * Reads slugs.yaml + each paper's index.md frontmatter from agora:energeia
 * and writes modules/energeia/src/data/papers.json for use by index.html.
 *
 * Exits 0 gracefully when AGORA_DISPATCH_PAT / AGORA_REPO are not set
 * (CI without secrets wired; or local dev without agora configured).
 *
 * Outputs:
 *   modules/energeia/src/data/papers.json
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const PAT  = process.env.AGORA_DISPATCH_PAT;
const REPO = process.env.AGORA_REPO;

if (!PAT || !REPO) {
  console.warn('sync-agora: AGORA_DISPATCH_PAT or AGORA_REPO not set — skipping sync, using embedded sample data');
  process.exit(0);
}

const HEADERS = {
  'Authorization': `Bearer ${PAT}`,
  'Accept':        'application/vnd.github.v3+json',
  'User-Agent':    'energeia-skeptou',
};

async function ghGet(apiPath) {
  const { default: fetch } = await import('node-fetch').catch(() => {
    throw new Error('node-fetch not available — run npm ci');
  });
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${apiPath}?ref=energeia`, { headers: HEADERS });
  if (!r.ok) throw new Error(`GET ${apiPath}: ${r.status} ${r.statusText}`);
  const data = await r.json();
  return Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf-8');
}

function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const k = line.slice(0, colon).trim();
    const v = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
    if (k) fm[k] = v;
  }
  return fm;
}

async function main() {
  try {
    const slugsRaw = await ghGet('slugs.yaml');

    /* Minimal YAML parser for the flat slugs.yaml structure */
    const papers = [];
    let current = null;
    for (const line of slugsRaw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- slug:')) {
        if (current) papers.push(current);
        current = { slug: trimmed.replace('- slug:', '').trim().replace(/"/g, '') };
      } else if (current && trimmed.includes(':')) {
        const colon = trimmed.indexOf(':');
        const k = trimmed.slice(0, colon).trim();
        const v = trimmed.slice(colon + 1).trim().replace(/^["'\[]|["\'\]]$/g, '');
        current[k] = v;
      }
    }
    if (current) papers.push(current);

    /* Fetch each paper's index.md for abstract */
    for (const paper of papers) {
      try {
        const indexRaw = await ghGet(`papers/${paper.slug}/index.md`);
        const fm = parseFrontmatter(indexRaw);
        if (fm.abstract) paper.abstract = fm.abstract;
        if (fm.format)   paper.format   = fm.format;
      } catch (_) {
        /* Paper directory may not exist yet — use minimal data */
      }
    }

    const outDir = path.join(__dirname, '..', 'src', 'data');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'papers.json'),
      JSON.stringify({ generated: new Date().toISOString(), papers }, null, 2)
    );

    console.log(`sync-agora: wrote ${papers.length} papers to src/data/papers.json`);
  } catch (err) {
    console.warn('sync-agora: failed —', err.message, '(using embedded sample data)');
    process.exit(0); /* Non-fatal */
  }
}

main();
