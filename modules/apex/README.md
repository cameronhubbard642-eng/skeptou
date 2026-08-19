# modules/apex — Slot 0

| | |
|---|---|
| Subdomain | `skeptou.com (apex)` |
| Tech tier | Static (Cloudflare Pages) |
| Spec | `specs/apex-site.md` *(referenced in `notes/STATE_OF_PLAY.md`; not present in `specs/` — recover from history or re-draft)* |

**Status: reset to blank slate (2026-08-18).** The v0 implementation was removed
from trunk in the qualified-blank-slate reset. This directory is preserved to hold
the module division; the v1 implementation lands here.

**Infrastructure is live and untouched.** Pages project `skeptou`, custom domain `skeptou.com`. **Public surface — PR + explicit Cam approval required before any deploy.**
Reconnect to the exact resource names/IDs in `notes/DEPLOYMENT_MANIFEST.md` —
do not create new D1 databases, R2 buckets, KV namespaces, or Pages projects.

Recover the v0 code for reference:

```sh
git show v0-archive:modules/apex/<path>        # read one file
git checkout v0-archive -- modules/apex        # restore the whole tree
```
