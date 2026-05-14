# Phase 3 Cutover Sequence — Disable CF Access, Promote HMAC Auth

## Context

After Phase 2 (this PR), phronesis and energeia Pages Functions validate auth via
HMAC session cookies issued by `auth.skeptou.com`. The `_middleware.js` gate also
protects all Quartz static content for both modules.

**CF Access is still active and provides a second layer.** Phase 3 removes CF Access
once HMAC auth is verified working in production, making `auth.skeptou.com` the sole
auth provider.

---

## Pre-conditions (must be true before Phase 3)

1. Phase 2 is deployed and in production.
2. `auth.skeptou.com` is live, `HMAC_SECRET` is set as a Pages secret on both
   phronesis and energeia.
3. You have confirmed a login flow end-to-end: visit phronesis or energeia, get
   redirected to `auth.skeptou.com/login`, complete magic-link login, land back
   on the target page with a valid `__skeptou_session` cookie.
4. QA has verified the `_middleware.js` gate rejects unauthenticated requests
   (fresh incognito session → login redirect).

---

## Sequence

### Step 1 — Set HMAC_SECRET on both Pages projects

```bash
# phronesis
wrangler pages secret put HMAC_SECRET --project-name phronesis

# energeia
wrangler pages secret put HMAC_SECRET --project-name energeia
```

Also set AUTH_DOMAIN if overriding the default:
```bash
wrangler pages secret put AUTH_DOMAIN --project-name phronesis   # if not auth.skeptou.com
wrangler pages secret put AUTH_DOMAIN --project-name energeia
```

Trigger a Pages deployment after setting secrets (or push any commit to main).

### Step 2 — Smoke-test HMAC auth with CF Access still on

Visit `https://phronesis.skeptou.com` in an incognito window:

1. CF Access gate intercepts → Cloudflare Access login (existing flow).
2. After CF Access clears, the HMAC middleware fires — no session cookie yet.
3. Redirect to `auth.skeptou.com/login?next=...` — this is the new flow working.
4. Complete magic-link login. Session cookie is set.
5. `_middleware.js` validates cookie. Page loads.

This confirms HMAC auth works end-to-end while CF Access is still present as a
belt-and-suspenders layer.

Also exercise the API endpoints (POST to `/api/opportunity/accept/test-slug`,
expect a 302 redirect to login, not a 401) to confirm `requireSession` works.

### Step 3 — Remove CF Access policies (phronesis first)

In the Cloudflare dashboard → Zero Trust → Access → Applications:

1. Open the phronesis application policy.
2. Set the policy action to **Bypass** for the phronesis domain (or delete the
   application entry entirely).
3. Wait ~60 seconds for propagation.
4. Verify: fresh incognito visit to phronesis → redirected to `auth.skeptou.com`
   (not Cloudflare Access login). Confirm HMAC auth completes successfully.

Repeat for energeia once phronesis is confirmed clean.

### Step 4 — Remove CF_ACCESS_AUD secrets

The `CF_ACCESS_AUD` secret is no longer read by any function (it was removed in
Phase 2). Clean it up to avoid confusion:

```bash
wrangler pages secret delete CF_ACCESS_AUD --project-name phronesis
wrangler pages secret delete CF_ACCESS_AUD --project-name energeia
```

### Step 5 — Final QA pass

Run through the full QA checklist:

- [ ] Unauthenticated desktop browser → login redirect
- [ ] Unauthenticated mobile browser → login redirect
- [ ] Unauthenticated incognito → login redirect
- [ ] After login: phronesis static Quartz pages load
- [ ] After login: energeia static Quartz pages load
- [ ] After login: API endpoints (accept/reject/task for phronesis;
      papers/directions/promote/archive/compile-draft/daemon/register for energeia)
      return functional responses (not auth errors)
- [ ] Daemon `actions/next` and `actions/[id]/complete` still work with Bearer token
      (no session cookie required — these are daemon-token paths, unchanged)
- [ ] Session expiry: wait for cookie to expire (or manually clear it) → redirect
      back to login

---

## Rollback

If HMAC auth is broken in prod before CF Access is removed, no rollback is needed —
CF Access still gates everything. Fix the issue (likely `HMAC_SECRET` not set or
wrong value) and redeploy.

If HMAC auth breaks AFTER CF Access is removed:
- Re-enable the CF Access policy (Bypass → Allow) in the dashboard immediately.
- This restores the outer gate while the HMAC issue is diagnosed.

---

## Notes

- The daemon token paths (`/api/energeia/actions/next` and
  `/api/energeia/actions/[id]/complete`) use Bearer token auth and are intentionally
  excluded from `_middleware.js` (the `/api/` bypass). They remain unchanged and
  do not require a session cookie.
- `daemon/register.js` now requires session auth (added in Phase 2). This is
  intentional: only an authenticated user can register a daemon token.
- Both `_middleware.js` files pass through to `ctx.next()` after auth, which routes
  to CF Pages static assets (Quartz output) or the matching Pages Function.
