# archive/

Holding area for data pulled off live infrastructure during the qualified-blank-slate
reset. **Not** for v0 source code — that lives in the annotated tag `v0-archive`
(pushed to `origin`), recoverable with `git checkout v0-archive -- <path>`.

## Contents

| File | Status |
|---|---|
| `phronesis-d1-dump-<date>.sql` | **Not yet produced.** See below. |

D1 dumps are **gitignored** — the phronesis dump contains Cam's personal planning
data (commitments, projects, tasks, opportunities, audit log) and must not enter
version control. Keep it locally, or in encrypted backup, not here-on-`origin`.

## Pending: phronesis D1 export + clear

Step 3 of the reset could not run. `wrangler`'s OAuth token expired **2026-07-17**
and its refresh token is rejected; `wrangler login` needs an interactive browser,
and this environment is non-interactive. Nothing was exported and **nothing was
cleared** — the phronesis D1 is still fully populated.

To complete it:

```sh
export CLOUDFLARE_API_TOKEN=…      # D1:Edit on account 0eac870edbebb135e71b572f0bb8e83b
./scripts/phronesis-d1-reset.sh
```

`scripts/phronesis-d1-reset.sh` exports first, verifies the dump is non-empty,
then drops every user object and re-applies `modules/phronesis/migrations/`.
It refuses to run unless `skeptou-op` resolves to `6321abe6-ed91-4577-8d82-c9dbf688795c`,
and hard-aborts if it ever sees the Glossolalia UUID.

**Glossolalia D1 `2c8387bb-9ce3-46a6-9f06-c1d8ec5b5537` — backing Cam's live
Taller de Traducción / Übersetzungswerkstatt apps — is never touched by anything here.
That UUID appears nowhere in this repository.**
