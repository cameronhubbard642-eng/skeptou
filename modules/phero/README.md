# modules/phero — Slot 3

| | |
|---|---|
| Subdomain | `phero.skeptou.com` |
| Tech tier | Worker + Assets + D1 |
| Spec | `specs/phero.md`, `specs/brief-phero-phase1.md` |

**Status: reset to blank slate (2026-08-18).** The v0 implementation was removed
from trunk in the qualified-blank-slate reset. This directory is preserved to hold
the module division; the v1 implementation lands here.

**Infrastructure is live and untouched.** Worker `phero-worker` on `phero.skeptou.com/*`; D1 `skeptou-phero` (`PHERO_DB`); migrations retained in `migrations/`.
Reconnect to the exact resource names/IDs in `notes/DEPLOYMENT_MANIFEST.md` —
do not create new D1 databases, R2 buckets, KV namespaces, or Pages projects.

Recover the v0 code for reference:

```sh
git show v0-archive:modules/phero/<path>        # read one file
git checkout v0-archive -- modules/phero        # restore the whole tree
```
