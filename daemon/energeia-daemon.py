#!/usr/bin/env python3
"""
energeia-daemon — local daemon for the Sképtou energeia module.

Polls the Cloudflare KV ENERGEIA_ACTIONS namespace directly (via CF REST API)
for pending actions every ~5 seconds, bypassing the CF Access gate.
Executes local actions (git worktree management, Scrivener project ops).
File watcher auto-commits + pushes changes in agora worktree paper directories.

Installed as a launchd job by install.command.
Logs to ~/Library/Logs/energeia-daemon.log.

Dependencies (installed by install.command):
    pip3 install watchdog requests
    (tomllib is stdlib in Python 3.11+)

Environment (set in launchd plist):
    ENERGEIA_TOKEN       — daemon auth token (registered with energeia API)
    ENERGEIA_API_URL     — https://energeia.skeptou.com
    AGORA_PATH           — ~/Documents/agora (git clone of agora repo)
    WORKTREES_PATH       — ~/Documents/agora-worktrees/dunamis
    SCRIVENER_PATH       — ~/Documents/agora-scriv
    CF_ACCOUNT_ID        — Cloudflare account ID (for KV REST API)
    CF_KV_NAMESPACE_ID   — ENERGEIA_ACTIONS KV namespace ID
"""

import os
import sys
import time
import json
import logging
import subprocess
import shutil
import hashlib
import threading
import platform
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import quote as url_quote
import tomllib

# ── Dependency check ─────────────────────────────────────────────────────────
try:
    import requests
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler
except ImportError as e:
    sys.stderr.write(f"Missing dependency: {e}\nRun: pip3 install watchdog requests\n")
    sys.exit(1)

# ── Configuration ─────────────────────────────────────────────────────────────
API_URL       = os.environ.get('ENERGEIA_API_URL', 'https://energeia.skeptou.com')
TOKEN         = os.environ.get('ENERGEIA_TOKEN', '')
AGORA_PATH    = Path(os.environ.get('AGORA_PATH',
                     os.path.expanduser('~/Documents/agora')))
WORKTREES     = Path(os.environ.get('WORKTREES_PATH',
                     os.path.expanduser('~/Documents/agora-worktrees/dunamis')))
SCRIVENER_DIR = Path(os.environ.get('SCRIVENER_PATH',
                     os.path.expanduser('~/Documents/agora-scriv')))
POLL_INTERVAL = 5  # seconds

# ── Cloudflare KV (direct REST — bypasses CF Access) ─────────────────────────
CF_ACCOUNT_ID      = os.environ.get('CF_ACCOUNT_ID', '')
CF_KV_NAMESPACE_ID = os.environ.get('CF_KV_NAMESPACE_ID', '')
CF_KV_API          = 'https://api.cloudflare.com/client/v4'

LOG_PATH = Path.home() / 'Library' / 'Logs' / 'energeia-daemon.log'
LOG_PATH.parent.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s  %(levelname)-8s  %(message)s',
    handlers=[
        logging.FileHandler(LOG_PATH),
        logging.StreamHandler(sys.stdout),
    ]
)
log = logging.getLogger('energeia')

# ── HTTP helpers ──────────────────────────────────────────────────────────────
def api_get(path: str) -> dict | None:
    try:
        r = requests.get(
            f'{API_URL}{path}',
            headers={'Authorization': f'Bearer {TOKEN}'},
            timeout=10
        )
        r.raise_for_status()
        return r.json()
    except Exception as exc:
        log.warning('GET %s failed: %s', path, exc)
        return None


def api_post(path: str, body: dict) -> bool:
    try:
        r = requests.post(
            f'{API_URL}{path}',
            json=body,
            headers={'Authorization': f'Bearer {TOKEN}'},
            timeout=10
        )
        return r.ok
    except Exception as exc:
        log.warning('POST %s failed: %s', path, exc)
        return False


def report_complete(action_id: str, ok: bool, message: str = '') -> None:
    kv_complete_action(action_id, ok, message)


# ── Cloudflare KV helpers (direct REST — avoids CF Access gate) ───────────────

def _cf_token() -> str:
    """Cloudflare API token. Prefers the long-lived CLOUDFLARE_API_TOKEN env
    var; falls back to the short-lived wrangler OAuth token only if unset.

    The wrangler oauth_token expires hourly and has no refresh here, so a
    scoped API token is the supported credential for the daemon."""
    env_token = os.environ.get('CLOUDFLARE_API_TOKEN', '').strip()
    if env_token:
        return env_token
    cfg = Path.home() / '.wrangler' / 'config' / 'default.toml'
    try:
        with open(cfg, 'rb') as f:
            data = tomllib.load(f)
        return data.get('oauth_token', '')
    except Exception as exc:
        log.warning('_cf_token: could not read wrangler config: %s', exc)
        return ''


def kv_get(key: str) -> str | None:
    """Read a KV value from ENERGEIA_ACTIONS via CF REST API."""
    if not CF_ACCOUNT_ID or not CF_KV_NAMESPACE_ID:
        return None
    token = _cf_token()
    if not token:
        return None
    url = (f'{CF_KV_API}/accounts/{CF_ACCOUNT_ID}'
           f'/storage/kv/namespaces/{CF_KV_NAMESPACE_ID}'
           f'/values/{url_quote(key, safe="")}')
    try:
        r = requests.get(url, headers={'Authorization': f'Bearer {token}'}, timeout=10)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.text
    except Exception as exc:
        log.warning('kv_get(%s) failed: %s', key, exc)
        return None


def kv_put(key: str, value: str) -> bool:
    """Write a KV value to ENERGEIA_ACTIONS via CF REST API."""
    if not CF_ACCOUNT_ID or not CF_KV_NAMESPACE_ID:
        return False
    token = _cf_token()
    if not token:
        return False
    url = (f'{CF_KV_API}/accounts/{CF_ACCOUNT_ID}'
           f'/storage/kv/namespaces/{CF_KV_NAMESPACE_ID}'
           f'/values/{url_quote(key, safe="")}')
    try:
        r = requests.put(url, data=value.encode(),
                         headers={'Authorization': f'Bearer {token}',
                                  'Content-Type': 'text/plain'},
                         timeout=10)
        r.raise_for_status()
        return True
    except Exception as exc:
        log.warning('kv_put(%s) failed: %s', key, exc)
        return False


def kv_next_action() -> dict:
    """
    Pull the oldest pending action from KV.
    Mirrors next.js logic — marks the action 'claimed' atomically.
    Returns {'action': <obj>} or {'action': None}.
    """
    queue_raw = kv_get('action-queue')
    if not queue_raw:
        return {'action': None}
    try:
        queue = json.loads(queue_raw)
    except Exception:
        return {'action': None}
    for action_id in queue:
        raw = kv_get(f'action:{action_id}')
        if not raw:
            continue
        try:
            action = json.loads(raw)
        except Exception:
            continue
        if action.get('status') == 'pending':
            action['status']     = 'claimed'
            action['claimed_at'] = datetime.utcnow().isoformat() + 'Z'
            kv_put(f'action:{action_id}', json.dumps(action))
            return {'action': action}
    return {'action': None}


def kv_complete_action(action_id: str, ok: bool, message: str = '') -> None:
    """
    Mark an action complete in KV and remove it from the queue.
    Mirrors complete.js logic.
    """
    raw = kv_get(f'action:{action_id}')
    if not raw:
        log.warning('kv_complete_action: action %s not found', action_id)
        return
    try:
        action = json.loads(raw)
    except Exception:
        log.warning('kv_complete_action: could not parse action %s', action_id)
        return
    action['status']       = 'success' if ok else 'error'
    action['result']       = message
    action['completed_at'] = datetime.utcnow().isoformat() + 'Z'
    kv_put(f'action:{action_id}', json.dumps(action))
    # Remove from queue
    queue_raw = kv_get('action-queue')
    if queue_raw:
        try:
            queue = [qid for qid in json.loads(queue_raw) if qid != action_id]
            kv_put('action-queue', json.dumps(queue))
        except Exception:
            pass


# ── Git helpers ───────────────────────────────────────────────────────────────
def run_git(args: list[str], cwd: Path) -> tuple[int, str]:
    result = subprocess.run(
        ['git'] + args,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return result.returncode, (result.stdout + result.stderr).strip()


def git_auto_commit(worktree: Path, branch: str) -> None:
    rc, out = run_git(['add', '-A'], worktree)
    if rc != 0:
        log.warning('git add failed in %s: %s', worktree, out)
        return
    rc, out = run_git(['diff', '--cached', '--quiet'], worktree)
    if rc == 0:
        return  # nothing staged
    ts = datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
    rc, out = run_git(['commit', '-m', f'auto: save {ts} [daemon]'], worktree)
    if rc != 0:
        log.warning('git commit failed in %s: %s', worktree, out)
        return
    local_branch = branch.split('/')[-1]
    # The dunamis branch also receives commits from CI (compile-draft pushes
    # main.pdf + compile-status.json). Rebase onto the remote before pushing,
    # or the push is rejected non-fast-forward and the local change silently
    # never reaches GitHub.
    run_git(['fetch', 'origin', branch], worktree)
    rc, out = run_git(['rebase', f'origin/{branch}'], worktree)
    if rc != 0:
        run_git(['rebase', '--abort'], worktree)
        log.warning('auto-commit: rebase on origin/%s failed: %s', branch, out)
    rc, out = run_git(['push', 'origin', f'{local_branch}:{branch}'], worktree)
    if rc != 0:
        log.warning('git push failed in %s: %s', worktree, out)
    else:
        log.info('auto-committed + pushed in %s', worktree)

# ── Action handlers ───────────────────────────────────────────────────────────
def handle_create_worktree(payload: dict) -> tuple[bool, str]:
    branch = payload.get('branch', '')
    slug   = payload.get('slug', '')
    if not branch or not slug:
        return False, 'Missing branch or slug'

    # branch is the remote branch 'dunamis/<slug>-<dir>'; the local branch and
    # worktree dir drop the 'dunamis/' prefix so the watcher's push refspec
    # (local:remote) stays consistent.
    local_branch = branch.replace('dunamis/', '')
    target = WORKTREES / local_branch
    if target.exists():
        return True, f'Worktree already exists at {target}'

    target.parent.mkdir(parents=True, exist_ok=True)
    # Fetch the branch (updates refs/remotes/origin/<branch>). This action races
    # create-dunamis-branch.yml — if the branch is not on the remote yet, do NOT
    # block the daemon waiting. The reconcile pass creates the worktree once the
    # branch appears (within one reconcile interval).
    rc, out = run_git(['fetch', 'origin', branch], AGORA_PATH)
    if rc != 0:
        return True, f'{branch} not on remote yet — reconcile will create the worktree'

    # Check out the worktree on a real local branch tracking origin/<branch>.
    # Without this the worktree lands in detached HEAD and pushes fail.
    rc, _ = run_git(['show-ref', '--verify', '--quiet',
                     f'refs/heads/{local_branch}'], AGORA_PATH)
    if rc == 0:
        rc, out = run_git(['worktree', 'add', str(target), local_branch], AGORA_PATH)
    else:
        rc, out = run_git(['worktree', 'add', '--track', '-b', local_branch,
                           str(target), f'origin/{branch}'], AGORA_PATH)
    if rc != 0:
        return False, f'git worktree add failed: {out}'

    # Sparse-checkout: only this paper's own files — papers/<slug> and
    # working/<slug>. Shared infra (templates/, .github/) is excluded; the
    # CI compile does a full checkout, so it is unaffected.
    # Non-fatal — worktree is usable without it, just not filtered.
    rc, out = run_git(['sparse-checkout', 'init', '--cone'], target)
    if rc != 0:
        log.warning('sparse-checkout init failed in %s: %s', target, out)
    else:
        rc, out = run_git(
            ['sparse-checkout', 'set', f'papers/{slug}', f'working/{slug}'],
            target
        )
        if rc != 0:
            log.warning('sparse-checkout set failed in %s: %s', target, out)
        else:
            log.info('Sparse-checkout: papers/%s, working/%s (+ root files)', slug, slug)

    log.info('Created worktree %s → %s', branch, target)
    return True, f'Worktree created at {target}'


def handle_remove_worktree(payload: dict) -> tuple[bool, str]:
    slug      = payload.get('slug', '')
    direction = payload.get('direction', '')
    branch    = payload.get('branch', '')

    if slug and direction:
        # Preferred: derive path from slug+direction; immune to branch prefix variations
        # (archive/dunamis/<slug>-<dir> and dunamis/<slug>-<dir> share the same local path)
        target = WORKTREES / f'{slug}-{direction}'
    elif branch:
        # Fallback: strip 'archive/' prefix then 'dunamis/' prefix
        stem   = branch.removeprefix('archive/').replace('dunamis/', '', 1)
        target = WORKTREES / stem
    else:
        return False, 'Missing slug+direction or branch'

    if not target.exists():
        return True, f'Worktree not found at {target} — already removed'

    rc, out = run_git(['worktree', 'remove', '--force', str(target)], AGORA_PATH)
    if rc != 0:
        return False, f'git worktree remove failed: {out}'

    # Delete the local branch the worktree held — otherwise it lingers as
    # an orphan once its dunamis branch is gone.
    run_git(['branch', '-D', target.name], AGORA_PATH)

    log.info('Removed worktree %s', target)
    return True, f'Worktree removed: {target}'


def _rename_inner_scrivx(pkg: Path, new_stem: str) -> None:
    """Scrivener requires the inner .scrivx to match the package name; after a
    copytree it still carries the source stem, so rename it."""
    for scrivx in pkg.glob('*.scrivx'):
        target = pkg / f'{new_stem}.scrivx'
        if scrivx != target:
            scrivx.rename(target)
        break


def handle_scaffold_scrivener_project(payload: dict) -> tuple[bool, str]:
    slug  = payload.get('slug', '')
    fmt   = payload.get('format', 'article')
    if not slug:
        return False, 'Missing slug'

    dest = SCRIVENER_DIR / f'{slug}.scriv'
    SCRIVENER_DIR.mkdir(parents=True, exist_ok=True)

    if dest.exists():
        return True, f'Scrivener project already exists at {dest}'

    template = SCRIVENER_DIR / '_templates' / f'{fmt}.scriv'
    if not template.exists():
        return False, (f'No Scrivener template for format "{fmt}" at {template} — '
                       f'add a template there before scaffolding')

    shutil.copytree(template, dest)
    _rename_inner_scrivx(dest, slug)
    log.info('Created Scrivener project from template %s: %s', fmt, dest)
    return True, f'Scrivener project scaffolded at {dest}'


def handle_duplicate_scrivener_project(payload: dict) -> tuple[bool, str]:
    slug      = payload.get('slug', '')
    direction = payload.get('direction', '')
    if not slug or not direction:
        return False, 'Missing slug or direction'

    src  = SCRIVENER_DIR / f'{slug}.scriv'
    dest = SCRIVENER_DIR / f'{slug}-{direction}.scriv'

    if not src.exists():
        return False, f'Source project not found: {src}'
    if dest.exists():
        return True, f'Direction project already exists: {dest}'

    shutil.copytree(src, dest)
    _rename_inner_scrivx(dest, f'{slug}-{direction}')
    log.info('Duplicated Scrivener project %s → %s', src.name, dest.name)
    return True, f'Duplicated to {dest}'


def handle_archive_scrivener_project(payload: dict) -> tuple[bool, str]:
    slug      = payload.get('slug', '')
    direction = payload.get('direction', '')
    if not slug:
        return False, 'Missing slug'

    name = f'{slug}-{direction}.scriv' if direction else f'{slug}.scriv'
    src  = SCRIVENER_DIR / name
    if not src.exists():
        return True, f'No Scrivener project found at {src} — nothing to archive'

    archive_dir = SCRIVENER_DIR / 'archive'
    archive_dir.mkdir(exist_ok=True)
    dest = archive_dir / name
    shutil.move(str(src), str(dest))
    log.info('Archived Scrivener project %s → %s', src, dest)
    return True, f'Archived to {dest}'


def handle_delete_scrivener_project(payload: dict) -> tuple[bool, str]:
    slug = payload.get('slug', '')
    if not slug:
        return False, 'Missing slug'

    trash = SCRIVENER_DIR / '_trash'
    trash.mkdir(exist_ok=True)
    timestamp = datetime.now().strftime('%Y%m%dT%H%M%S')

    moved = []
    for item in sorted(SCRIVENER_DIR.iterdir()):
        name = item.name
        if not name.endswith('.scriv') or not item.is_dir():
            continue
        stem = name[:-6]  # strip '.scriv'
        if stem == slug or stem.startswith(f'{slug}-'):
            dest = trash / f'{stem}-{timestamp}.scriv'
            shutil.move(str(item), str(dest))
            moved.append(name)
            log.info('Trashed Scrivener project %s → %s', item, dest)

    if not moved:
        return True, f'No Scrivener projects found for slug "{slug}" — nothing to trash'
    return True, f'Trashed {len(moved)} Scrivener project(s): {", ".join(moved)}'


def handle_delete_scrivener_archive(payload: dict) -> tuple[bool, str]:
    """Remove an archived Scrivener project (agora-scriv/archive/<name>.scriv)
    when its direction is permanently deleted. Moves it to _trash/ — reversible."""
    slug      = payload.get('slug', '')
    direction = payload.get('direction', '')
    if not slug:
        return False, 'Missing slug'

    name = f'{slug}-{direction}.scriv' if direction else f'{slug}.scriv'
    src  = SCRIVENER_DIR / 'archive' / name
    if not src.exists():
        return True, f'No archived Scrivener project at {src} — nothing to delete'

    trash = SCRIVENER_DIR / '_trash'
    trash.mkdir(exist_ok=True)
    ts   = datetime.now().strftime('%Y%m%dT%H%M%S')
    dest = trash / f'{name[:-len(".scriv")]}-{ts}.scriv'
    shutil.move(str(src), str(dest))
    log.info('Trashed archived Scrivener project %s → %s', src, dest)
    return True, f'Archived Scrivener project moved to {dest}'


def handle_configure_scrivener_compile_target(payload: dict) -> tuple[bool, str]:
    # Scrivener compile configuration requires AppleScript on macOS.
    # Auto-configuration via AppleScript is complex and fragile;
    # surfacing a desktop notification for manual configuration instead.
    slug   = payload.get('slug', '')
    notify(
        'Energeia — manual step required',
        f'Configure Scrivener compile target for "{slug}" to output '
        f'papers/{slug}/main.tex via XeLaTeX. See energeia docs.'
    )
    return True, f'Desktop notification shown for {slug} compile target setup'


# ── Action dispatch ───────────────────────────────────────────────────────────
HANDLERS = {
    'create-worktree':                   handle_create_worktree,
    'remove-worktree':                   handle_remove_worktree,
    'scaffold-scrivener-project':        handle_scaffold_scrivener_project,
    'duplicate-scrivener-project':       handle_duplicate_scrivener_project,
    'archive-scrivener-project':         handle_archive_scrivener_project,
    'delete-scrivener-project':          handle_delete_scrivener_project,
    'delete-scrivener-archive':          handle_delete_scrivener_archive,
    'configure-scrivener-compile-target': handle_configure_scrivener_compile_target,
}


def dispatch_action(action: dict) -> None:
    action_id = action.get('id', 'unknown')
    action_type = action.get('type', '')
    payload = action.get('payload', {})

    handler = HANDLERS.get(action_type)
    if not handler:
        log.warning('Unknown action type: %s', action_type)
        report_complete(action_id, False, f'Unknown action type: {action_type}')
        return

    log.info('Executing action %s: %s', action_id[:8], action_type)
    try:
        ok, msg = handler(payload)
        log.info('Action %s finished: ok=%s msg=%s', action_id[:8], ok, msg)
        report_complete(action_id, ok, msg)
    except Exception as exc:
        log.error('Action %s raised exception: %s', action_id[:8], exc, exc_info=True)
        report_complete(action_id, False, str(exc))

# ── File watcher ──────────────────────────────────────────────────────────────
class PaperWatcher(FileSystemEventHandler):
    """Debounced watcher on ~/Documents/agora-worktrees/dunamis/*/papers/"""

    def __init__(self):
        self._pending: dict[str, float] = {}
        self._lock = threading.Lock()
        self._debounce_secs = 8.0

    def on_any_event(self, event):
        if event.is_directory:
            return
        # Only care about changes inside papers/ subdirectories
        path = Path(event.src_path)
        if 'papers' not in path.parts:
            return
        # Find the worktree root (agora-worktrees/dunamis/<slug>-<dir>/)
        try:
            idx = list(path.parts).index('dunamis') + 1
            direction_dir = Path(*path.parts[:idx + 1])  # up to <slug>-<dir>
        except (ValueError, IndexError):
            return
        key = str(direction_dir)
        with self._lock:
            self._pending[key] = time.time()

    def flush_pending(self) -> None:
        now = time.time()
        with self._lock:
            ready = [(k, v) for k, v in self._pending.items()
                     if now - v >= self._debounce_secs]
            for k, _ in ready:
                del self._pending[k]

        for worktree_str, _ in ready:
            worktree = Path(worktree_str)
            if not worktree.exists():
                continue
            # Derive branch name from directory structure
            # Worktrees path: .../agora-worktrees/dunamis/<name>
            # Branch: dunamis/<name>
            branch = f'dunamis/{worktree.name}'
            threading.Thread(
                target=git_auto_commit, args=(worktree, branch), daemon=True
            ).start()


# ── macOS desktop notifications ───────────────────────────────────────────────
def notify(title: str, message: str) -> None:
    if platform.system() != 'Darwin':
        return
    script = f'display notification "{message}" with title "{title}"'
    try:
        subprocess.run(['osascript', '-e', script], timeout=5, capture_output=True)
    except Exception:
        pass

# ── Main loop ─────────────────────────────────────────────────────────────────
# ── Reconciliation ────────────────────────────────────────────────────────────
def _dunamis_branches():
    """Remote 'dunamis/<slug>-<dir>' branch names. Returns None on failure
    (caller must then skip pruning — never treat a network blip as 'no branches')."""
    rc, out = run_git(['ls-remote', '--heads', 'origin', 'dunamis/*'], AGORA_PATH)
    if rc != 0:
        log.warning('reconcile: ls-remote failed: %s', out)
        return None
    branches = set()
    for line in out.splitlines():
        parts = line.split('\t')
        # ls-remote's 'dunamis/*' pattern also tail-matches archive/dunamis/* —
        # only live dunamis/ branches get a worktree, not archived ones.
        if len(parts) == 2 and parts[1].startswith('refs/heads/dunamis/'):
            branches.add(parts[1][len('refs/heads/'):])
    return branches


def _slugs_yaml_papers() -> dict:
    """Parse slugs.yaml on energeia → {slug: {'format': str, 'archived': set()}}.
    'archived' holds the direction names under the paper's archived-dunamis: block."""
    rc, out = run_git(['show', 'origin/energeia:slugs.yaml'], AGORA_PATH)
    if rc != 0:
        log.warning('reconcile: could not read slugs.yaml: %s', out)
        return {}
    papers, cur, block = {}, None, None
    for line in out.splitlines():
        m = re.match(r'\s*-\s*slug:\s*"?([a-z0-9-]+)"?', line)
        if m:
            cur = m.group(1)
            papers[cur] = {'format': 'article', 'status': 'drafting', 'archived': set()}
            block = None
            continue
        if not cur:
            continue
        stripped = line.strip()
        fm = re.search(r'\bformats:\s*\[?\s*"?([a-z]+)', line)
        if fm:
            papers[cur]['format'] = fm.group(1)
            continue
        sm = re.search(r'\bstatus:\s*"?([a-z]+)', line)
        if sm:
            papers[cur]['status'] = sm.group(1)
            continue
        if stripped == 'dunamis:':
            block = 'dunamis'; continue
        if stripped == 'archived-dunamis:':
            block = 'archived'; continue
        dm = re.match(r'\s{6}([a-z]+):', line)
        if dm:
            if block == 'archived':
                papers[cur]['archived'].add(dm.group(1))
        elif stripped and re.match(r'\s{0,4}\S', line):
            block = None   # a paper-level key — left the direction block
    return papers


def _apply_sparse_checkout(target: Path, slug: str) -> None:
    """Scope a worktree to just this paper's own files — papers/<slug> and
    working/<slug>. Shared infra (templates/, .github/) is left out; root
    files (slugs.yaml, .gitignore) are always materialised by cone mode."""
    run_git(['sparse-checkout', 'init', '--cone'], target)
    rc, out = run_git(['sparse-checkout', 'set',
                       f'papers/{slug}', f'working/{slug}'], target)
    if rc != 0:
        log.warning('reconcile: sparse-checkout failed in %s: %s', target.name, out)


def _prune_orphan_branches(desired_names: set) -> None:
    """Delete local branches that tracked a dunamis branch which no longer
    exists on the remote — leftovers from removed worktrees."""
    rc, out = run_git(['for-each-ref', '--format=%(refname:short)\t%(upstream:short)',
                       'refs/heads/'], AGORA_PATH)
    if rc != 0:
        return
    for line in out.splitlines():
        parts = line.split('\t')
        if len(parts) != 2:
            continue
        branch, upstream = parts
        if not upstream.startswith('origin/dunamis/') or branch in desired_names:
            continue
        rc2, out2 = run_git(['branch', '-D', branch], AGORA_PATH)
        if rc2 == 0:
            log.info('reconcile: deleted orphan local branch %s', branch)
        else:
            log.warning('reconcile: could not delete orphan local branch %s: %s', branch, out2)


def reconcile() -> None:
    """Self-healing pass — make agora-worktrees/ and agora-scriv/ match the
    dunamis branches on the remote and the papers in slugs.yaml. Missed or
    failed KV actions no longer cause permanent drift."""
    log.info('reconcile: starting')
    run_git(['fetch', 'origin', '--prune'], AGORA_PATH)
    # Clear stale worktree admin entries — a removed worktree dir leaves
    # '.git/worktrees/<name>' behind, which blocks re-adding that branch.
    run_git(['worktree', 'prune'], AGORA_PATH)

    # slugs.yaml is the canonical paper registry — worktrees AND Scrivener
    # projects are both reconciled against it, so the two stay consistent.
    papers = _slugs_yaml_papers()

    # ── Worktrees: one (sparse) per dunamis branch of a registered paper ──
    desired = _dunamis_branches()
    if desired is None:
        log.warning('reconcile: skipping worktree pass — branch list unavailable')
    elif not papers:
        log.warning('reconcile: skipping worktree pass — slugs.yaml unavailable')
    else:
        # Keep only branches whose slug is a paper in slugs.yaml; an orphan
        # dunamis branch with no registry entry gets no local worktree.
        valid = {b for b in desired
                 if b.replace('dunamis/', '').rsplit('-', 1)[0] in papers}
        desired_names = {b.replace('dunamis/', '') for b in valid}
        WORKTREES.mkdir(parents=True, exist_ok=True)
        existing = {p.name for p in WORKTREES.iterdir()
                    if p.is_dir() and not p.name.startswith('.')}
        for branch in sorted(valid):
            name = branch.replace('dunamis/', '')
            slug = name.rsplit('-', 1)[0]
            if name in existing:
                _apply_sparse_checkout(WORKTREES / name, slug)
            else:
                ok, msg = handle_create_worktree({'branch': branch, 'slug': slug})
                log.info('reconcile: worktree %s — %s', name, msg)
        for name in sorted(existing - desired_names):
            rc, out = run_git(['worktree', 'remove', '--force',
                               str(WORKTREES / name)], AGORA_PATH)
            if rc == 0:
                log.info('reconcile: removed orphan worktree %s', name)
            else:
                log.warning('reconcile: could not remove orphan worktree %s: %s', name, out)
        _prune_orphan_branches(desired_names)

    # ── Scrivener projects: live in agora-scriv/, archived in agora-scriv/archive/ ──
    SCRIVENER_DIR.mkdir(parents=True, exist_ok=True)
    archive_dir = SCRIVENER_DIR / 'archive'
    archive_dir.mkdir(exist_ok=True)          # always present, even with no archives
    if papers:
        trash = SCRIVENER_DIR / '_trash'

        def _is_archived(stem: str) -> bool:
            """True if <stem>.scriv belongs in archive/ — its paper is archived,
            or it is a <slug>-<direction> project whose direction is archived."""
            if stem in papers:
                return papers[stem].get('status') == 'archived'
            base, _, direction = stem.rpartition('-')
            return bool(base) and base in papers and direction in papers[base]['archived']

        # Scaffold a live .scriv for every non-archived paper that lacks one
        for slug, info in sorted(papers.items()):
            if info.get('status') == 'archived':
                continue
            if not (SCRIVENER_DIR / f'{slug}.scriv').exists() \
                    and not (archive_dir / f'{slug}.scriv').exists():
                ok, msg = handle_scaffold_scrivener_project(
                    {'slug': slug, 'format': info['format']})
                log.info('reconcile: scriv %s — %s', slug, msg)

        # Move live-root projects that should be archived into archive/
        for item in sorted(SCRIVENER_DIR.iterdir()):
            if not (item.is_dir() and item.name.endswith('.scriv')):
                continue
            if _is_archived(item.name[:-len('.scriv')]):
                dest = archive_dir / item.name
                if not dest.exists():
                    shutil.move(str(item), str(dest))
                    log.info('reconcile: archived Scrivener project %s', item.name)

        # Restore archived projects to the live root if no longer archived
        for item in sorted(archive_dir.iterdir()):
            if not (item.is_dir() and item.name.endswith('.scriv')):
                continue
            stem = item.name[:-len('.scriv')]
            if not _is_archived(stem) \
                    and (stem in papers or stem.rpartition('-')[0] in papers) \
                    and not (SCRIVENER_DIR / item.name).exists():
                shutil.move(str(item), str(SCRIVENER_DIR / item.name))
                log.info('reconcile: restored Scrivener project %s from archive', item.name)

        # Trash orphan projects in the live root (paper no longer exists)
        for item in sorted(SCRIVENER_DIR.iterdir()):
            if not (item.is_dir() and item.name.endswith('.scriv')):
                continue
            stem = item.name[:-len('.scriv')]
            if stem in papers or stem.rpartition('-')[0] in papers:
                continue
            trash.mkdir(exist_ok=True)
            ts = datetime.now().strftime('%Y%m%dT%H%M%S')
            shutil.move(str(item), str(trash / f'{stem}-{ts}.scriv'))
            log.info('reconcile: trashed orphan Scrivener project %s', item.name)

    log.info('reconcile: done')


def main() -> None:
    if not TOKEN:
        log.error('ENERGEIA_TOKEN is not set — daemon cannot authenticate. Exiting.')
        sys.exit(1)

    log.info('energeia-daemon starting up')
    log.info('API: %s', API_URL)
    log.info('Agora path: %s', AGORA_PATH)
    log.info('Worktrees: %s', WORKTREES)

    WORKTREES.mkdir(parents=True, exist_ok=True)

    # Initial reconcile — bring agora-worktrees/ and agora-scriv/ in line
    # with the remote before the watcher and poll loop start.
    reconcile()
    last_reconcile = time.time()
    RECONCILE_INTERVAL = 90  # seconds — periodic self-heal (also the worktree backstop)

    # Start file watcher
    watcher = PaperWatcher()
    observer = Observer()
    if WORKTREES.exists():
        observer.schedule(watcher, str(WORKTREES), recursive=True)
    observer.start()
    log.info('File watcher started on %s', WORKTREES)

    notify('Energeia daemon', 'Started — watching for paper changes.')

    try:
        while True:
            # Flush debounced auto-commits
            watcher.flush_pending()

            # Periodic self-healing reconcile
            if time.time() - last_reconcile >= RECONCILE_INTERVAL:
                reconcile()
                last_reconcile = time.time()

            # Poll for next action (direct KV — bypasses CF Access)
            resp = kv_next_action()
            if resp and resp.get('action'):
                dispatch_action(resp['action'])
            else:
                time.sleep(POLL_INTERVAL)

    except KeyboardInterrupt:
        log.info('Interrupted — shutting down')
    finally:
        observer.stop()
        observer.join()
        log.info('energeia-daemon stopped')


if __name__ == '__main__':
    main()
