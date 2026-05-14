/**
 * POST /api/energeia/papers — create a new paper
 *
 * Body: { title, abstract, format, slug? }
 *
 * Steps:
 *   1. Validate CF Access JWT
 *   2. Derive or validate slug
 *   3. Append entry to agora:energeia slugs.yaml via GitHub Contents API
 *   4. Create papers/<slug>/index.md and working/<slug>/index.md on energeia branch
 *   5. Dispatch create-dunamis-branch workflow for initial direction "alpha"
 *   6. Queue daemon action: scaffold-scrivener-project
 *   7. Return 202
 *
 * Env (Cloudflare Pages secrets):
 *   AGORA_DISPATCH_PAT — classic PAT with repo scope on agora repo
 *   AGORA_REPO         — "owner/repo" for agora
 *   ENERGEIA_ACTIONS   — KV namespace binding (daemon action queue)
 *   HMAC_SECRET        — HMAC session secret (shared with auth.skeptou.com)
 *   AUTH_DOMAIN        — auth base URL (default "https://auth.skeptou.com")
 */

import { validateSession } from '../../_shared/auth.js';

export async function onRequestPost(ctx) {
  const { env, request } = ctx;

  const auth = await validateSession(request, env);
  if (!auth.authenticated) return jsonResponse({ error: 'Unauthorized — no active session' }, 401);

  let body;
  try { body = await request.json(); }
  catch (_) { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

  const { title, abstract = '', format = 'article', directionLabel = '' } = body;
  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return jsonResponse({ error: 'title is required' }, 400);
  }

  const slug = body.slug
    ? String(body.slug).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
    : title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(slug)) {
    return jsonResponse({ error: 'Invalid or empty slug derived from title' }, 400);
  }

  const VALID_FORMATS = ['article', 'handout', 'abstract', 'cv', 'chapter'];
  if (!VALID_FORMATS.includes(format)) {
    return jsonResponse({ error: `format must be one of: ${VALID_FORMATS.join(', ')}` }, 400);
  }

  const gh = new GitHubContents(env.AGORA_DISPATCH_PAT, env.AGORA_REPO);
  const today = isoDateNow();

  try {
    /* 1. Append to slugs.yaml on energeia branch */
    const slugsFile = await gh.getFile('slugs.yaml', 'energeia').catch(() => null);
    const dunamisLine = directionLabel.trim()
      ? `\n    dunamis:\n      alpha: "${directionLabel.trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      : '';
    const newEntry = `\n  - slug: ${slug}\n    title: "${title.replace(/"/g, '\\"')}"\n    status: drafting\n    current_tag: null\n    formats: [${format}]\n    created: "${today}"${dunamisLine}\n`;

    if (slugsFile) {
      const updated = slugsFile.content + newEntry;
      await gh.putFile('slugs.yaml', updated, slugsFile.sha,
        `energeia: add paper ${slug} [automated]`, 'energeia');
    } else {
      const initial = `# slugs.yaml — Energeia canonical paper registry\n\npapers:\n${newEntry}`;
      await gh.putFile('slugs.yaml', initial, null,
        `energeia: init slugs.yaml + add ${slug} [automated]`, 'energeia');
    }

    /* 2. Create papers/<slug>/index.md on energeia branch */
    const paperIndex = buildPaperIndex(slug, title, abstract, format, today);
    await gh.putFile(`papers/${slug}/index.md`, paperIndex, null,
      `energeia: scaffold papers/${slug} [automated]`, 'energeia');

    /* 3. Create working/<slug>/index.md on energeia branch */
    const workingIndex = `# Working — ${title}\n\n*Notes, outlines, and continuous reference material for this paper.*\n\n## Outline\n\n<!-- Add outline here -->\n\n## Notes\n\n<!-- -->\n\n## Bibliography\n\n<!-- -->\n`;
    await gh.putFile(`working/${slug}/index.md`, workingIndex, null,
      `energeia: scaffold working/${slug} [automated]`, 'energeia');

    /* 4. Dispatch create-dunamis-branch for initial direction "alpha" */
    await dispatchWorkflow(env.AGORA_DISPATCH_PAT, env.AGORA_REPO,
      'create-dunamis-branch.yml',
      { slug, direction_name: 'alpha' });

    /* 5. Queue daemon action: scaffold Scrivener project */
    if (env.ENERGEIA_ACTIONS) {
      await queueDaemonAction(env.ENERGEIA_ACTIONS, 'scaffold-scrivener-project', { slug, title, format });
    }

    return jsonResponse({
      status: 'created',
      slug,
      message: `Paper "${title}" created. Initial direction dunamis/${slug}-alpha is being set up.`
    }, 202);

  } catch (err) {
    console.error('Create paper error:', err);
    return jsonResponse({ error: 'Internal error', detail: err.message }, 500);
  }
}

function buildPaperIndex(slug, title, abstract, format, today) {
  return `---
title: "${title.replace(/"/g, '\\"')}"
slug: ${slug}
status: drafting
format: ${format}
abstract: "${abstract.replace(/"/g, '\\"').slice(0, 300)}"
created: "${today}"
current_tag: null
---

# ${title}

## Abstract

${abstract || '<!-- Add abstract here -->'}

## Document class

\\documentclass{ucr-borges-${format}}

<!-- Compile via agora compile-draft workflow or local xelatex -->
`;
}

/* ── GitHub Contents API ────────────────────────────────────────────────── */
class GitHubContents {
  constructor(pat, repo) {
    this.pat  = pat;
    this.repo = repo;
    this.base = `https://api.github.com/repos/${repo}/contents`;
  }

  async getFile(path, ref = 'energeia') {
    const resp = await fetch(`${this.base}/${path}?ref=${ref}`, { headers: this._headers() });
    if (!resp.ok) throw new Error(`GET ${path}: ${resp.status} ${resp.statusText}`);
    const data = await resp.json();
    return { content: atob(data.content.replace(/\s/g, '')), sha: data.sha };
  }

  async putFile(path, content, sha, message, branch = 'energeia') {
    const body = {
      message,
      content: btoa(unescape(encodeURIComponent(content))),
      branch,
      committer: { name: 'energeia-bot', email: 'energeia@skeptou.com' }
    };
    if (sha) body.sha = sha;
    const resp = await fetch(`${this.base}/${path}`, {
      method: 'PUT', headers: this._headers(), body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`PUT ${path}: ${resp.status} — ${detail}`);
    }
    return resp.json();
  }

  _headers() {
    return {
      'Authorization': `Bearer ${this.pat}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'energeia-skeptou'
    };
  }
}

/* ── GitHub Actions workflow_dispatch ───────────────────────────────────── */
async function dispatchWorkflow(pat, repo, workflow, inputs, ref = 'main') {
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${pat}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'energeia-skeptou'
    },
    body: JSON.stringify({ ref, inputs })
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Dispatch ${workflow}: ${resp.status} — ${detail}`);
  }
}

/* ── KV daemon action queue ─────────────────────────────────────────────── */
async function queueDaemonAction(kv, type, payload) {
  const id = crypto.randomUUID();
  const action = { id, type, payload, status: 'pending', created: new Date().toISOString() };
  await kv.put(`action:${id}`, JSON.stringify(action));

  /* Append to queue list */
  const queueRaw = await kv.get('action-queue');
  const queue = queueRaw ? JSON.parse(queueRaw) : [];
  queue.push(id);
  await kv.put('action-queue', JSON.stringify(queue));
  return id;
}

/* ── Utilities ──────────────────────────────────────────────────────────── */
function isoDateNow() { return new Date().toISOString().slice(0, 10); }

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

