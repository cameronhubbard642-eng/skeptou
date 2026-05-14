/**
 * GET /api/energeia/pdf/[slug]/[filename]
 *
 * Proxies PDF files from the private agora GitHub repo through to authenticated
 * browser sessions, so end users never need direct GitHub raw access.
 *
 * Filename patterns (all must end in .pdf; no slashes or traversal characters):
 *
 *   current.pdf
 *     → papers/<slug>/main.pdf @ energeia branch (latest canonical)
 *     → short cache (5 min; PDF changes on each promotion)
 *
 *   <slug>-style-<ROMAN>[.<minor>].pdf      e.g. epistemic-akrasia-style-II.pdf
 *     → papers/<slug>/main.pdf @ git tag <style-ROMAN[.minor]>
 *       (each canonical promotion tags energeia and the PDF is `main.pdf` at that tag)
 *     → immutable cache (1 year; content is frozen at the tag)
 *
 *   diff-style-<ROMAN>-style-<ROMAN>.pdf    e.g. diff-style-I-style-II.pdf
 *     → papers/<slug>/diff-style-<prev>-style-<next>.pdf @ energeia branch
 *       (promote-paper.yml commits the diff PDF to energeia alongside main.pdf)
 *     → immutable cache (1 year)
 *
 *   draft-<direction>.pdf                    e.g. draft-beta.pdf
 *     → papers/<slug>/main.pdf @ dunamis/<slug>-<direction> branch
 *       (compile-draft.yml commits main.pdf back to the dunamis branch)
 *     → no-store cache (always fresh; returns 404 until compiled)
 *
 * Auth:
 *   CF Access gates the entire energeia.skeptou.com domain, so any request
 *   reaching this function is already authenticated at the perimeter.
 *   validateCFAccess() is a belt-and-suspenders in-function check.
 *   TODO Phase 2: auth-core engineer (local_1ac2396c-8b4a-4fdc-a19d-55f5787c980b)
 *   will replace validateCFAccess() with @skeptou/auth-client requireAuth().
 *
 * Env: AGORA_DISPATCH_PAT, AGORA_REPO, CF_ACCESS_AUD
 */

/* ── Validation ──────────────────────────────────────────────────────────── */
const VALID_SLUG = /^[a-z0-9][a-z0-9-]*$/;

/*
 * ROMAN matches style-tag suffixes: style-I, style-II, style-I.1, etc.
 * Tag format used by promote-paper.yml: style-<ROMAN>[.<minor>]
 */
const R = '[IVXLCDM]+(?:\\.\\d+)?';  /* e.g. I, II, I.1, IV.2 */

/*
 * Valid filename forms (no path separators, no dotdot — character classes
 * used make directory traversal impossible):
 *   current.pdf | current-slides.pdf | current-handout.pdf
 *   <slug>-style-<ROMAN>[.<minor>].pdf
 *   <slug>-style-<ROMAN>[.<minor>]-slides.pdf
 *   <slug>-style-<ROMAN>[.<minor>]-handout.pdf
 *   diff-style-<ROMAN>[.<minor>]-style-<ROMAN>[.<minor>].pdf
 *   draft-<greek-direction>.pdf
 */
const VALID_FILENAME = new RegExp(
  `^(?:current(?:-slides|-handout)?` +
  `|[a-z0-9][a-z0-9-]+-style-${R}(?:-slides|-handout)?` +
  `|diff-style-${R}-style-${R}` +
  `|draft-[a-z0-9-]+)\\.pdf$`
);

/* Identifies tagged-version filenames: must contain "-style-" after the slug */
const TAGGED_VERSION_RE = /^(.+)-(style-[IVXLCDM]+(?:\.\d+)?)\.pdf$/;
/* Identifies diff filenames */
const DIFF_RE = /^diff-(style-[IVXLCDM]+(?:\.\d+)?)-(style-[IVXLCDM]+(?:\.\d+)?)\.pdf$/;
/* Identifies draft filenames */
const DRAFT_RE = /^draft-([a-z0-9-]+)\.pdf$/;
/* Identifies tagged slides/handout filenames */
const TAGGED_SLIDES_RE   = /^(.+)-(style-[IVXLCDM]+(?:\.\d+)?)-slides\.pdf$/;
const TAGGED_HANDOUT_RE  = /^(.+)-(style-[IVXLCDM]+(?:\.\d+)?)-handout\.pdf$/;

/* ── Route handler ───────────────────────────────────────────────────────── */
export async function onRequestGet(ctx) {
  const { env, params, request } = ctx;

  /* Auth — belt-and-suspenders; CF Access already gated the domain */
  const authErr = await validateCFAccess(request, env.CF_ACCESS_AUD);
  if (authErr) return jsonError('Unauthorized', 401);

  const { slug, filename } = params;

  if (!VALID_SLUG.test(slug))         return jsonError('Invalid slug', 400);
  if (!VALID_FILENAME.test(filename)) return jsonError('Invalid filename', 400);

  if (!env.AGORA_DISPATCH_PAT || !env.AGORA_REPO) {
    return jsonError('PDF proxy not configured (missing AGORA_DISPATCH_PAT or AGORA_REPO)', 503);
  }

  /* Resolve GitHub path + ref + cache policy */
  let ghPath, ghRef, cacheControl, displayName;

  if (filename === 'current.pdf') {
    /* Always-latest canonical: papers/<slug>/main.pdf on energeia branch */
    ghPath       = `papers/${slug}/main.pdf`;
    ghRef        = 'energeia';
    cacheControl = 'public, max-age=300';
    displayName  = `${slug}-current.pdf`;

  } else if (filename === 'current-slides.pdf') {
    /* Latest compiled slides: compiled/<slug>/<slug>-slides.pdf on energeia */
    ghPath       = `compiled/${slug}/${slug}-slides.pdf`;
    ghRef        = 'energeia';
    cacheControl = 'public, max-age=300';
    displayName  = `${slug}-current-slides.pdf`;

  } else if (filename === 'current-handout.pdf') {
    /* Latest compiled handout: compiled/<slug>/<slug>-handout.pdf on energeia */
    ghPath       = `compiled/${slug}/${slug}-handout.pdf`;
    ghRef        = 'energeia';
    cacheControl = 'public, max-age=300';
    displayName  = `${slug}-current-handout.pdf`;

  } else if (TAGGED_SLIDES_RE.test(filename)) {
    /* Tagged slides version: compiled/<slug>/<slug>-slides.pdf @ tag ref */
    const tag    = filename.match(TAGGED_SLIDES_RE)[2];
    ghPath       = `compiled/${slug}/${slug}-slides.pdf`;
    ghRef        = tag;
    cacheControl = 'public, max-age=31536000, immutable';
    displayName  = filename;

  } else if (TAGGED_HANDOUT_RE.test(filename)) {
    /* Tagged handout version: compiled/<slug>/<slug>-handout.pdf @ tag ref */
    const tag    = filename.match(TAGGED_HANDOUT_RE)[2];
    ghPath       = `compiled/${slug}/${slug}-handout.pdf`;
    ghRef        = tag;
    cacheControl = 'public, max-age=31536000, immutable';
    displayName  = filename;

  } else if (DRAFT_RE.test(filename)) {
    /* Draft PDF: papers/<slug>/main.pdf on the dunamis branch */
    const direction = filename.match(DRAFT_RE)[1];
    ghPath       = `papers/${slug}/main.pdf`;
    ghRef        = `dunamis/${slug}-${direction}`;
    cacheControl = 'no-store';
    displayName  = `${slug}-draft-${direction}.pdf`;

  } else if (DIFF_RE.test(filename)) {
    /* Diff PDF: papers/<slug>/diff-<prev>-<next>.pdf on energeia branch
       (promote-paper.yml commits it there alongside the canonical main.pdf) */
    ghPath       = `papers/${slug}/${filename}`;
    ghRef        = 'energeia';
    cacheControl = 'public, max-age=31536000, immutable';
    displayName  = filename;

  } else {
    /* Tagged canonical version: papers/<slug>/main.pdf at the git tag ref
       Filename is <slug>-style-<roman>.pdf; parse the tag back out. */
    const m = filename.match(TAGGED_VERSION_RE);
    if (!m) return jsonError('Unrecognised filename pattern', 400);
    const tag    = m[2]; /* e.g. "style-II" */
    ghPath       = `papers/${slug}/main.pdf`;
    ghRef        = tag;  /* git tag ref — promote-paper.yml tags energeia at each promotion */
    cacheControl = 'public, max-age=31536000, immutable';
    displayName  = filename;
  }

  try {
    const pdfBytes = await fetchGitHubFile(env.AGORA_DISPATCH_PAT, env.AGORA_REPO, ghPath, ghRef);

    if (pdfBytes === null) {
      const reason = filename.startsWith('draft-')
        ? 'Draft PDF not found — run "Compile draft" on the branch first.'
        : 'PDF not found — this version may not have been compiled yet.';
      return jsonError(reason, 404);
    }

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        'Content-Type':           'application/pdf',
        'Content-Disposition':    `inline; filename="${displayName}"`,
        'Cache-Control':          cacheControl,
        'X-Content-Type-Options': 'nosniff',
      },
    });

  } catch (err) {
    console.error('PDF proxy error:', slug, filename, err);
    return jsonError(`GitHub API error: ${err.message}`, 502);
  }
}

/* ── GitHub Contents API fetch ───────────────────────────────────────────── */
/**
 * Fetch a single file from a private GitHub repo.
 * Returns Uint8Array on success, null on 404, throws on other errors.
 *
 * Handles both small files (base64 inline in JSON, ≤ 1 MB) and large files
 * (signed download_url redirect, up to 100 MB).
 */
async function fetchGitHubFile(pat, repo, path, ref) {
  const url = `https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${pat}`,
      'Accept':        'application/vnd.github.v3+json',
      'User-Agent':    'energeia-skeptou/1.0',
    },
  });

  if (resp.status === 404) return null;
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`GitHub ${resp.status} for ${path}@${ref}: ${detail.slice(0, 200)}`);
  }

  const meta = await resp.json();

  if (meta.content) {
    /* Small file: content is base64-encoded inline */
    const b64 = meta.content.replace(/[\n\r]/g, '');
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  }

  if (meta.download_url) {
    /* Large file (> 1 MB): fetch via signed GitHub download URL */
    const dl = await fetch(meta.download_url, {
      headers: { 'Authorization': `Bearer ${pat}` },
    });
    if (!dl.ok) throw new Error(`Download failed: ${dl.status}`);
    return new Uint8Array(await dl.arrayBuffer());
  }

  throw new Error(`No content and no download_url for ${path}@${ref}`);
}

/* ── Utilities ───────────────────────────────────────────────────────────── */
function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/* ── CF Access JWT validation (shared pattern across energeia Workers) ───── */
async function validateCFAccess(request, audience) {
  if (!audience) return null;
  const token = request.headers.get('CF-Access-Jwt-Assertion');
  if (!token) return 'Missing CF-Access-Jwt-Assertion header';
  try {
    const [headerB64] = token.split('.');
    const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));
    const certsResp = await fetch('https://skeptou.cloudflareaccess.com/cdn-cgi/access/certs');
    if (!certsResp.ok) return 'Failed to fetch Access certs';
    const certs = await certsResp.json();
    const jwk = (certs.keys || []).find(k => k.kid === header.kid);
    if (!jwk) return 'No matching JWK';
    const key = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
    );
    const [, payloadB64, sigB64] = token.split('.');
    const sig  = Uint8Array.from(atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
    if (!valid) return 'Invalid JWT signature';
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    const audOk = Array.isArray(payload.aud) ? payload.aud.includes(audience) : payload.aud === audience;
    if (!audOk) return 'JWT audience mismatch';
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return 'JWT expired';
    return null;
  } catch (e) {
    return `JWT validation error: ${e.message}`;
  }
}
