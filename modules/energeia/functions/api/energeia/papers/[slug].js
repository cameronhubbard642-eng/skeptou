/**
 * DELETE /api/energeia/papers/:slug — permanently delete a paper
 *
 * 1. Removes the paper's entry from slugs.yaml on agora:energeia
 * 2. Deletes all dunamis/<slug>-* and archive/dunamis/<slug>-* branches
 * 3. Triggers delete-paper workflow to remove papers/<slug>/, working/<slug>/,
 *    compiled/<slug>/ directories from the energeia branch
 *
 * The request body must include { "confirm": "delete-<slug>" } as an
 * anti-accident guard — the UI confirmation modal sends this automatically.
 *
 * Returns 200 with audit info. Directory cleanup runs asynchronously via
 * GitHub Actions (workflowQueued: true|false).
 *
 * Env: AGORA_DISPATCH_PAT, AGORA_REPO, ENERGEIA_ACTIONS, HMAC_SECRET, AUTH_DOMAIN
 */

import { validateSession } from '../../../_shared/auth.js';

export async function onRequestDelete(ctx) {
  const { env, params, request } = ctx;

  const auth = await validateSession(request, env);
  if (!auth.authenticated) return jsonResponse({ error: 'Unauthorized — no active session' }, 401);

  const slug = params.slug;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return jsonResponse({ error: 'Invalid slug' }, 400);

  if (!env.AGORA_DISPATCH_PAT || !env.AGORA_REPO) {
    return jsonResponse({ error: 'agora not configured' }, 503);
  }

  /* Require explicit confirmation token */
  let body = {};
  try { body = await request.json(); } catch (_) {}
  if (body.confirm !== `delete-${slug}`) {
    return jsonResponse(
      { error: `Confirmation required: send { "confirm": "delete-${slug}" } in the request body` },
      400
    );
  }

  try {
    const gh = new GitHub(env.AGORA_DISPATCH_PAT, env.AGORA_REPO);

    /* 1. Remove paper from slugs.yaml */
    const file   = await gh.getFile('slugs.yaml', 'energeia');
    const result = removePaperFromYaml(file.content, slug);
    if (!result.found) return jsonResponse({ error: `Paper "${slug}" not found` }, 404);

    await gh.putFile('slugs.yaml', result.yaml, file.sha,
      `energeia: permanently delete paper ${slug} [automated — AUDIT]`, 'energeia');

    /* 2. Delete all matching branches */
    const deleted = [], failedDeletes = [];
    for (const prefix of [`dunamis/${slug}-`, `archive/dunamis/${slug}-`]) {
      let branches = [];
      try { branches = await gh.listBranchesWithPrefix(prefix); } catch (_) {}
      for (const branch of branches) {
        try {
          await gh.deleteBranch(branch);
          deleted.push(branch);
        } catch (err) {
          failedDeletes.push({ branch, error: err.message });
        }
      }
    }

    /* 3. Queue daemon local cleanup — worktrees + Scrivener (non-fatal) */
    let daemonQueued = 0;
    if (env.ENERGEIA_ACTIONS) {
      for (const branch of deleted) {
        /* Extract direction from branch name regardless of archive prefix */
        const stem      = branch.replace(/^(?:archive\/)?dunamis\//, '');
        const direction = stem.slice(slug.length + 1);
        await queueDaemonAction(env.ENERGEIA_ACTIONS, 'remove-worktree',
          { slug, direction, branch }).catch(() => {});
        daemonQueued++;
      }
      /* Trash all Scrivener projects: <slug>.scriv and <slug>-*.scriv */
      await queueDaemonAction(env.ENERGEIA_ACTIONS, 'delete-scrivener-project',
        { slug }).catch(() => {});
      daemonQueued++;
    }

    /* 4. Trigger directory cleanup workflow on agora (non-fatal) */
    let workflowQueued = false;
    try {
      await gh.dispatchWorkflow('delete-paper.yml', 'main', { slug });
      workflowQueued = true;
    } catch (_) { /* workflow not yet deployed or dispatch failed — manual cleanup required */ }

    return jsonResponse({
      status: 'deleted',
      slug,
      branchesDeleted: deleted,
      failedDeletes,
      daemonActionsQueued: daemonQueued,
      directoryCleanup: workflowQueued ? 'queued' : 'manual-required',
      message: `Paper "${slug}" permanently deleted. This action is irreversible.`,
    }, 200);

  } catch (err) {
    console.error('Delete paper error:', err);
    return jsonResponse({ error: 'Internal error', detail: err.message }, 500);
  }
}

/* ── YAML manipulation ──────────────────────────────────────────────────── */
/*
 * Removes the entire paper entry for the given slug from slugs.yaml.
 * Returns { found: bool, yaml: string }.
 */
function removePaperFromYaml(yaml, slug) {
  const lines = yaml.split('\n');
  const out   = [];
  let inTarget = false;
  let found    = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('- slug:')) {
      const thisSlug = trimmed.replace('- slug:', '').trim().replace(/^"|"$/g, '');
      if (thisSlug === slug) {
        inTarget = true;
        found    = true;
        continue; /* skip this line (start of target entry) */
      }
      inTarget = false;
    }

    if (!inTarget) out.push(line);
    /* else: skip all lines belonging to the target paper */
  }

  return { found, yaml: out.join('\n') };
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

  /* List all remote branches whose name begins with prefix */
  async listBranchesWithPrefix(prefix) {
    const resp = await fetch(
      `${this.base}/git/refs/heads/${encodeURIComponent(prefix).replace(/%2F/g, '/')}`,
      { headers: this._h() }
    );
    if (resp.status === 404) return [];
    if (!resp.ok) throw new Error(`List refs (${prefix}): ${resp.status}`);
    const data = await resp.json();
    const arr  = Array.isArray(data) ? data : [data];
    return arr.map(function(r) { return r.ref.replace('refs/heads/', ''); });
  }

  async deleteBranch(branch) {
    const resp = await fetch(`${this.base}/git/refs/heads/${branch}`, {
      method: 'DELETE', headers: this._h(),
    });
    /* 422 = ref does not exist — treat as success */
    if (!resp.ok && resp.status !== 422) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`DELETE ${branch}: ${resp.status} — ${detail}`);
    }
  }

  async dispatchWorkflow(workflowId, ref, inputs) {
    const resp = await fetch(
      `${this.base}/actions/workflows/${workflowId}/dispatches`,
      {
        method: 'POST', headers: this._h(),
        body: JSON.stringify({ ref, inputs }),
      }
    );
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`Dispatch ${workflowId}: ${resp.status} — ${detail}`);
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
