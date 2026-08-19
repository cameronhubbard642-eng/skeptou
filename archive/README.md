# archive/

Holding area for data pulled off live infrastructure during the qualified-blank-slate
reset. **Not** for v0 source code — that lives in the annotated tag `v0-archive`
(pushed to `origin`), recoverable with `git checkout v0-archive -- <path>`.

**Everything under `archive/` is gitignored except this README.** The dumps carry
Cam's personal planning data — commitments, tasks, projects, opportunities, audit
log. Keep them local or in encrypted backup; they must never reach `origin`.

## phronesis D1 reset — DONE (2026-08-18)

Performed via the Cloudflare D1 MCP, not the script below. Cam authorized
"wipe all data, repopulate once the architecture works."

- **Database:** `skeptou-op` / `6321abe6-ed91-4577-8d82-c9dbf688795c` (phronesis)
- **Backup:** `archive/phronesis-backup-2026-08-18/` — `tasks.json` (full dump),
  `small-tables.json` (commitments, projects, opportunities, audit_log), plus its
  own README with provenance.
- **Verified row counts at backup:** tasks 154, commitments 8, projects 4,
  opportunities 8, inventory 0, audit_log 10, service_tokens 0. Re-counted from
  the dump files 2026-08-18 — tasks/commitments/projects/opportunities all match.
- **Result:** rows deleted; **tables, schema, and migration state preserved.**
- **Second line of defence:** this D1 was populated *from* the O&P project's
  markdown source-of-truth (`specs/op-d1-migration.md` — "initial population via
  O&P specialist API writes"), so the canonical planning data still lives in the
  O&P project files. The dump is belt-and-suspenders.

**Glossolalia D1 `2c8387bb-9ce3-46a6-9f06-c1d8ec5b5537` — backing Cam's live
Taller de Traducción / Übersetzungswerkstatt apps — was never touched.**
That UUID appears nowhere in this repository.

## scripts/phronesis-d1-reset.sh

Written for this reset but **never run** — wrangler's OAuth had expired and the
work was done through the D1 MCP instead. Retained as a guarded, re-runnable
utility if the database ever needs clearing again. It exports first, verifies the
dump is non-empty, then drops and re-migrates; it refuses to run unless
`skeptou-op` resolves to the expected UUID and hard-aborts on the Glossolalia UUID.
