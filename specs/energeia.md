# Module Spec — `energeia.skeptou.com`

**Slot:** 2  
**Owner:** Lead Dev / Architect  
**Status:** ACTIVE — daemon deployed, branch architecture live  
**Last revised:** 2026-05-14

---

## §I. Purpose and Scope

`energeia.skeptou.com` is the private papers and writing pipeline. It surfaces Cam's academic papers — canonical versions, direction drafts, version history, and PDF artifacts — and provides the UI for all paper lifecycle operations (create direction, compile draft, promote to canonical, archive, delete). All compilation is delegated to GitHub Actions workflows running in the private `agora` repo.

**In scope:**
- Paper registry from `agora:energeia` branch (`slugs.yaml`)
- Direction branch management (`dunamis/<slug>-<dir>` branches)
- Draft PDF compilation via `compile-draft.yml` / `promote-paper.yml`
- Paper-level archive and permanent delete
- Local daemon: worktree management, Scrivener scaffolding, file-watcher auto-commit

**Out of scope:**
- LaTeX editing (Scrivener + external-folder sync; Cam handles locally)
- PDF rendering (GitHub Actions only)
- Multi-user access (single user: Cam only)

---

## §II. Branch Architecture

```
agora (repo)
├── main          — O&P Obsidian vault + root LaTeX templates
├── energeia      — paper registry: papers/, working/, compiled/, slugs.yaml, templates/
└── dunamis/
    ├── <slug>-alpha    — active direction branch (branched from energeia)
    ├── <slug>-beta     — active direction branch
    └── archive/dunamis/<slug>-*  — archived direction branches
```

**Invariant:** `energeia` must contain *only* paper-scoped content — `papers/`, `working/`, `compiled/`, `slugs.yaml`, `templates/`, `.github/`. Vault content (`Organization & Planning/`, `.auto-memory/`, `.claude/`) must never appear on `energeia` or any `dunamis/` branch.

**Local worktrees** (managed by daemon):
- `AGORA_PATH` (`~/Documents/agora`) — main git clone; daemon's git operation home
- `WORKTREES_PATH` (`~/Documents/agora-worktrees/dunamis/`) — per-direction working copies

---

## §III. `slugs.yaml` Schema

```yaml
papers:
  - slug: "my-paper"
    title: "Full Paper Title"
    status: active          # active | archived
    format: article         # article | slides | dual | letter
    currentTag: style-I
    directions:
      dunamis:
        alpha: { label: "Alpha direction", branch: "dunamis/my-paper-alpha" }
      archived-dunamis:
        beta: { label: "Beta direction", branch: "archive/dunamis/my-paper-beta" }
```

---

## §IV. Daemon — Action System

The local daemon (`daemon/energeia-daemon.py`) polls `ENERGEIA_ACTIONS` KV every 5 seconds for pending actions and executes them locally. Cloudflare Workers enqueue actions; the daemon claims and executes them.

### Action handlers

| Type | Handler | Effect |
|---|---|---|
| `create-worktree` | `handle_create_worktree` | `git worktree add` + sparse-checkout init |
| `remove-worktree` | `handle_remove_worktree` | `git worktree remove --force` |
| `scaffold-scrivener-project` | `handle_scaffold_scrivener_project` | Copy `.scriv` template or create stub |
| `duplicate-scrivener-project` | `handle_duplicate_scrivener_project` | `shutil.copytree` source → direction |
| `archive-scrivener-project` | `handle_archive_scrivener_project` | Move `.scriv` to `archive/` subdirectory |
| `configure-scrivener-compile-target` | `handle_configure_scrivener_compile_target` | Desktop notification (manual step) |

### File watcher

`PaperWatcher` (watchdog) monitors `WORKTREES_PATH` recursively. Changes inside any `papers/` subdirectory are debounced 8 seconds, then auto-committed and pushed to `dunamis/<slug>-<direction>`.

---

## §V. Sparse-Checkout Convention

**Problem:** `dunamis/<slug>-<dir>` branches are cut from `energeia`, which contains all papers. Without sparse-checkout, each local worktree contains every paper's `papers/`, `working/`, and `compiled/` directories — confusing for Scrivener external-folder sync and wasteful on disk.

**Convention:** Every dunamis worktree is initialized with cone-mode sparse-checkout immediately after creation. The working tree shows only:

```
papers/<slug>/
working/<slug>/
templates/
slugs.yaml
```

### Daemon implementation

`handle_create_worktree` applies sparse-checkout after `git worktree add`:

```python
rc, out = run_git(['sparse-checkout', 'init', '--cone'], target)
if rc == 0:
    run_git(['sparse-checkout', 'set',
             f'papers/{slug}', f'working/{slug}', 'templates', 'slugs.yaml'],
            target)
```

Failure is non-fatal — worktree is still usable, just not filtered.

### Retroactive application

`daemon/apply-sparse-checkout.py` applies the convention to all existing worktrees. Run once after upgrading:

```bash
# Dry run — see what would be applied:
python3 daemon/apply-sparse-checkout.py --dry-run

# Apply to all existing worktrees:
python3 daemon/apply-sparse-checkout.py
```

The script resolves each worktree's slug by matching its directory name against the slug list in `energeia:slugs.yaml`. Worktrees with no matching slug are skipped with a warning.

### Verification

After applying, confirm a worktree only shows its own paper:

```bash
ls ~/Documents/agora-worktrees/dunamis/<slug>-<dir>/papers/
# Should show: <slug>/    (only)
```

---

## §VI. PDF Proxy

`GET /api/energeia/pdf/<slug>/<filename>` — proxies PDFs from the private agora repo through to authenticated browser sessions. Filename patterns:

| Pattern | Source | Cache |
|---|---|---|
| `current.pdf` | `papers/<slug>/main.pdf @ energeia` | 5 min |
| `current-slides.pdf` | `compiled/<slug>/<slug>-slides.pdf @ energeia` | 5 min |
| `current-handout.pdf` | `compiled/<slug>/<slug>-handout.pdf @ energeia` | 5 min |
| `<slug>-style-<ROMAN>.pdf` | `papers/<slug>/main.pdf @ tag` | immutable |
| `<slug>-style-<ROMAN>-slides.pdf` | `compiled/<slug>/<slug>-slides.pdf @ tag` | immutable |
| `diff-style-<A>-style-<B>.pdf` | `papers/<slug>/diff-*.pdf @ energeia` | immutable |
| `draft-<direction>.pdf` | `papers/<slug>/main.pdf @ dunamis/<slug>-<dir>` | no-store |

---

## §VII. Paper Lifecycle Operations

| Operation | Endpoint | Notes |
|---|---|---|
| Create paper | Workers → `slugs.yaml` write + branch scaffold | Enqueues daemon actions |
| Create direction | Workers → `slugs.yaml` write + `dunamis/` branch | Daemon creates worktree |
| Compile draft | `POST /api/energeia/papers/:slug/compile` | Dispatches `compile-draft.yml` |
| Promote | `POST /api/energeia/papers/:slug/promote` | Dispatches `promote-paper.yml` |
| Archive direction | `POST /api/energeia/papers/:slug/directions/:dir/archive` | Renames branch; updates `slugs.yaml` |
| Delete archived direction | `DELETE /api/energeia/papers/:slug/directions/:dir` | Deletes `archive/dunamis/` branch |
| Archive paper | `POST /api/energeia/papers/:slug/archive` | Sets `status: archived`; renames all directions |
| Delete paper | `DELETE /api/energeia/papers/:slug` | Requires `{ confirm: "delete-<slug>" }` body; irreversible |
