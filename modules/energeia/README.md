# modules/energeia — Slot 2

| | |
|---|---|
| Subdomain | `energeia.skeptou.com` |
| Tech tier | Pages Functions + GitHub Actions |
| Spec | `specs/energeia.md`, `specs/brief-energeia-content-endpoint.md` |

**Status: reset to blank slate (2026-08-18).** The v0 implementation was removed
from trunk in the qualified-blank-slate reset. This directory is preserved to hold
the module division; the v1 implementation lands here.

**Infrastructure is live and untouched.** Pages project `energeia`; KV `ENERGEIA_ACTIONS` (id not in repo — read it from the CF dashboard). The local daemon (`daemon/energeia-daemon.py` in v0) and the agora compile workflows were removed with the rest of the v0 code.
Reconnect to the exact resource names/IDs in `notes/DEPLOYMENT_MANIFEST.md` —
do not create new D1 databases, R2 buckets, KV namespaces, or Pages projects.

Recover the v0 code for reference:

```sh
git show v0-archive:modules/energeia/<path>        # read one file
git checkout v0-archive -- modules/energeia        # restore the whole tree
```
