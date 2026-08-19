# specs/_rescued-from-mirror/

Recovered 2026-08-18 during the qualified-blank-slate reset.

These files existed **only** as untracked files in the second working copy at
`~/Claude/Projects/Sképtou`. They are in **no commit, on no branch, and not in
`v0-archive`** — `git log --all -- specs/<file>` returns nothing for every one of
them. Had that directory been cleaned, they would have been lost outright.

Four siblings recovered in the same sweep were unambiguous and went straight into
`specs/`: `apex-site.md`, `op-d1-migration.md`, `runtime-fetch-cache.md`,
`brief-scholia-phase1.md`. The three here need a human ruling, so they are
quarantined rather than merged.

**The reset session did not adjudicate these. It only rescued them.**

| File | What it is | Needs deciding |
|---|---|---|
| `scholia-rev2-ratified.md` | `specs/scholia.md` **rev 2 — "ratified — Cam 2026-05-15 (SQ-1–SQ-6 ruled)"**, 46,099 B | The committed `specs/scholia.md` is **rev 1, "awaiting Cam ratification"**, 36,761 B. Rev 2 looks strictly newer, and the rescued `specs/brief-scholia-phase1.md` cites "scholia.md rev 2". If confirmed, promote this over the committed rev 1. |
| `arestia.md` | "Arestia Professional Publications Archive", rev 1, 2026-05-16, 40,776 B | Alternate-spelling sibling of `specs/aristeia.md` (differs by 269 diff lines). Same module under a different name, or a genuine fork? |
| `pharo.md` | "Pharo Document Sharing Interface", rev 1, 2026-05-16, 42,285 B | Alternate-spelling sibling of `specs/phero.md` (differs by 984 diff lines). Same question. |

`arestia`/`pharo` are dated **after** `notes/STATE_OF_PLAY.md` records aristeia rev 2
and phero rev 4 as ratified (2026-05-15), so they are not simply superseded earlier
drafts. Read before discarding.

Delete this directory once the architecture redo has ruled on all three.
