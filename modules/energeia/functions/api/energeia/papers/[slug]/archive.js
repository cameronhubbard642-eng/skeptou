/**
 * POST /api/energeia/papers/:slug/archive — archive a paper
 *
 * 1. Sets status: archived in slugs.yaml on agora:energeia
 * 2. Moves all active directions from dunamis: → archived-dunamis:
 * 3. Renames each dunamis/<slug>-<dir> branch → archive/dunamis/<slug>-<dir>
 * 4. Queues daemon cleanup for worktrees (non-fatal)
 *
 * The papers/<slug>/ directory on energeia branch is left in place (recoverable).
 *
 * Env: AGORA_DISPATCH_PAT, AGORA_REPO, ENERGEIA_ACTIONS, HMAC_SECRET, AUTH_DOMAIN
 */

import { validateSession } from '../../../../../_shared/auth.js';

export async function onRequestPost(ctx) {
  const { env, params, request } = ctx;

  const auth = await validateSession(request, env);
  if (!auth.authenticated) return jsonResponse({ error: 'Unauthorized — no active session' }, 401);

  const slug = params.slug;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return jsonResponse({ error: 'Invalid slug' }, 400);

  if (!env.AGORA_DISPATCH_PAT || !env.AGORA_REPO) {
    return jsonResponse({ error: 'agora not configured' }, 503);
  }

  try {
    const gh = new GitHub(env.AGORA_DISPATCH_PAT, env.AGORA_REPO);

    /* 1. Update slugs.yaml */
    const file    = await gh.getFile('slugs.yaml', 'energeia');
    const result  = archivePaperInYaml(file.content, slug);

    if (result.status === 'not-found') {
      return jsonResponse({ error: `Paper "${slug}" not found` }, 404);
    }
    if (result.status === 'already-archived') {
      return jsonResponse({ error: `Paper "${slug}" is already archived` }, 409);
    }

    await gh.putFile('slugs.yaml', result.yaml, file.sha,
      `energeia: archive paper ${slug} [automated]`, 'energeia');

    /* 2. Rename dunamis/<slug>-<dir> → archive/dunamis/<slug>-<dir> */
    const renamed = [], failedRenames = [];
    for (const direction of result.archivedDirections) {
      const oldBranch = `dunamis/${slug}-${direction}`;
      const newBranch = `archive/dunamis/${slug}-${direction}`;
      try {
        await gh.renameBranch(oldBranch, newBranch);
        renamed.push({ from: oldBranch, to: newBranch });
      } catch (err) {
        failedRenames.push({ branch: oldBranch, error: err.message });
      }
    }

    /* 3. Queue daemon cleanup for each direction (non-fatal) */
    if (env.ENERGEIA_ACTIONS) {
      for (const direction of result.archivedDirections) {
        const branch = `archive/dunamis/${slug}-${direction}`;
        await queueDaemonAction(env.ENERGEIA_ACTIONS, 'remove-worktree',
          { slug, direction, branch }).catch(() => {});
      }
    }

    return jsonResponse({
      status: 'archived',
      slug,
      directionsArchived: result.archivedDirections,
      branchesRenamed: renamed,
      failedRenames,
      message: `Paper "${slug}" archived. ${renamed.length} branch(es) moved to archive/dunamis/. papers/${slug}/ is preserved.`
    }, 200);

  } catch (err) {
    console.error('Archive paper error:', err);
    return jsonResponse({ error: 'Internal error', detail: err.message }, 500);
  }
}

/* ── YAML manipulation ──────────────────────────────────────────────────── */
/*
 * Sets status: archived, folds all active dunamis: entries into archived-dunamis:,
 * and removes the dunamis: block.
 * Returns { status: 'ok'|'not-found'|'already-archived', yaml, archivedDirections }.
 */
function archivePaperInYaml(yaml, slug) {
  const lines = yaml.split('\n');
  const out   = [];

  let inTarget           = false;
  let inDunamis          = false;
  let inArchivedDunamis  = false;
  let foundSlug          = false;
  let alreadyArchived    = false;
  let capturedDunamis    = [];   /* active direction lines captured from dunamis: */
  const archivedDirections = [];

  for (let i = 0; i < lines.length; i++) {
    const line    = lines[i];
    const trimmed = line.trim();

    /* ── New paper entry ── */
    if (trimmed.startsWith('- slug:')) {
      /* Flush captured dunamis entries that had no archived-dunamis: block */
      if (inTarget && capturedDunamis.length > 0) {
        out.push('    archived-dunamis:');
        capturedDunamis.forEach(function(l) { out.push(l); });
        capturedDunamis = [];
      }
      const thisSlug = trimmed.replace('- slug:', '').trim().replace(/^"|"$/g, '');
      inTarget          = (thisSlug === slug);
      if (inTarget) foundSlug = true;
      inDunamis         = false;
      inArchivedDunamis = false;
      out.push(line);
      continue;
    }

    if (!inTarget) { out.push(line); continue; }

    /* ── Status line: replace with archived ── */
    if (!inDunamis && !inArchivedDunamis && /^\s+status:/.test(line)) {
      if (trimmed === 'status: archived') alreadyArchived = true;
      out.push('    status: archived');
      continue;
    }

    /* ── Block headers ── */
    if (trimmed === 'dunamis:') {
      inDunamis = true; inArchivedDunamis = false;
      /* Suppress the dunamis: header — its entries fold into archived-dunamis: */
      continue;
    }
    if (trimmed === 'archived-dunamis:') {
      inArchivedDunamis = true; inDunamis = false;
      out.push(line);
      /* Inject captured active directions at the start of the existing block */
      if (capturedDunamis.length > 0) {
        capturedDunamis.forEach(function(l) { out.push(l); });
        capturedDunamis = [];
      }
      continue;
    }

    /* ── Inside dunamis block ── */
    if (inDunamis) {
      if (trimmed && !/^\s{5}/.test(line)) {
        inDunamis = false; /* exit — fall through */
      } else {
        if (trimmed && /^\w+:/.test(trimmed)) {
          const dname = trimmed.slice(0, trimmed.indexOf(':')).trim();
          archivedDirections.push(dname);
          capturedDunamis.push(line);
        }
        continue;
      }
    }

    /* ── Inside archived-dunamis block ── */
    if (inArchivedDunamis) {
      if (trimmed && !/^\s{5}/.test(line)) {
        inArchivedDunamis = false;
        /* Flush remaining captured lines (shouldn't happen — archived-dunamis: already handled) */
        if (capturedDunamis.length > 0) {
          capturedDunamis.forEach(function(l) { out.push(l); });
          capturedDunamis = [];
        }
        /* fall through */
      } else {
        out.push(line); continue;
      }
    }

    out.push(line);
  }

  /* EOF flush */
  if (inTarget && capturedDunamis.length > 0) {
    out.push('    archived-dunamis:');
    capturedDunamis.forEach(function(l) { out.push(l); });
  }

  if (!foundSlug) return { status: 'not-found' };
  if (alreadyArchived) return { status: 'already-archived' };
  return { status: 'ok', yaml: out.join('\n'), archivedDirections };
}

/* ── GitHub API ─────────────────────────────────────────────────────────── */
class GitHub {
  constructor(pat, repo) {
    this.pat  = pat;
    this.repo = repo;
    this.base = `https://api.github.com/repos/${repo}`;
  }

  async getFile(path, ref = 'energeia') {
    const resp = await fetch(`${this.base}/contents/${path}?ref=${ref}`, { headers: this._h() });
    if (!resp.ok) throw new Error(`GET ${path}: ${resp.status} ${resp.statusText}`);
    const data = await resp.json();
    return { content: decodeURIComponent(escape(atob(data.content.replace(/\s/g, '')))), sha: data.sha };
  }

  async putFile(path, content, sha, message, branch = 'energeia') {
    const body = {
      message,
      content: btoa(unescape(encodeURIComponent(content))),
      branch,
      committer: { name: 'energeia-bot', email: 'energeia@skeptou.com' },
    };
    if (sha) body.sha = sha;
    const resp = await fetch(`${this.base}/contents/${path}`, {
      method: 'PUT', headers: this._h(), body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`PUT ${path}: ${resp.status} — ${detail}`);
    }
    return resp.json();
  }

  /* Rename a branch: create newBranch at oldBranch's SHA, then delete oldBranch */
  async renameBranch(oldBranch, newBranch) {
    const refResp = await fetch(`${this.base}/git/refs/heads/${oldBranch}`, { headers: this._h() });
    if (refResp.status === 404) throw new Error(`Branch not found: ${oldBranch}`);
    if (!refResp.ok) throw new Error(`GET ref ${oldBranch}: ${refResp.status}`);
    const { object: { sha } } = await refResp.json();

    const createResp = await fetch(`${this.base}/git/refs`, {
      method: 'POST', headers: this._h(),
      body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha }),
    });
    /* 422 = ref already exists — treat as success */
    if (!createResp.ok && createResp.status !== 422) {
      const detail = await createResp.text().catch(() => '');
      throw new Error(`Create ${newBranch}: ${createResp.status} — ${detail}`);
    }

    const delResp = await fetch(`${this.base}/git/refs/heads/${oldBranch}`, {
      method: 'DELETE', headers: this._h(),
    });
    /* 422 = already gone — treat as success */
    if (!delResp.ok && delResp.status !== 422) {
      const detail = await delResp.text().catch(() => '');
      throw new Error(`Delete ${oldBranch}: ${delResp.status} — ${detail}`);
    }
  }

  _h() {
    return {
      'Authorization': `Bearer ${this.pat}`,
      'Accept':        'application/vnd.github.v3+json',
      'Content-Type':  'application/json',
      'User-Agent':    'energeia-skeptou',
    };
  }
}

/* ── KV daemon action queue ─────────────────────────────────────────────── */
async function queueDaemonAction(kv, type, payload) {
  const id = crypto.randomUUID();
  await kv.put(`action:${id}`, JSON.stringify({
    id, type, payload, status: 'pending', created: new Date().toISOString(),
  }));
  const queueRaw = await kv.get('action-queue');
  const queue = queueRaw ? JSON.parse(queueRaw) : [];
  queue.push(id);
  await kv.put('action-queue', JSON.stringify(queue));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
