# modules/phronesis — Slot 1

| | |
|---|---|
| Subdomain | `phronesis.skeptou.com` |
| Tech tier | Quartz + Pages Functions + D1 |
| Spec | `specs/phronesis.md`, `specs/op-d1-migration.md` |

**Status: reset to blank slate (2026-08-18).** The v0 implementation was removed
from trunk in the qualified-blank-slate reset. This directory is preserved to hold
the module division; the v1 implementation lands here.

**Infrastructure is live and untouched.** Pages project `phronesis`; D1 `skeptou-op` (`OP_DB`, `6321abe6-…`) — schema migrations retained in `migrations/`; also hosts the shared `service_tokens` table other modules read.
Reconnect to the exact resource names/IDs in `notes/DEPLOYMENT_MANIFEST.md` —
do not create new D1 databases, R2 buckets, KV namespaces, or Pages projects.

Recover the v0 code for reference:

```sh
git show v0-archive:modules/phronesis/<path>        # read one file
git checkout v0-archive -- modules/phronesis        # restore the whole tree
```
