/**
 * POST /api/opportunity/accept/:slug
 *
 * Cloudflare Pages Function — phronesis
 *
 * Steps (sequential; abort on any GitHub API failure):
 *   1. Validate CF Access JWT
 *   2. Fetch projects/opp-<slug>.md from vault repo
 *   3. Parse frontmatter; update status → confirmed-pursuing, add date_accepted
 *   4. Commit updated opp file
 *   5. Fetch PROJECT_MANIFEST.md; move row to Active Projects; commit
 *   6. Create projects/<slug>-plan.md from template; commit
 *   7. Return 202
 *
 * Env vars (Cloudflare Pages secrets):
 *   VAULT_GITHUB_PAT — repo-scoped PAT, contents:write on O&P vault
 *   VAULT_REPO       — "owner/repo"  (e.g. "cameronhubbard642-eng/agora")
 *   CF_ACCESS_AUD    — Cloudflare Access audience tag for this app
 *   VAULT_SUBTREE    — path prefix within repo (e.g. "Organization & Planning")
 */

export async function onRequestPost(ctx) {
  const { env, params, request } = ctx;

  /* ── Auth: validate CF Access JWT ── */
  const authErr = await validateCFAccess(request, env.CF_ACCESS_AUD);
  if (authErr) {
    return jsonResponse({ error: 'Unauthorized', detail: authErr }, 401);
  }

  const slug = params.slug;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return jsonResponse({ error: 'Invalid slug' }, 400);
  }

  /* VAULT_SUBTREE prefix (e.g. "Organization & Planning") */
  const subtree = (env.VAULT_SUBTREE || '').replace(/\/$/, '');
  function vp(relPath) { return subtree ? subtree + '/' + relPath : relPath; }

  const gh = new GitHubContents(env.VAULT_GITHUB_PAT, env.VAULT_REPO);

  try {
    /* Step 1–4: update opp file (opp-*.md lives in projects/) */
    const oppPath = `projects/opp-${slug}.md`;
    const oppFile = await gh.getFile(vp(oppPath));
    const parsed  = parseFrontmatter(oppFile.content);

    parsed.frontmatter.status       = 'confirmed-pursuing';
    parsed.frontmatter.date_accepted = isoDateNow();

    const updatedOpp = serializeFrontmatter(parsed.frontmatter) + parsed.body;
    await gh.putFile(vp(oppPath), updatedOpp, oppFile.sha,
      `phronesis: accept ${slug} [automated]`);

    /* Step 5: update PROJECT_MANIFEST.md */
    try {
      const manifestFile = await gh.getFile(vp('PROJECT_MANIFEST.md'));
      const updatedManifest = moveOppToActive(manifestFile.content, slug, parsed.frontmatter.title || slug);
      await gh.putFile(vp('PROJECT_MANIFEST.md'), updatedManifest, manifestFile.sha,
        `phronesis: accept ${slug} — manifest update [automated]`);
    } catch (manifestErr) {
      /* Non-fatal: manifest update failure doesn't roll back opp commit */
      console.error('Manifest update failed:', manifestErr.message);
    }

    /* Step 6: upsert projects/<slug>-plan.md
     * Pass existing SHA if file already exists (handles repeated accept on same slug).
     * Passing null SHA on an existing file → GitHub 422 → 500; upsert avoids that. */
    const planContent = buildPlanFile(slug, parsed.frontmatter);
    let planSha = null;
    try {
      const existingPlan = await gh.getFile(vp(`projects/${slug}-plan.md`));
      planSha = existingPlan.sha;
    } catch (_) { /* file doesn't exist yet — create mode is correct */ }
    await gh.putFile(vp(`projects/${slug}-plan.md`), planContent, planSha,
      `phronesis: accept ${slug} — scaffold plan [automated]`);

    return jsonResponse({
      status: 'accepted',
      slug,
      message: 'Rebuilding — changes live in ~2 minutes'
    }, 202);

  } catch (err) {
    console.error('Accept error:', err);
    return jsonResponse({ error: 'Internal error', detail: err.message }, 500);
  }
}

/* ── GitHub Contents API wrapper ────────────────────────────────────────── */
/* encodePath: encode each segment individually so folder names with spaces or
 * '&' (e.g. "Organization & Planning") are handled correctly without encoding
 * the '/' path separators. */
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
    const resp = await fetch(`${this.base}/${encodePath(path)}`, {
      headers: this._headers()
    });
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

/* ── Minimal YAML frontmatter parser ────────────────────────────────────── */
/* Handles simple key: value pairs. No nested YAML. */
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
  const lines = Object.entries(fm)
    .map(([k, v]) => {
      /* Quote values containing colons or special chars */
      const needsQuote = /[:#,\[\]{}&*?|<>=!%@`]/.test(String(v));
      return `${k}: ${needsQuote ? '"' + String(v).replace(/"/g, '\\"') + '"' : v}`;
    });
  return `---\n${lines.join('\n')}\n---\n`;
}

/* ── Plan file template (§VII) ──────────────────────────────────────────── */
function buildPlanFile(slug, fm) {
  const title       = fm.title       || humanizeSlug(slug);
  const type        = fm.type        || 'opportunity';
  const prestige    = fm.prestige    || '';
  const deadline    = fm.deadline    || '';
  const requirement = fm.requirement || '';
  const dateAccepted = fm.date_accepted || isoDateNow();

  return `---
title: ${title}
type: ${type}
status: confirmed-pursuing
prestige: ${prestige}
deadline: ${deadline}
requirement: ${requirement}
date_accepted: ${dateAccepted}
linked_opportunity: projects/opp-${slug}
---

# ${title}

## Requirement

${requirement || 'See linked opportunity file.'}

## Deadline

${deadline || 'See linked opportunity file.'}

## Plan

<!-- Add plan details here -->

## Notes

<!-- -->
`;
}

/* ── PROJECT_MANIFEST.md row manipulation ────────────────────────────────── */
/* Finds the opp-<slug> row in the Opportunities table and moves it to        */
/* the Active Projects table. Falls back to appending if tables not found.    */
function moveOppToActive(content, slug, title) {
  /* Find the row referencing this slug */
  const rowRE = new RegExp(`^.*opp-${escapeRegex(slug)}.*$`, 'm');
  const rowMatch = rowRE.exec(content);
  if (!rowMatch) return content; /* Slug not found — return unchanged */

  const foundRow = rowMatch[0];

  /* Remove from current position */
  let updated = content.replace(rowRE, '').replace(/\n{3,}/g, '\n\n');

  /* Try to append to Active Projects table */
  const activeHeadRE = /## Active Projects[\s\S]*?(\|[^\n]+\|\n\|[-| ]+\|\n)/;
  const headMatch = activeHeadRE.exec(updated);

  if (headMatch) {
    /* Insert after the header row */
    const insertAt = updated.indexOf(headMatch[1]) + headMatch[1].length;
    updated = updated.slice(0, insertAt) + foundRow + '\n' + updated.slice(insertAt);
  } else {
    /* No active projects table — append a note */
    updated += `\n\n## Active Projects\n\n| Project | Status |\n|---|---|\n| ${title} | confirmed-pursuing |\n`;
  }

  return updated;
}

/* ── Utilities ──────────────────────────────────────────────────────────── */
function isoDateNow() {
  return new Date().toISOString().slice(0, 10);
}

function humanizeSlug(slug) {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

/* ── CF Access JWT validation ───────────────────────────────────────────── */
/* Validates the CF-Access-Jwt-Assertion header against Cloudflare's JWKS.   */
/* If CF_ACCESS_AUD is not set (dev/test), validation is skipped.            */
async function validateCFAccess(request, audience) {
  if (!audience) return null; /* Not configured — skip (dev mode) */

  const token = request.headers.get('CF-Access-Jwt-Assertion');
  if (!token) return 'Missing CF-Access-Jwt-Assertion header';

  try {
    /* Decode JWT header to get kid */
    const [headerB64] = token.split('.');
    const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));

    /* Fetch JWKS from Cloudflare Access */
    const certsUrl = `https://skeptou.cloudflareaccess.com/cdn-cgi/access/certs`;
    const certsResp = await fetch(certsUrl);
    if (!certsResp.ok) return 'Failed to fetch Access certs';
    const certs = await certsResp.json();

    /* Find matching key */
    const jwk = (certs.keys || []).find(k => k.kid === header.kid);
    if (!jwk) return 'No matching JWK for token kid';

    /* Import key and verify */
    const key = await crypto.subtle.importKey(
      'jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify']
    );

    const [, payloadB64, sigB64] = token.split('.');
    const sig = Uint8Array.from(atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
    if (!valid) return 'Invalid JWT signature';

    /* Verify audience */
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    const audMatch = Array.isArray(payload.aud)
      ? payload.aud.includes(audience)
      : payload.aud === audience;
    if (!audMatch) return 'JWT audience mismatch';

    /* Verify expiry */
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return 'JWT expired';

    return null; /* Valid */
  } catch (e) {
    return `JWT validation error: ${e.message}`;
  }
}
