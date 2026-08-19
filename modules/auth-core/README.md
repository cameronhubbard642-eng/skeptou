# modules/auth-core — Slot —

| | |
|---|---|
| Subdomain | `auth.skeptou.com` |
| Tech tier | Worker + KV (cross-cutting) |
| Spec | `specs/auth-core.md` |

**Status: reset to blank slate (2026-08-18).** The v0 implementation was removed
from trunk in the qualified-blank-slate reset. This directory is preserved to hold
the module division; the v1 implementation lands here.

**Infrastructure is live and untouched.** Worker `auth-skeptou` on `auth.skeptou.com`; KV `AUTH_KV` = `f43938aca3b6436d96f33d1377db2974` — **holds live sessions and the allowlist; do not clear.** The `[env.glossolalia]` target in `wrangler.toml` is Phase 4 and was never deployed.
Reconnect to the exact resource names/IDs in `notes/DEPLOYMENT_MANIFEST.md` —
do not create new D1 databases, R2 buckets, KV namespaces, or Pages projects.

Recover the v0 code for reference:

```sh
git show v0-archive:modules/auth-core/<path>        # read one file
git checkout v0-archive -- modules/auth-core        # restore the whole tree
```
