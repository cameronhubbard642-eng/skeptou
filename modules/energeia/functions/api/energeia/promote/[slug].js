/**
 * POST /api/energeia/promote/:slug — promote a dunamis branch to canonical
 *
 * Body: { branch, note?, override? }
 *   branch   — full branch name, e.g. "dunamis/epistemic-akrasia-beta"
 *   note     — optional annotation for the tag
 *   override — "major" | "minor" | null (null = auto-classify by diff %)
 *
 * The workflow (promote-paper.yml on agora) does the actual diff computation,
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

import { requireSession } from '../../../_shared/auth.js';

export async function onRequestPost(ctx) {
  const { env, params, request } = ctx;

  const authRedirect = await requireSession(request, env);
  if (authRedirect) return authRedirect;

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

    /* Dispatch promote-paper.yml on agora repo */
    await dispatchWorkflow(env.AGORA_DISPATCH_PAT, env.AGORA_REPO,
      'promote-paper.yml', {
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

/* ── Diff estimate via GitHub Compare API ───────────────────────────────── */
async function computeDiffEstimate(pat, repo, branch, slug) {
  try {
    /* Compare energeia...branch restricted to papers/<slug>/ path */
    const url = `https://api.github.com/repos/${repo}/compare/energeia...${encodeURIComponent(branch)}`;
    const resp = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'energeia-skeptou'
      }
    });
    if (!resp.ok) return { pct: 50, additions: 0, deletions: 0, total: 0 };

    const data = await resp.json();
    const paperFiles = (data.files || []).filter(f => f.filename.startsWith(`papers/${slug}/`));

    let additions = 0, deletions = 0;
    for (const f of paperFiles) {
      additions += f.additions || 0;
      deletions += f.deletions || 0;
    }
    const changed = additions + deletions;

    /* Estimate total canonical lines: sum of base file additions in energeia */
    const totalLines = (data.files || [])
      .filter(f => f.filename.startsWith(`papers/${slug}/`) && f.status !== 'added')
      .reduce((sum, f) => sum + (f.changes || 0), 1);

    const pct = totalLines > 0 ? Math.round((changed / totalLines) * 100) : 100;
    return { pct, additions, deletions, total: totalLines };

  } catch (_) {
    /* Non-fatal: fall back to 50% so user must confirm */
    return { pct: 50, additions: 0, deletions: 0, total: 0 };
  }
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

