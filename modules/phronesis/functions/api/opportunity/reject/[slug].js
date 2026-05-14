/**
 * POST /api/opportunity/reject/:slug
 *
 * Cloudflare Pages Function — phronesis
 *
 * Steps:
 *   1. Validate CF Access JWT
 *   2. Fetch projects/opp-<slug>.md from vault repo
 *   3. Update frontmatter: status → declined, date_declined → today
 *   4. Commit
 *   5. Return 202
 *
 * Env vars (Cloudflare Pages secrets):
 *   VAULT_GITHUB_PAT — repo-scoped PAT, contents:write
 *   VAULT_REPO       — "owner/repo"  (e.g. "cameronhubbard642-eng/agora")
 *   VAULT_SUBTREE    — path prefix within repo (e.g. "Organization & Planning")
 *   HMAC_SECRET      — HMAC session secret (shared with auth.skeptou.com)
 *   AUTH_DOMAIN      — auth base URL (default "https://auth.skeptou.com")
 */

/* Shared helpers — imported via Cloudflare module pattern.
 * In CF Pages Functions, cross-function imports aren't supported natively;
 * the helpers below are duplicated from the accept function for simplicity.
 * A future refactor can extract to a shared _lib/ module if Pages allows it.
 */

import { requireSession } from '../../../_shared/auth.js';

export async function onRequestPost(ctx) {
  const { env, params, request } = ctx;

  const authRedirect = await requireSession(request, env);
  if (authRedirect) return authRedirect;

  const slug = params.slug;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return jsonResponse({ error: 'Invalid slug' }, 400);
  }

  /* VAULT_SUBTREE prefix (e.g. "Organization & Planning") */
  const subtree = (env.VAULT_SUBTREE || '').replace(/\/$/, '');
  function vp(relPath) { return subtree ? subtree + '/' + relPath : relPath; }

  const gh = new GitHubContents(env.VAULT_GITHUB_PAT, env.VAULT_REPO);

  try {
    const oppPath = `projects/opp-${slug}.md`;
    const oppFile = await gh.getFile(vp(oppPath));
    const parsed  = parseFrontmatter(oppFile.content);

    parsed.frontmatter.status        = 'declined';
    parsed.frontmatter.date_declined = isoDateNow();

    const updatedOpp = serializeFrontmatter(parsed.frontmatter) + parsed.body;
    await gh.putFile(vp(oppPath), updatedOpp, oppFile.sha,
      `phronesis: reject ${slug} [automated]`);

    return jsonResponse({
      status: 'declined',
      slug,
      message: 'Rebuilding — changes live in ~2 minutes'
    }, 202);

  } catch (err) {
    console.error('Reject error:', err);
    return jsonResponse({ error: 'Internal error', detail: err.message }, 500);
  }
}

/* ── GitHub Contents API wrapper ── */
function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

class GitHubContents {
  constructor(pat, repo) {
    this.pat  = pat;
    this.repo = repo;
    this.base = `https://api.github.com/repos/${repo}/contents`;
  }

  async getFile(path) {
    const resp = await fetch(`${this.base}/${encodePath(path)}`, { headers: this._headers() });
    if (!resp.ok) throw new Error(`GET ${path}: ${resp.status} ${resp.statusText}`);
    const data = await resp.json();
    return {
      content: atob(data.content.replace(/\s/g, '')),
      sha: data.sha
    };
  }

  async putFile(path, content, sha, message) {
    const body = {
      message,
      content: btoa(unescape(encodeURIComponent(content))),
      committer: { name: 'phronesis-bot', email: 'phronesis@skeptou.com' }
    };
    if (sha) body.sha = sha;

    const resp = await fetch(`${this.base}/${encodePath(path)}`, {
      method: 'PUT',
      headers: this._headers(),
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`PUT ${path}: ${resp.status} ${resp.statusText} — ${detail}`);
    }
    return resp.json();
  }

  _headers() {
    return {
      'Authorization': `Bearer ${this.pat}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'phronesis-skeptou'
    };
  }
}

/* ── Minimal frontmatter parser ── */
function parseFrontmatter(raw) {
  const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
  const match = FM_RE.exec(raw);
  if (!match) return { frontmatter: {}, body: raw };

  const fm = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
    if (key) fm[key] = val;
  }
  return { frontmatter: fm, body: match[2] };
}

function serializeFrontmatter(fm) {
  const lines = Object.entries(fm).map(([k, v]) => {
    const needsQuote = /[:#,\[\]{}&*?|<>=!%@`]/.test(String(v));
    return `${k}: ${needsQuote ? '"' + String(v).replace(/"/g, '\\"') + '"' : v}`;
  });
  return `---\n${lines.join('\n')}\n---\n`;
}

function isoDateNow() {
  return new Date().toISOString().slice(0, 10);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

