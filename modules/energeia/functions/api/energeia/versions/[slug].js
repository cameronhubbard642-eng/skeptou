/**
 * GET /api/energeia/versions/:slug — version history for a paper
 *
 * Promotions are recorded as annotated git tags on agora in a per-paper
 * namespace: refs/tags/<slug>/style-<ROMAN> for majors, refs/tags/<slug>/
 * style-<ROMAN>.<n> for minor patches. The display name (returned as `tag`)
 * is just the suffix (style-V), since the slug prefix is a git-namespace
 * concern, not user-visible.
 *
 * promote.yml writes the tag message as:
 *
 *   <slug>/style-V
 *   slug: <slug>
 *   source: dunamis/<slug>-<direction>
 *   classification: major|minor
 *   class_source: auto|forced-major|forced-minor
 *   diff_pct: NN%
 *   note: <free text>
 *
 * Returned oldest-first with minor patches grouped under their major. The
 * paper-detail page loads this lazily.
 *
 * Response: { slug, versions: [ { tag, date, note, lineage, classification, minors:[…] } ] }
 *
 * Env: AGORA_DISPATCH_PAT, AGORA_REPO, HMAC_SECRET, AUTH_DOMAIN
 */

import { validateSession } from '../../../_shared/auth.js';

export async function onRequestGet(ctx) {
  const { env, params, request } = ctx;

  const auth = await validateSession(request, env);
  if (!auth.authenticated) return jsonResponse({ error: 'Unauthorized — no active session' }, 401);

  const slug = params.slug;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    return jsonResponse({ error: 'Invalid slug' }, 400);
  }
  if (!env.AGORA_DISPATCH_PAT || !env.AGORA_REPO) {
    return jsonResponse({ slug, versions: [] });
  }

  const headers = {
    'Authorization': `Bearer ${env.AGORA_DISPATCH_PAT}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'energeia-skeptou',
  };

  try {
    /* Refs under tags/<slug>/style- — per-paper namespace, no cross-paper
       filtering needed (prefix match → array, or 404 when this paper has
       no promotions). */
    const refsResp = await fetch(
      `https://api.github.com/repos/${env.AGORA_REPO}/git/refs/tags/${slug}/style-`,
      { headers });
    if (refsResp.status === 404) return jsonResponse({ slug, versions: [] });
    if (!refsResp.ok) return jsonResponse({ slug, versions: [] });
    const refs = await refsResp.json();
    const refList = Array.isArray(refs) ? refs : [refs];

    const items = [];
    for (const ref of refList) {
      const suffix = (ref.ref || '').replace(`refs/tags/${slug}/`, '');
      if (!/^style-[IVXLCDM]+(\.\d+)?$/.test(suffix)) continue;

      let message = '', date = '';
      if (ref.object && ref.object.type === 'tag') {
        const tagResp = await fetch(
          `https://api.github.com/repos/${env.AGORA_REPO}/git/tags/${ref.object.sha}`,
          { headers });
        if (tagResp.ok) {
          const t = await tagResp.json();
          message = t.message || '';
          date = (t.tagger && t.tagger.date) ? t.tagger.date.slice(0, 10) : '';
        }
      }
      const meta = parseTagMessage(message);

      items.push({
        tag:            suffix,           /* display label — slug prefix stripped */
        date,
        note:           meta.note || '',
        lineage:        meta.source || '',
        classification: meta.classification || (suffix.includes('.') ? 'minor' : 'major'),
      });
    }

    return jsonResponse({ slug, versions: groupVersions(items) });

  } catch (err) {
    console.error('versions error:', slug, err);
    return jsonResponse({ slug, versions: [], error: err.message });
  }
}

/* Parse the "key: value" lines of a promote tag annotation. */
function parseTagMessage(message) {
  const meta = {};
  for (const line of message.split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k) meta[k] = v;
  }
  return meta;
}

/* Group style-<ROMAN>.<n> minors under their style-<ROMAN> major,
   majors ascending by Roman value, minors ascending by patch number. */
function groupVersions(items) {
  const MAJOR = /^style-([IVXLCDM]+)$/;
  const MINOR = /^style-([IVXLCDM]+)\.(\d+)$/;
  const majors = {};
  const minors = {};

  for (const it of items) {
    let m;
    if ((m = MAJOR.exec(it.tag))) {
      majors[m[1]] = Object.assign({}, it, { minors: [] });
    } else if ((m = MINOR.exec(it.tag))) {
      (minors[m[1]] = minors[m[1]] || []).push(Object.assign({}, it, { _n: parseInt(m[2], 10) }));
    }
  }

  return Object.keys(majors)
    .sort((a, b) => romanToInt(a) - romanToInt(b))
    .map((roman) => {
      const v = majors[roman];
      v.minors = (minors[roman] || [])
        .sort((a, b) => a._n - b._n)
        .map((mn) => { delete mn._n; return mn; });
      return v;
    });
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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
