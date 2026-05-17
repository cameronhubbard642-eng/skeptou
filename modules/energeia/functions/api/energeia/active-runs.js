/**
 * GET /api/energeia/active-runs — workflow runs currently queued or in progress
 *
 * The energeia UI polls this to grey out buttons whose workflow is still
 * running. Each agora workflow sets a run-name of the form
 *
 *   <kind-label> | <slug> | <ref>
 *
 * (ref is the dunamis branch for draft/word/promote, the direction name for
 * create-direction, and absent for canonical/delete-paper). This Worker reads
 * the GitHub Actions runs list, keeps the non-completed ones, parses the
 * run-name, and returns a compact list the UI matches against its buttons.
 *
 * Response: { runs: [ { kind, slug, ref, status, url } ] }
 *
 * Env: AGORA_DISPATCH_PAT, AGORA_REPO, HMAC_SECRET, AUTH_DOMAIN
 */

import { validateSession } from '../../_shared/auth.js';

/* run-name label (first ` | ` field) -> stable kind used by the UI */
const KIND = {
  'compile-draft':    'draft',
  'compile-canonical':'canonical',
  'compile-word':     'word',
  'promote':          'promote',
  'create-direction': 'create-direction',
  'delete-paper':     'delete-paper',
};

export async function onRequestGet(ctx) {
  const { env, request } = ctx;

  const auth = await validateSession(request, env);
  if (!auth.authenticated) return jsonResponse({ error: 'Unauthorized — no active session' }, 401);

  if (!env.AGORA_DISPATCH_PAT || !env.AGORA_REPO) {
    return jsonResponse({ runs: [] });
  }

  try {
    /* Recent runs, newest first — active runs are always among the most recent. */
    const resp = await fetch(
      `https://api.github.com/repos/${env.AGORA_REPO}/actions/runs?per_page=60`,
      {
        headers: {
          'Authorization': `Bearer ${env.AGORA_DISPATCH_PAT}`,
          'Accept':        'application/vnd.github.v3+json',
          'User-Agent':    'energeia-skeptou',
        },
      }
    );
    if (!resp.ok) return jsonResponse({ runs: [] });

    const data = await resp.json();
    const runs = [];
    for (const run of (data.workflow_runs || [])) {
      /* status is one of: queued, in_progress, requested, waiting, pending, completed */
      if (run.status === 'completed') continue;
      const parsed = parseRunName(run.display_title || '');
      if (!parsed) continue;
      runs.push({ ...parsed, status: run.status, url: run.html_url });
    }
    return jsonResponse({ runs });

  } catch (err) {
    console.error('active-runs error:', err);
    return jsonResponse({ runs: [] });
  }
}

function parseRunName(title) {
  const parts = title.split(' | ');
  const kind = KIND[(parts[0] || '').trim()];
  if (!kind) return null;
  const slug = (parts[1] || '').trim();
  if (!slug) return null;
  const ref = (parts[2] || '').trim();
  return { kind, slug, ref };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
