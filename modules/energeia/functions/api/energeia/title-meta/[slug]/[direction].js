/**
 * GET / PUT /api/energeia/title-meta/:slug/:direction
 *
 * Per-direction sidecar for title-block overrides. Lives on the dunamis
 * branch as papers/<slug>/title-meta.yaml; promote.yml copies it forward
 * to energeia along with the rest of papers/<slug>/.
 *
 * Fields (all optional — empty string ≡ "fall through to whatever Scrivener
 * emitted into the .tex preamble"):
 *   title, subtitle, author, articleaffiliation, date
 *
 * The compile workflows read this YAML, emit a title-meta-inject.tex
 * beside the main .tex, and \input it via -usepretex so an
 * \AtBeginDocument{...} block redefines the title macros after the
 * Scrivener preamble has set its defaults.
 *
 * Env: AGORA_DISPATCH_PAT, AGORA_REPO, HMAC_SECRET, AUTH_DOMAIN
 */

import { validateSession } from '../../../../_shared/auth.js';

const FIELDS = ['title', 'subtitle', 'author', 'articleaffiliation', 'date'];

export async function onRequestGet(ctx) {
  const { env, params, request } = ctx;

  const auth = await validateSession(request, env);
  if (!auth.authenticated) return jsonResponse({ error: 'Unauthorized — no active session' }, 401);

  const { slug, direction } = params;
  if (!slug      || !/^[a-z0-9-]+$/.test(slug))  return jsonResponse({ error: 'Invalid slug' }, 400);
  if (!direction || !/^[a-z]+$/.test(direction))  return jsonResponse({ error: 'Invalid direction name' }, 400);
  if (!env.AGORA_DISPATCH_PAT || !env.AGORA_REPO) return jsonResponse({ error: 'agora not configured' }, 503);

  const branch = `dunamis/${slug}-${direction}`;
  const path   = `papers/${slug}/title-meta.yaml`;

  try {
    const gh = new GitHubContents(env.AGORA_DISPATCH_PAT, env.AGORA_REPO);
    const file = await gh.getFile(path, branch).catch(err => {
      /* 404 → no sidecar yet; return empty values. Anything else propagates. */
      if (String(err.message).includes(': 404')) return null;
      throw err;
    });
    const values = file ? parseTitleMetaYaml(file.content) : {};
    /* Always echo every field, even if absent — UI binds to a fixed form. */
    const out = {};
    for (const k of FIELDS) out[k] = (values[k] || '').toString();
    return jsonResponse({ slug, direction, branch, values: out, exists: !!file });
  } catch (err) {
    console.error('title-meta GET error:', err);
    return jsonResponse({ error: 'Internal error', detail: err.message }, 500);
  }
}

export async function onRequestPut(ctx) {
  const { env, params, request } = ctx;

  const auth = await validateSession(request, env);
  if (!auth.authenticated) return jsonResponse({ error: 'Unauthorized — no active session' }, 401);

  const { slug, direction } = params;
  if (!slug      || !/^[a-z0-9-]+$/.test(slug))  return jsonResponse({ error: 'Invalid slug' }, 400);
  if (!direction || !/^[a-z]+$/.test(direction))  return jsonResponse({ error: 'Invalid direction name' }, 400);
  if (!env.AGORA_DISPATCH_PAT || !env.AGORA_REPO) return jsonResponse({ error: 'agora not configured' }, 503);

  let body = {};
  try { body = await request.json(); } catch (_) { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
  const incoming = body.values || body || {};

  /* Sanitise: take only known fields, coerce to string, trim, cap length. */
  const cleaned = {};
  for (const k of FIELDS) {
    let v = incoming[k];
    if (v == null) v = '';
    v = String(v).replace(/\r\n?/g, '\n').trim();
    if (v.length > 500) v = v.slice(0, 500);
    /* Reject control chars (except already-handled \n) to avoid YAML break. */
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(v)) {
      return jsonResponse({ error: `Field "${k}" contains forbidden control characters` }, 400);
    }
    cleaned[k] = v;
  }

  const branch = `dunamis/${slug}-${direction}`;
  const path   = `papers/${slug}/title-meta.yaml`;
  const yaml   = renderTitleMetaYaml(cleaned);

  try {
    const gh = new GitHubContents(env.AGORA_DISPATCH_PAT, env.AGORA_REPO);
    const existing = await gh.getFile(path, branch).catch(err => {
      if (String(err.message).includes(': 404')) return null;
      throw err;
    });
    const sha = existing ? existing.sha : undefined;

    /* Skip the write if nothing changed — keeps the dunamis branch clean. */
    if (existing && existing.content === yaml) {
      return jsonResponse({
        status: 'unchanged', slug, direction, branch, values: cleaned,
        message: 'No change — sidecar already matches submitted values.'
      });
    }

    await gh.putFile(path, yaml, sha,
      `energeia: update title-meta for ${slug}-${direction} [automated]`, branch);

    return jsonResponse({
      status: existing ? 'updated' : 'created',
      slug, direction, branch, values: cleaned,
      message: `Title metadata ${existing ? 'updated' : 'created'} on ${branch}. ` +
               `Next compile will pick up the new values.`
    });
  } catch (err) {
    console.error('title-meta PUT error:', err);
    return jsonResponse({ error: 'Internal error', detail: err.message }, 500);
  }
}

/* ── YAML helpers ────────────────────────────────────────────────────────── */
/*
 * Sidecar shape — one key per line, always double-quoted so a stray ":" or
 * "#" in a title doesn't break naive parsers. Empty strings stay as "":
 *   title: ""
 *   subtitle: "Toward a fuller account"
 *   author: "Cameron Hubbard"
 *   ...
 */
function parseTitleMetaYaml(text) {
  const out = {};
  if (!text) return out;
  for (const raw of text.split('\n')) {
    const m = raw.match(/^([A-Za-z_]+):\s*(.*?)\s*$/);
    if (!m) continue;
    const k = m[1];
    if (!FIELDS.includes(k)) continue;
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    out[k] = v;
  }
  return out;
}

function renderTitleMetaYaml(values) {
  const header =
    '# Per-direction title-block overrides — read by compile-draft.yml,\n' +
    '# compile-canonical.yml, and promote.yml. Any field left as "" falls\n' +
    '# through to whatever the .tex preamble emitted (Scrivener-set values).\n' +
    '# Edited via energeia /api/energeia/title-meta/:slug/:direction.\n';
  const lines = [header];
  for (const k of FIELDS) {
    const v = (values[k] || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines.push(`${k}: "${v}"`);
  }
  return lines.join('\n') + '\n';
}

/* ── GitHub Contents API ────────────────────────────────────────────────── */
class GitHubContents {
  constructor(pat, repo) {
    this.pat  = pat;
    this.repo = repo;
    this.base = `https://api.github.com/repos/${repo}/contents`;
  }
  async getFile(path, ref) {
    const resp = await fetch(`${this.base}/${path}?ref=${encodeURIComponent(ref)}`,
      { headers: this._headers() });
    if (!resp.ok) throw new Error(`GET ${path}: ${resp.status} ${resp.statusText}`);
    const data = await resp.json();
    return {
      content: decodeURIComponent(escape(atob(data.content.replace(/\s/g, '')))),
      sha: data.sha
    };
  }
  async putFile(path, content, sha, message, branch) {
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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
