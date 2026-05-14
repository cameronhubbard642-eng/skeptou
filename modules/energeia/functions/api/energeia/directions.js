/**
 * POST /api/energeia/directions — create a new dunamis direction for a paper
 *
 * Body: { slug, name?, directionLabel? }
 *   slug           — paper slug
 *   name           — direction name (optional; auto-assigned next Greek letter if absent)
 *   directionLabel — short label stored in slugs.yaml dunamis map (optional)
 *
 * Steps:
 *   1. Validate session via auth-core
 *   2. Determine next Greek direction name
 *   3. Dispatch create-dunamis-branch.yml
 *   4. Queue daemon action: duplicate-scrivener-project
 *   5. Return 202
 *
 * Env: AGORA_DISPATCH_PAT, AGORA_REPO, ENERGEIA_ACTIONS, HMAC_SECRET, AUTH_DOMAIN
 */

const GREEK = [
  'alpha','beta','gamma','delta','epsilon','zeta','eta','theta',
  'iota','kappa','lambda','mu','nu','xi','omicron','pi','rho',
  'sigma','tau','upsilon','phi','chi','psi','omega'
];

import { validateSession } from '../../_shared/auth.js';

export async function onRequestPost(ctx) {
  const { env, request } = ctx;

  const auth = await validateSession(request, env);
  if (!auth.authenticated) return jsonResponse({ error: 'Unauthorized — no active session' }, 401);

  let body;
  try { body = await request.json(); }
  catch (_) { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

  const { slug, name, directionLabel = '' } = body;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return jsonResponse({ error: 'slug is required and must be lowercase alphanumeric with hyphens' }, 400);
  }

  let directionName;
  if (name) {
    if (!GREEK.includes(name)) {
      return jsonResponse({ error: `name must be a Greek letter name: ${GREEK.join(', ')}` }, 400);
    }
    directionName = name;
  } else {
    /* Auto-assign: find existing branches to determine next letter */
    directionName = await nextGreekName(env.AGORA_DISPATCH_PAT, env.AGORA_REPO, slug);
  }

  const branchName = `dunamis/${slug}-${directionName}`;

  try {
    await dispatchWorkflow(env.AGORA_DISPATCH_PAT, env.AGORA_REPO,
      'create-dunamis-branch.yml',
      { slug, direction_name: directionName });

    if (env.ENERGEIA_ACTIONS) {
      await queueDaemonAction(env.ENERGEIA_ACTIONS, 'duplicate-scrivener-project',
        { slug, direction: directionName, branch: branchName });
    }

    /* Update slugs.yaml dunamis map if a label was supplied */
    if (directionLabel.trim() && env.AGORA_DISPATCH_PAT && env.AGORA_REPO) {
      try {
        const gh = new GitHubContents(env.AGORA_DISPATCH_PAT, env.AGORA_REPO);
        const slugsFile = await gh.getFile('slugs.yaml', 'energeia').catch(() => null);
        if (slugsFile) {
          const updated = upsertDunamisLabel(slugsFile.content, slug, directionName, directionLabel.trim());
          if (updated !== slugsFile.content) {
            await gh.putFile('slugs.yaml', updated, slugsFile.sha,
              `energeia: label ${slug}/${directionName} in dunamis map [automated]`,
              'energeia');
          }
        }
      } catch (labelErr) {
        /* Non-fatal — direction branch is already dispatched; log and continue */
        console.warn('dunamis label update failed (non-fatal):', labelErr.message);
      }
    }

    return jsonResponse({
      status: 'dispatched',
      slug,
      direction: directionName,
      branch: branchName,
      message: `New direction "${directionName}" dispatched — branch ${branchName} being created.`
    }, 202);

  } catch (err) {
    console.error('New direction error:', err);
    return jsonResponse({ error: 'Internal error', detail: err.message }, 500);
  }
}

/* ── Determine next available Greek direction name ──────────────────────── */
async function nextGreekName(pat, repo, slug) {
  try {
    const url = `https://api.github.com/repos/${repo}/git/refs/heads/dunamis/${slug}-`;
    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'energeia-skeptou'
      }
    });
    if (!resp.ok) return GREEK[0];

    const refs = await resp.json();
    const existing = new Set(
      refs.map(r => r.ref.replace(`refs/heads/dunamis/${slug}-`, ''))
    );
    return GREEK.find(g => !existing.has(g)) || `${GREEK.at(-1)}-2`;

  } catch (_) {
    return GREEK[0];
  }
}

/* ── Shared utilities ───────────────────────────────────────────────────── */
async function dispatchWorkflow(pat, repo, workflow, inputs, ref = 'main') {
  const resp = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'energeia-skeptou'
      },
      body: JSON.stringify({ ref, inputs })
    }
  );
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Dispatch ${workflow}: ${resp.status} — ${detail}`);
  }
}

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

/* ── YAML dunamis map helper ─────────────────────────────────────────────── */
/**
 * Inserts or updates `<directionName>: "<label>"` inside the `dunamis:` block
 * for the given slug entry in slugs.yaml content.  Returns the modified string
 * (or the original if the slug entry is not found).
 *
 * Entries in slugs.yaml look like:
 *   \n  - slug: foo\n    title: "..."\n    ...\n    dunamis:\n      alpha: "..."\n
 *
 * If a `dunamis:` block already exists, the new key is appended to it.
 * If no `dunamis:` block exists, one is added at the end of the slug entry.
 */
function upsertDunamisLabel(yamlStr, slug, directionName, label) {
  const escapedLabel = label.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const newLine = `      ${directionName}: "${escapedLabel}"`;

  // Match the entry block from "  - slug: <slug>" up to (but not including)
  // the next "\n  - slug: " or end of string.
  const slugEsc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRe = new RegExp(
    `(  - slug: ${slugEsc}(?:(?!\\n  - slug: )[\\s\\S])*)`
  );

  return yamlStr.replace(blockRe, function(block) {
    if (/\n    dunamis:\n/.test(block)) {
      // Append to the existing dunamis block: find the consecutive lines
      // indented with exactly 6 spaces and insert after the last one.
      return block.replace(
        /(\n    dunamis:(?:\n      [^\n]+)*)/,
        function(dunamisBlock) { return dunamisBlock + '\n' + newLine; }
      );
    } else {
      // No dunamis block yet — add it at the end of the entry.
      return block.trimEnd() + '\n    dunamis:\n' + newLine + '\n';
    }
  });
}
