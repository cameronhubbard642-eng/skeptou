/**
 * POST   /api/energeia/archive/:slug/:direction — archive a dunamis direction
 * DELETE /api/energeia/archive/:slug/:direction — permanently delete an archived direction
 *
 * POST:
 *   1. Moves the direction from dunamis: → archived-dunamis: in agora:energeia slugs.yaml
 *   2. Queues daemon actions for local cleanup (worktree + Scrivener project)
 *   The remote branch is preserved as a permanent record.
 *
 * DELETE:
 *   1. Confirms direction is in archived-dunamis: (not active)
 *   2. Deletes the dunamis/<slug>-<direction> branch from agora via GitHub Refs API
 *   3. Removes direction from archived-dunamis: in slugs.yaml
 *   4. Optionally queues daemon action to remove local Scrivener archive
 *
 * Env: AGORA_DISPATCH_PAT, AGORA_REPO, ENERGEIA_ACTIONS, HMAC_SECRET, AUTH_DOMAIN
 */

import { validateSession } from '../../../../_shared/auth.js';

export async function onRequestPost(ctx) {
  const { env, params, request } = ctx;

  const auth = await validateSession(request, env);
  if (!auth.authenticated) return jsonResponse({ error: 'Unauthorized — no active session' }, 401);

  const slug      = params.slug;
  const direction = params.direction;

  if (!slug      || !/^[a-z0-9-]+$/.test(slug))  return jsonResponse({ error: 'Invalid slug' }, 400);
  if (!direction || !/^[a-z]+$/.test(direction))  return jsonResponse({ error: 'Invalid direction name' }, 400);

  if (!env.AGORA_DISPATCH_PAT || !env.AGORA_REPO) {
    return jsonResponse({ error: 'agora not configured' }, 503);
  }

  const branch = `dunamis/${slug}-${direction}`;

  try {
    /* 1. Update slugs.yaml: move direction from dunamis → archived-dunamis */
    const gh = new GitHubContents(env.AGORA_DISPATCH_PAT, env.AGORA_REPO);
    const file = await gh.getFile('slugs.yaml', 'energeia');
    const updated = archiveDirectionInYaml(file.content, slug, direction);

    if (updated === file.content) {
      return jsonResponse({ error: `Direction "${direction}" not found in active dunamis for paper "${slug}"` }, 404);
    }

    await gh.putFile('slugs.yaml', updated, file.sha,
      `energeia: archive direction ${slug}-${direction} [automated]`, 'energeia');

    /* 2. Queue daemon actions for local cleanup (non-fatal) */
    if (env.ENERGEIA_ACTIONS) {
      await queueDaemonAction(env.ENERGEIA_ACTIONS, 'archive-scrivener-project',
        { slug, direction, branch }).catch(() => {});
      await queueDaemonAction(env.ENERGEIA_ACTIONS, 'remove-worktree',
        { slug, direction, branch }).catch(() => {});
    }

    return jsonResponse({
      status: 'archived',
      slug,
      direction,
      branch,
      message: `Direction "${direction}" archived. Branch ${branch} is preserved.`
    }, 202);

  } catch (err) {
    console.error('Archive error:', err);
    return jsonResponse({ error: 'Internal error', detail: err.message }, 500);
  }
}

export async function onRequestDelete(ctx) {
  const { env, params, request } = ctx;

  const auth = await validateSession(request, env);
  if (!auth.authenticated) return jsonResponse({ error: 'Unauthorized — no active session' }, 401);

  const slug      = params.slug;
  const direction = params.direction;

  if (!slug      || !/^[a-z0-9-]+$/.test(slug))  return jsonResponse({ error: 'Invalid slug' }, 400);
  if (!direction || !/^[a-z]+$/.test(direction))  return jsonResponse({ error: 'Invalid direction name' }, 400);

  if (!env.AGORA_DISPATCH_PAT || !env.AGORA_REPO) {
    return jsonResponse({ error: 'agora not configured' }, 503);
  }

  let body = {};
  try { body = await request.json(); } catch (_) {}
  const deleteScrivener = body.deleteScrivener === true;

  const branch = `dunamis/${slug}-${direction}`;

  try {
    const gh = new GitHubContents(env.AGORA_DISPATCH_PAT, env.AGORA_REPO);

    /* 1. Read slugs.yaml — confirm direction is in archived-dunamis: (not active) */
    const file = await gh.getFile('slugs.yaml', 'energeia');
    const updated = removeArchivedDirectionFromYaml(file.content, slug, direction);

    if (updated === null) {
      return jsonResponse({
        error: `Direction "${direction}" not found in archived-dunamis for paper "${slug}". ` +
               `Only archived directions can be permanently deleted.`
      }, 404);
    }

    /* 2. Delete the branch from agora */
    const branchDeleted = await deleteGitHubBranch(env.AGORA_DISPATCH_PAT, env.AGORA_REPO, branch);

    /* 3. Remove direction from archived-dunamis: in slugs.yaml */
    await gh.putFile('slugs.yaml', updated, file.sha,
      `energeia: permanently delete archived direction ${slug}-${direction} [automated]`, 'energeia');

    /* 4. Optionally queue daemon action for local Scrivener archive removal (non-fatal) */
    if (deleteScrivener && env.ENERGEIA_ACTIONS) {
      await queueDaemonAction(env.ENERGEIA_ACTIONS, 'delete-scrivener-archive',
        { slug, direction, branch }).catch(() => {});
    }

    return jsonResponse({
      status: 'deleted',
      slug,
      direction,
      branch,
      branchDeleted,
      deletedAt:     new Date().toISOString(),
      message: `Direction "${direction}" permanently deleted. Branch ${branch} has been removed from agora.`
    });

  } catch (err) {
    console.error('Delete archived error:', err);
    return jsonResponse({ error: 'Internal error', detail: err.message }, 500);
  }
}

/* ── YAML manipulation ──────────────────────────────────────────────────── */
/*
 * Moves the named direction from dunamis: to archived-dunamis: within the
 * target paper's entry. Format (4-space paper keys, 6-space direction entries):
 *
 *   - slug: some-paper
 *     ...
 *     dunamis:
 *       alpha: "label"
 *     archived-dunamis:
 *       beta: "archived label"
 */
function archiveDirectionInYaml(yaml, slug, direction) {
  const lines = yaml.split('\n');
  const out   = [];

  let inTargetPaper     = false;
  let inDunamis         = false;
  let inArchivedDunamis = false;
  let capturedLine      = null;   /* the direction line removed from dunamis */

  for (let i = 0; i < lines.length; i++) {
    const line    = lines[i];
    const trimmed = line.trim();

    /* ── New paper entry ── */
    if (trimmed.startsWith('- slug:')) {
      /* If we captured a line but haven't placed it yet, flush before new paper */
      if (capturedLine && inTargetPaper) {
        out.push('    archived-dunamis:');
        out.push(capturedLine);
        capturedLine = null;
      }
      const thisSlug    = trimmed.replace('- slug:', '').trim().replace(/^"|"$/g, '');
      inTargetPaper     = (thisSlug === slug);
      inDunamis         = false;
      inArchivedDunamis = false;
      out.push(line);
      continue;
    }

    if (!inTargetPaper) { out.push(line); continue; }

    /* ── Block headers ── */
    if (trimmed === 'dunamis:') {
      inDunamis = true; inArchivedDunamis = false;
      out.push(line); continue;
    }
    if (trimmed === 'archived-dunamis:') {
      /* Entering existing archived block — place captured line at end of it */
      inArchivedDunamis = true; inDunamis = false;
      out.push(line); continue;
    }

    /* ── Inside dunamis block ── */
    if (inDunamis) {
      /* Exit check: indentation dropped (paper-level key) */
      if (trimmed && !/^\s{5}/.test(line)) {
        inDunamis = false;
        /* If we captured a line and no archived-dunamis block exists yet, create one now */
        if (capturedLine) {
          out.push('    archived-dunamis:');
          out.push(capturedLine);
          capturedLine = null;
        }
        /* Fall through to output this paper-level line */
      } else {
        /* Direction entry: word: "label" */
        if (/^\w+:/.test(trimmed)) {
          const dname = trimmed.slice(0, trimmed.indexOf(':')).trim();
          if (dname === direction) {
            capturedLine = line;  /* capture and skip */
            continue;
          }
        }
        out.push(line); continue;
      }
    }

    /* ── Inside archived-dunamis block ── */
    if (inArchivedDunamis) {
      /* Exit check */
      if (trimmed && !/^\s{5}/.test(line)) {
        inArchivedDunamis = false;
        /* Flush captured line before exiting block */
        if (capturedLine) {
          out.push(capturedLine);
          capturedLine = null;
        }
        /* Fall through to output this paper-level line */
      } else {
        out.push(line); continue;
      }
    }

    out.push(line);
  }

  /* EOF flush */
  if (capturedLine && inTargetPaper) {
    out.push('    archived-dunamis:');
    out.push(capturedLine);
  }

  return out.join('\n');
}

/*
 * Removes the named direction from archived-dunamis: in the target paper's entry.
 * If the archived-dunamis: block becomes empty after removal, the header is also dropped.
 * Returns null if the direction was not found in archived-dunamis:.
 */
function removeArchivedDirectionFromYaml(yaml, slug, direction) {
  const lines = yaml.split('\n');
  const out   = [];

  let inTargetPaper     = false;
  let inArchivedDunamis = false;
  let removed           = false;

  /* Buffer the archived-dunamis header + entries so we can drop the header if empty */
  let pendingHeader = null;
  let pendingLines  = [];

  function flushPending() {
    if (pendingLines.length > 0) {
      if (pendingHeader !== null) out.push(pendingHeader);
      pendingLines.forEach(function(l) { out.push(l); });
    }
    pendingHeader = null;
    pendingLines  = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line    = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('- slug:')) {
      if (inArchivedDunamis) { flushPending(); inArchivedDunamis = false; }
      const thisSlug = trimmed.replace('- slug:', '').trim().replace(/^"|"$/g, '');
      inTargetPaper = (thisSlug === slug);
      out.push(line);
      continue;
    }

    if (!inTargetPaper) { out.push(line); continue; }

    /* Exit archived-dunamis block when indentation drops to paper level */
    if (inArchivedDunamis && trimmed && !/^\s{5}/.test(line)) {
      flushPending();
      inArchivedDunamis = false;
    }

    if (trimmed === 'archived-dunamis:') {
      inArchivedDunamis = true;
      pendingHeader = line;
      pendingLines  = [];
      continue;
    }

    if (trimmed === 'dunamis:') {
      if (inArchivedDunamis) { flushPending(); inArchivedDunamis = false; }
      out.push(line);
      continue;
    }

    if (inArchivedDunamis) {
      if (/^\w+:/.test(trimmed)) {
        const dname = trimmed.slice(0, trimmed.indexOf(':')).trim();
        if (dname === direction) {
          removed = true;
          continue; /* skip — this is the entry being deleted */
        }
      }
      pendingLines.push(line);
      continue;
    }

    out.push(line);
  }

  if (inArchivedDunamis) flushPending();

  if (!removed) return null;
  return out.join('\n');
}

/* ── GitHub Refs API — branch deletion ─────────────────────────────────── */
async function deleteGitHubBranch(pat, repo, branch) {
  const resp = await fetch(
    `https://api.github.com/repos/${repo}/git/refs/heads/${branch}`,
    {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'energeia-skeptou'
      }
    }
  );
  /* 204 = deleted; 422 = ref does not exist (already gone — treat as success) */
  if (!resp.ok && resp.status !== 422) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`DELETE refs/heads/${branch}: ${resp.status} — ${detail}`);
  }
  return resp.status !== 422;
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

/* ── KV daemon action queue ─────────────────────────────────────────────── */
async function queueDaemonAction(kv, type, payload) {
  const id = crypto.randomUUID();
  await kv.put(`action:${id}`, JSON.stringify({
    id, type, payload, status: 'pending', created: new Date().toISOString()
  }));
  const queueRaw = await kv.get('action-queue');
  const queue = queueRaw ? JSON.parse(queueRaw) : [];
  queue.push(id);
  await kv.put('action-queue', JSON.stringify(queue));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
