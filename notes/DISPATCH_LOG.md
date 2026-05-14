# DISPATCH_LOG — Sképtou

Dispatch's working notes. Not authoritative — STATE_OF_PLAY is. Never overrides STATE_OF_PLAY.

---

## 2026-05-13

### PR workflow established (Cam directive)

All Sképtou work merges to `main` via pull request. No direct pushes.

- **Self-merge allowed:** `modules/energeia/` and all non-apex paths, after PR review.
- **Cam approval required before merge:** `modules/apex/`, `agora/website/` (public surface of skeptou.com).

### Current open PRs

| PR | Branch | Contents | Merge rule |
|---|---|---|---|
| #1 | *(energeia baseline)* | energeia baseline + mobile + template migration | Awaiting Cam review — do not self-merge |
| #3 | `claude/exciting-greider-354907` | register.js CF Access JWT fix (already cherry-picked to main) | Can close or self-merge; content already in main |
| — | `claude/exciting-greider-354907` | Daemon KV-direct polling patch (`8f718b0`) | Needs PR → self-merge eligible (energeia path) |

**Next action:** open a PR for the daemon KV patch (`8f718b0` on `claude/exciting-greider-354907`) and self-merge, or wait until Cam is ready to batch-merge with other energeia work.

<!-- dispatch-watch: 2026-05-13T21:42:00Z | journal:- | drafts:- | artifacts:- | reviews:- | log-tail-hash:init | state-tail-hash:init -->
