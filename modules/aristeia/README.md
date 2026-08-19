# modules/aristeia — Slot 5

| | |
|---|---|
| Subdomain | `aristeia.skeptou.com` |
| Tech tier | Pages Functions + D1 + R2 |
| Spec | `specs/aristeia.md`, `specs/brief-aristeia-phase1.md` |

**Status: reset to blank slate (2026-08-18).** The v0 implementation was removed
from trunk in the qualified-blank-slate reset. This directory is preserved to hold
the module division; the v1 implementation lands here.

**Infrastructure is live and untouched.** Pages project `aristeia`; D1 `skeptou-aristeia` (`ARISTEIA_DB`); R2 `skeptou-aristeia` (`ARISTEIA_R2`); migrations retained in `migrations/`.
Reconnect to the exact resource names/IDs in `notes/DEPLOYMENT_MANIFEST.md` —
do not create new D1 databases, R2 buckets, KV namespaces, or Pages projects.

Recover the v0 code for reference:

```sh
git show v0-archive:modules/aristeia/<path>        # read one file
git checkout v0-archive -- modules/aristeia        # restore the whole tree
```
