/**
 * GET /api/energeia/papers-list — runtime paper list from agora:energeia
 *
 * Reads slugs.yaml from agora:energeia branch at request time.
 * Returns the full paper list without requiring a new deploy.
 *
 * Response: { generated: ISO, papers: [...] }
 *
 * Env: AGORA_DISPATCH_PAT, AGORA_REPO, HMAC_SECRET, AUTH_DOMAIN
 */

import { validateSession } from '../../_shared/auth.js';

export async function onRequestGet(ctx) {
  const { env, request } = ctx;

  const auth = await validateSession(request, env);
  if (!auth.authenticated) return jsonResponse({ error: 'Unauthorized — no active session' }, 401);

  if (!env.AGORA_DISPATCH_PAT || !env.AGORA_REPO) {
    return jsonResponse({ error: 'agora not configured' }, 503);
  }

  try {
    const slugsYaml = await ghGet(env.AGORA_DISPATCH_PAT, env.AGORA_REPO, 'slugs.yaml');
    const papers = parseSlugsYaml(slugsYaml);

    /* Fetch abstract from each paper's index.md (non-fatal per paper) */
    await Promise.all(papers.map(async function(paper) {
      try {
        const indexMd = await ghGet(env.AGORA_DISPATCH_PAT, env.AGORA_REPO,
          `papers/${paper.slug}/index.md`);
        const fm = parseFrontmatter(indexMd);
        if (fm.abstract) paper.abstract = fm.abstract;
      } catch (_) { /* paper dir may not exist yet */ }
    }));

    return jsonResponse({ generated: new Date().toISOString(), papers });
  } catch (err) {
    console.error('papers-list error:', err);
    return jsonResponse({ error: 'Internal error', detail: err.message }, 500);
  }
}

/* ── agora fetch ──────────────────────────────────────────────────────── */
async function ghGet(pat, repo, filePath) {
  const resp = await fetch(
    `https://api.github.com/repos/${repo}/contents/${filePath}?ref=energeia`,
    {
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'energeia-skeptou'
      }
    }
  );
  if (!resp.ok) throw new Error(`GET ${filePath}: ${resp.status} ${resp.statusText}`);
  const data = await resp.json();
  return atob(data.content.replace(/\s/g, ''));
}

/* ── slugs.yaml parser ────────────────────────────────────────────────── */
function parseSlugsYaml(raw) {
  const papers = [];
  let current = null;
  let inDunamis = false;
  let inArchivedDunamis = false;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();

    if (trimmed.startsWith('- slug:')) {
      if (current) papers.push(current);
      current = {
        slug: trimmed.replace('- slug:', '').trim().replace(/^"|"$/g, ''),
        title: '', status: 'drafting', currentTag: null,
        format: 'article', created: '', abstract: '',
        directions: [], versions: []
      };
      inDunamis = false;
      inArchivedDunamis = false;
      continue;
    }

    if (!current) continue;

    if (trimmed === 'dunamis:') {
      inDunamis = true;
      inArchivedDunamis = false;
      continue;
    }

    if (trimmed === 'archived-dunamis:') {
      inArchivedDunamis = true;
      inDunamis = false;
      continue;
    }

    /* Direction label line: "      alpha: "label"" */
    if ((inDunamis || inArchivedDunamis) && /^\w+:/.test(trimmed)) {
      const colon  = trimmed.indexOf(':');
      const dname  = trimmed.slice(0, colon).trim();
      const dlabel = trimmed.slice(colon + 1).trim().replace(/^"|"$/g, '');
      current.directions.push({
        name:   dname,
        label:  dlabel,
        branch: `dunamis/${current.slug}-${dname}`,
        status: inDunamis ? 'active' : 'archived'
      });
      continue;
    }

    /* Back to paper-level once indentation drops */
    if ((inDunamis || inArchivedDunamis) && trimmed && !/^\s{6,}/.test(line)) {
      inDunamis = false;
      inArchivedDunamis = false;
    }

    if (!inDunamis && !inArchivedDunamis && trimmed.includes(':')) {
      const colon = trimmed.indexOf(':');
      const k = trimmed.slice(0, colon).trim();
      const v = trimmed.slice(colon + 1).trim().replace(/^["'\[]|["'\]]$/g, '');

      if (k === 'title')       current.title      = v;
      if (k === 'status')      current.status     = v;
      if (k === 'current_tag') current.currentTag = v === 'null' ? null : v;
      if (k === 'formats')     current.format     = v.split(',')[0].trim().replace(/^\[|\]$/g, '').trim();
      if (k === 'created')     current.created    = v;
    }
  }

  if (current) papers.push(current);
  return papers;
}

/* ── frontmatter parser ───────────────────────────────────────────────── */
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

/* ── utility ──────────────────────────────────────────────────────────── */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
