/**
 * POST /api/opportunity/reject/:slug
 *
 * Cloudflare Pages Function — phronesis
 *
 * Steps:
 *   1. Validate CF Access JWT
 *   2. Fetch opp-<slug>.md from vault repo
 *   3. Update frontmatter: status → declined, date_declined → today
 *   4. Commit
 *   5. Return 202
 *
 * Env vars (Cloudflare Pages secrets):
 *   VAULT_GITHUB_PAT — repo-scoped PAT, contents:write
 *   VAULT_REPO       — "owner/repo"
 *   CF_ACCESS_AUD    — Cloudflare Access audience tag
 */

/* Shared helpers — imported via Cloudflare module pattern.
 * In CF Pages Functions, cross-function imports aren't supported natively;
 * the helpers below are duplicated from the accept function for simplicity.
 * A future refactor can extract to a shared _lib/ module if Pages allows it.
 */

export async function onRequestPost(ctx) {
  const { env, params, request } = ctx;

  const authErr = await validateCFAccess(request, env.CF_ACCESS_AUD);
  if (authErr) {
    return jsonResponse({ error: 'Unauthorized', detail: authErr }, 401);
  }

  const slug = params.slug;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return jsonResponse({ error: 'Invalid slug' }, 400);
  }

  const gh = new GitHubContents(env.VAULT_GITHUB_PAT, env.VAULT_REPO);

  try {
    const oppPath = `opp-${slug}.md`;
    const oppFile = await gh.getFile(oppPath);
    const parsed  = parseFrontmatter(oppFile.content);

    parsed.frontmatter.status        = 'declined';
    parsed.frontmatter.date_declined = isoDateNow();

    const updatedOpp = serializeFrontmatter(parsed.frontmatter) + parsed.body;
    await gh.putFile(oppPath, updatedOpp, oppFile.sha,
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
class GitHubContents {
  constructor(pat, repo) {
    this.pat  = pat;
    this.repo = repo;
    this.base = `https://api.github.com/repos/${repo}/contents`;
  }

  async getFile(path) {
    const resp = await fetch(`${this.base}/${path}`, { headers: this._headers() });
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

    const resp = await fetch(`${this.base}/${path}`, {
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

/* ── CF Access JWT validation ── */
async function validateCFAccess(request, audience) {
  if (!audience) return null;

  const token = request.headers.get('CF-Access-Jwt-Assertion');
  if (!token) return 'Missing CF-Access-Jwt-Assertion header';

  try {
    const [headerB64] = token.split('.');
    const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));

    const certsResp = await fetch(`https://skeptou.cloudflareaccess.com/cdn-cgi/access/certs`);
    if (!certsResp.ok) return 'Failed to fetch Access certs';
    const certs = await certsResp.json();

    const jwk = (certs.keys || []).find(k => k.kid === header.kid);
    if (!jwk) return 'No matching JWK for token kid';

    const key = await crypto.subtle.importKey(
      'jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify']
    );

    const [, payloadB64, sigB64] = token.split('.');
    const sig  = Uint8Array.from(atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
    if (!valid) return 'Invalid JWT signature';

    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    const audMatch = Array.isArray(payload.aud) ? payload.aud.includes(audience) : payload.aud === audience;
    if (!audMatch) return 'JWT audience mismatch';

    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return 'JWT expired';

    return null;
  } catch (e) {
    return `JWT validation error: ${e.message}`;
  }
}
