/**
 * POST /api/energeia/promote/:slug — promote a dunamis branch to canonical
 *
 * Body: { branch, note?, override? }
 *   branch   — full branch name, e.g. "dunamis/epistemic-akrasia-beta"
 *   note     — optional annotation for the tag
 *   override — "major" | "minor" | null (null = auto-classify by diff %)
 *
 * The workflow (promote.yml on agora) does the actual diff computation,
 * tag application, xelatex compile, and latexdiff.
 *
 * This Worker pre-computes a diff-percentage estimate via GitHub Compare API
 * and includes the classification in the workflow dispatch inputs so the
 * promote UI can show the preview without waiting for the workflow to run.
 *
 * Env:
 *   AGORA_DISPATCH_PAT, AGORA_REPO, HMAC_SECRET, AUTH_DOMAIN
 */

const DIFF_THRESHOLD_PCT = 10; /* % changed lines → major vs minor */

import { validateSession } from '../../../_shared/auth.js';

export async function onRequestPost(ctx) {
  const { env, params, request } = ctx;

  const auth = await validateSession(request, env);
  if (!auth.authenticated) return jsonResponse({ error: 'Unauthorized — no active session' }, 401);

  const slug = params.slug;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return jsonResponse({ error: 'Invalid slug' }, 400);
  }

  let body;
  try { body = await request.json(); }
  catch (_) { return jsonResponse({ error: 'Invalid JSON body' }, 400); }

  const { branch, note = '', override = null } = body;

  /* Validate branch name: must be dunamis/<slug>-<greek> */
  const branchRE = /^dunamis\/[a-z0-9-]+-[a-z]+$/;
  if (!branch || !branchRE.test(branch)) {
    return jsonResponse({ error: `branch must match dunamis/<slug>-<greek>, got: ${branch}` }, 400);
  }

  if (override !== null && override !== 'major' && override !== 'minor') {
    return jsonResponse({ error: 'override must be "major", "minor", or null' }, 400);
  }

  try {
    /* Compute diff estimate via GitHub Compare API */
    const diffInfo = await computeDiffEstimate(
      env.AGORA_DISPATCH_PAT, env.AGORA_REPO, branch, slug
    );

    const autoClass = diffInfo.pct > DIFF_THRESHOLD_PCT ? 'major' : 'minor';
    const classification = override || autoClass;
    const classSource    = override ? `forced-${override}` : 'auto';

    /* Determine next tag based on classification */
    const nextTag = await computeNextTag(
      env.AGORA_DISPATCH_PAT, env.AGORA_REPO, slug, classification
    );

    /* Dispatch promote.yml on agora repo */
    await dispatchWorkflow(env.AGORA_DISPATCH_PAT, env.AGORA_REPO,
      'promote.yml', {
        branch,
        slug,
        note: note || '',
        classification,
        class_source: classSource,
        next_tag: nextTag
      });

    return jsonResponse({
      status: 'dispatched',
      slug,
      branch,
      classification,
      class_source: classSource,
      diff_pct:  diffInfo.pct,
      threshold: DIFF_THRESHOLD_PCT,
      next_tag:  nextTag,
      message:   `Promotion dispatched — ${classification} → ${nextTag}. Workflow running on agora.`
    }, 202);

  } catch (err) {
    console.error('Promote error:', err);
    return jsonResponse({ error: 'Internal error', detail: err.message }, 500);
  }
}

/**
 * GET /api/energeia/promote/:slug?branch=...&override=...
 *
 * Diff-estimate preview for the promote modal. Computes the same diff %,
 * classification, and next tag as the POST path but does NOT dispatch the
 * workflow — so the modal shows the real numbers instead of a mock.
 */
export async function onRequestGet(ctx) {
  const { env, params, request } = ctx;

  const auth = await validateSession(request, env);
  if (!auth.authenticated) return jsonResponse({ error: 'Unauthorized — no active session' }, 401);

  const slug = params.slug;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return jsonResponse({ error: 'Invalid slug' }, 400);
  }

  const url      = new URL(request.url);
  const branch   = url.searchParams.get('branch') || '';
  const override = url.searchParams.get('override') || null;

  const branchRE = /^dunamis\/[a-z0-9-]+-[a-z]+$/;
  if (!branchRE.test(branch)) {
    return jsonResponse({ error: `branch must match dunamis/<slug>-<greek>, got: ${branch}` }, 400);
  }
  if (override !== null && override !== 'major' && override !== 'minor') {
    return jsonResponse({ error: 'override must be "major", "minor", or null' }, 400);
  }

  try {
    const diffInfo = await computeDiffEstimate(
      env.AGORA_DISPATCH_PAT, env.AGORA_REPO, branch, slug
    );
    const autoClass      = diffInfo.pct > DIFF_THRESHOLD_PCT ? 'major' : 'minor';
    const classification = override || autoClass;
    const nextTag = await computeNextTag(
      env.AGORA_DISPATCH_PAT, env.AGORA_REPO, slug, classification
    );

    return jsonResponse({
      slug,
      branch,
      diff_pct:            diffInfo.pct,
      threshold:           DIFF_THRESHOLD_PCT,
      additions:           diffInfo.additions,
      deletions:           diffInfo.deletions,
      total_lines:         diffInfo.total,
      auto_classification: autoClass,
      classification,
      class_source:        override ? `forced-${override}` : 'auto',
      next_tag:            nextTag
    });
  } catch (err) {
    console.error('Promote estimate error:', err);
    return jsonResponse({ error: 'Internal error', detail: err.message }, 500);
  }
}

/* ── Diff estimate ──────────────────────────────────────────────────────────
 * pct = (lines changed in papers/<slug>/ between energeia and the dunamis
 *        branch) / (total lines of the canonical .tex files on energeia).
 *
 * The numerator comes from the GitHub Compare API; the denominator is the
 * real canonical line count — fetched from the energeia tree — NOT the count
 * of *changed* lines. (The previous version used changed-lines as the
 * denominator, which forced pct≈100% and pinned every promotion to "major".)
 * This mirrors promote.yml's "Compute actual diff percentage" step.
 */
async function computeDiffEstimate(pat, repo, branch, slug) {
  const headers = {
    'Authorization': `Bearer ${pat}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'energeia-skeptou'
  };

  /* Numerator — changed lines under papers/<slug>/ (branch name is validated
     to ^dunamis/[a-z0-9-]+-[a-z]+$, so the literal '/' is path-safe here;
     percent-encoding it breaks the Compare API). */
  let additions = 0, deletions = 0;
  try {
    const cmp = await fetch(
      `https://api.github.com/repos/${repo}/compare/energeia...${branch}`,
      { headers }
    );
    if (cmp.ok) {
      const data = await cmp.json();
      for (const f of (data.files || [])) {
        if (!f.filename.startsWith(`papers/${slug}/`)) continue;
        additions += f.additions || 0;
        deletions += f.deletions || 0;
      }
    }
  } catch (_) { /* numerator stays 0 */ }
  const changed = additions + deletions;

  /* Denominator — total lines of canonical .tex files on the energeia branch. */
  let totalLines = 0;
  try {
    const tree = await fetch(
      `https://api.github.com/repos/${repo}/git/trees/energeia?recursive=1`,
      { headers }
    );
    if (tree.ok) {
      const td = await tree.json();
      const texBlobs = (td.tree || []).filter(e =>
        e.type === 'blob' &&
        e.path.startsWith(`papers/${slug}/`) &&
        e.path.endsWith('.tex'));
      for (const blob of texBlobs) {
        const br = await fetch(
          `https://api.github.com/repos/${repo}/git/blobs/${blob.sha}`,
          { headers }
        );
        if (!br.ok) continue;
        const bd = await br.json();
        if (bd.content) {
          totalLines += atob(bd.content.replace(/\s/g, '')).split('\n').length;
        }
      }
    }
  } catch (_) { /* denominator stays 0 */ }

  const pct = totalLines > 0
    ? Math.round((changed / totalLines) * 100)
    : (changed > 0 ? 100 : 0);
  return { pct, additions, deletions, total: totalLines };
}

/* ── Next tag computation ───────────────────────────────────────────────── */
async function computeNextTag(pat, repo, slug, classification) {
  try {
    /* List tags for this paper: style-* scoped to slug via annotation lookup */
    const url = `https://api.github.com/repos/${repo}/git/refs/tags/style-`;
    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'energeia-skeptou'
      }
    });
    if (!resp.ok) return classification === 'major' ? 'style-I' : 'style-I.1';

    /* Tags are global on agora; look for paper-specific annotation in tag message */
    /* For now, count all style-* tags and derive — this is a v1 approximation */
    const refs = await resp.json();
    const majorTags = refs
      .map(r => r.ref.replace('refs/tags/', ''))
      .filter(t => /^style-[IVXLCDM]+$/.test(t));

    if (majorTags.length === 0) {
      return classification === 'major' ? 'style-I' : 'style-I.1';
    }

    /* Find the latest major tag */
    const latestMajor = majorTags.sort(compareRomanTags).at(-1);

    if (classification === 'major') {
      const n = romanToInt(latestMajor.replace('style-', ''));
      return `style-${intToRoman(n + 1)}`;
    } else {
      /* Find the highest minor tag under latestMajor */
      const minorTags = refs
        .map(r => r.ref.replace('refs/tags/', ''))
        .filter(t => t.startsWith(`${latestMajor}.`));
      if (minorTags.length === 0) return `${latestMajor}.1`;
      const maxMinor = Math.max(...minorTags.map(t => parseInt(t.split('.').at(-1), 10)));
      return `${latestMajor}.${maxMinor + 1}`;
    }

  } catch (_) {
    return classification === 'major' ? 'style-I' : 'style-I.1';
  }
}

function compareRomanTags(a, b) {
  return romanToInt(a.replace('style-', '')) - romanToInt(b.replace('style-', ''));
}

function romanToInt(s) {
  const V = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let val = 0;
  for (let i = 0; i < s.length; i++) {
    const cur = V[s[i]] || 0, nxt = V[s[i + 1]] || 0;
    val += cur < nxt ? -cur : cur;
  }
  return val;
}

function intToRoman(n) {
  const map = [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],
               [50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']];
  let out = '';
  for (const [v, s] of map) { while (n >= v) { out += s; n -= v; } }
  return out;
}

/* ── GitHub Actions dispatch ────────────────────────────────────────────── */
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

/* ── Utilities ──────────────────────────────────────────────────────────── */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

