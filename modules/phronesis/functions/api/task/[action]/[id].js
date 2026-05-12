/**
 * POST /api/task/:action/:id
 *
 * Cloudflare Pages Function — phronesis
 *
 * action: "complete"   — flips `- [ ]` → `- [x]`
 *         "uncomplete" — flips `- [x]` → `- [ ]`
 *
 * Task ID scheme:
 *   id = base64url( filePath + '\x00' + title )
 *   where filePath is the vault-relative path (e.g. "projects/epistemic-akrasia-plan.md")
 *   and title is the exact task text (sans priority emoji, sans due-date annotation).
 *   The Worker decodes the ID to locate the source file; no sidecar index needed.
 *
 * Vault path prefix (agora migration):
 *   VAULT_SUBTREE env var (default "").
 *   Set to "agora/vault" once agora's directory structure is finalised.
 *   Until then, vault-relative filePath is used as-is.
 *
 * Env vars (Cloudflare Pages secrets):
 *   VAULT_GITHUB_PAT — PAT with contents:write on O&P vault
 *   VAULT_REPO       — "owner/repo"
 *   CF_ACCESS_AUD    — Cloudflare Access audience tag
 *   VAULT_SUBTREE    — optional path prefix (default "")
 */

export async function onRequestPost(ctx) {
  const { env, params, request } = ctx;

  /* ── Auth ── */
  const authErr = await validateCFAccess(request, env.CF_ACCESS_AUD);
  if (authErr) {
    return jsonResponse({ error: 'Unauthorized', detail: authErr }, 401);
  }

  /* ── Route params ── */
  const { action, id } = params;
  if (!['complete', 'uncomplete'].includes(action)) {
    return jsonResponse({ error: 'Invalid action — must be complete or uncomplete' }, 400);
  }
  if (!id) return jsonResponse({ error: 'Missing task id' }, 400);

  /* ── Decode task ID → filePath + title ── */
  const decoded = decodeTaskId(id);
  if (!decoded) return jsonResponse({ error: 'Invalid task id encoding' }, 400);

  const { filePath, title } = decoded;

  /* Validate filePath to prevent path traversal */
  if (!/^[a-zA-Z0-9_\-/]+\.md$/.test(filePath)) {
    return jsonResponse({ error: 'Invalid file path in task id' }, 400);
  }

  /* Apply VAULT_SUBTREE prefix (agora migration hook) */
  const subtree = (env.VAULT_SUBTREE || '').replace(/\/$/, '');
  const fullPath = subtree ? subtree + '/' + filePath : filePath;

  const gh = new GitHubContents(env.VAULT_GITHUB_PAT, env.VAULT_REPO);

  try {
    const file = await gh.getFile(fullPath);

    /* Locate the task line by checkbox state + title substring */
    const searchMarker  = action === 'complete'   ? '- [ ]' : '- [x]';
    const replaceMarker = action === 'complete'   ? '- [x]' : '- [ ]';

    const lines = file.content.split('\n');
    const lineIdx = lines.findIndex(function(line) {
      return line.includes(searchMarker) && line.includes(title);
    });

    if (lineIdx === -1) {
      /* Already in target state or title not found — treat as success */
      return jsonResponse({ status: action + 'd', message: 'No change needed' }, 202);
    }

    lines[lineIdx] = lines[lineIdx].replace(searchMarker, replaceMarker);

    await gh.putFile(
      fullPath,
      lines.join('\n'),
      file.sha,
      `phronesis: ${action} "${title.slice(0, 60)}" [automated]`
    );

    return jsonResponse({ status: action + 'd', message: 'Task updated' }, 202);

  } catch (err) {
    console.error('Task', action, 'error:', err);
    return jsonResponse({ error: 'Internal error', detail: err.message }, 500);
  }
}

/* ── Task ID encode/decode ──────────────────────────────────────────────── */
/* ID = base64url( filePath + '\x00' + title ) using UTF-8 encoding.         */
/* Matches client-side taskId() in index.html and sync-vault.js computation. */
function decodeTaskId(id) {
  try {
    const b64    = id.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    /* atob gives Latin-1 bytes; escape/decodeURIComponent reconstructs UTF-8 */
    const raw    = decodeURIComponent(escape(atob(padded)));
    const sep    = raw.indexOf('\x00');
    if (sep === -1) return null;
    return { filePath: raw.slice(0, sep), title: raw.slice(sep + 1) };
  } catch (_) {
    return null;
  }
}

/* ── GitHub Contents API ────────────────────────────────────────────────── */
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
      'Accept':        'application/vnd.github.v3+json',
      'Content-Type':  'application/json',
      'User-Agent':    'phronesis-skeptou'
    };
  }
}

/* ── CF Access JWT validation ───────────────────────────────────────────── */
async function validateCFAccess(request, audience) {
  if (!audience) return null;

  const token = request.headers.get('CF-Access-Jwt-Assertion');
  if (!token) return 'Missing CF-Access-Jwt-Assertion header';

  try {
    const [headerB64, payloadB64, sigB64] = token.split('.');
    const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));

    const certsResp = await fetch('https://skeptou.cloudflareaccess.com/cdn-cgi/access/certs');
    if (!certsResp.ok) return 'Failed to fetch Access certs';
    const certs = await certsResp.json();

    const jwk = (certs.keys || []).find(function(k) { return k.kid === header.kid; });
    if (!jwk) return 'No matching JWK for token kid';

    const key = await crypto.subtle.importKey(
      'jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify']
    );

    const sig  = Uint8Array.from(atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')), function(c) { return c.charCodeAt(0); });
    const data = new TextEncoder().encode(headerB64 + '.' + payloadB64);

    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
    if (!valid) return 'Invalid JWT signature';

    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    const audMatch = Array.isArray(payload.aud) ? payload.aud.includes(audience) : payload.aud === audience;
    if (!audMatch) return 'JWT audience mismatch';
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return 'JWT expired';

    return null;
  } catch (e) {
    return 'JWT validation error: ' + e.message;
  }
}

/* ── Response helper ────────────────────────────────────────────────────── */
function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
