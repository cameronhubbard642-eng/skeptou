#!/usr/bin/env python3
"""
cleanup-orphaned-local.py — remove local worktrees and Scrivener projects
whose paper slug no longer exists in agora's energeia:slugs.yaml.

Run this once to clean up state left behind by UI-level paper deletes that
happened before the daemon had a delete-scrivener-project handler.

Usage:
    python3 daemon/cleanup-orphaned-local.py [--dry-run]
    python3 daemon/cleanup-orphaned-local.py --force
    python3 daemon/cleanup-orphaned-local.py --agora PATH --worktrees PATH --scriv PATH

Options:
    --agora PATH        Path to agora git repo  (default: ~/Documents/agora)
    --worktrees PATH    Path to dunamis worktrees dir (default: ~/Documents/agora-worktrees/dunamis)
    --scriv PATH        Path to Scrivener projects dir (default: ~/Documents/agora-scriv)
    --dry-run           Print what would be removed without doing it (default)
    --force             Actually remove orphaned items
"""

import argparse
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path


def run(cmd: list[str], cwd: Path) -> tuple[int, str]:
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=30)
    return r.returncode, (r.stdout + r.stderr).strip()


def fetch_slugs(agora: Path) -> list[str]:
    for ref in ('origin/energeia', 'energeia'):
        rc, out = run(['git', 'show', f'{ref}:slugs.yaml'], agora)
        if rc == 0:
            return re.findall(r'-\s+slug:\s*"?([a-z0-9][a-z0-9-]+)"?', out)
    print('ERROR: could not read slugs.yaml from energeia branch', file=sys.stderr)
    sys.exit(1)


def resolve_slug(stem: str, slugs: list[str]) -> str | None:
    """Return the slug prefix for a worktree directory name like '<slug>-<direction>'."""
    for s in sorted(slugs, key=len, reverse=True):
        if stem.startswith(f'{s}-') or stem == s:
            return s
    return None


def find_orphaned_worktrees(worktrees: Path, slugs: set[str]) -> list[Path]:
    orphans = []
    if not worktrees.exists():
        return orphans
    for item in sorted(worktrees.iterdir()):
        if not item.is_dir() or item.name.startswith('_'):
            continue
        slug = resolve_slug(item.name, list(slugs))
        if slug is None or slug not in slugs:
            orphans.append(item)
    return orphans


def find_orphaned_scriv(scriv: Path, slugs: set[str]) -> list[Path]:
    orphans = []
    skip_dirs = {'_trash', '_templates', 'archive'}
    if not scriv.exists():
        return orphans
    for item in sorted(scriv.iterdir()):
        if item.name in skip_dirs or not item.name.endswith('.scriv'):
            continue
        stem = item.name[:-6]
        slug = resolve_slug(stem, list(slugs))
        if slug is None or slug not in slugs:
            orphans.append(item)
    return orphans


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--agora',     default=str(Path.home() / 'Documents' / 'agora'))
    parser.add_argument('--worktrees', default=str(Path.home() / 'Documents' / 'agora-worktrees' / 'dunamis'))
    parser.add_argument('--scriv',     default=str(Path.home() / 'Documents' / 'agora-scriv'))
    parser.add_argument('--dry-run',   action='store_true', default=True,
                        help='Print what would be removed (default)')
    parser.add_argument('--force',     action='store_true',
                        help='Actually remove orphaned items')
    args = parser.parse_args()

    dry_run = not args.force

    agora    = Path(args.agora)
    worktrees = Path(args.worktrees)
    scriv    = Path(args.scriv)

    print(f'Mode:      {"DRY RUN (pass --force to execute)" if dry_run else "LIVE — removing orphans"}')
    print(f'Agora:     {agora}')
    print(f'Worktrees: {worktrees}')
    print(f'Scriv:     {scriv}')
    print()

    slugs = set(fetch_slugs(agora))
    print(f'Active slugs ({len(slugs)}): {", ".join(sorted(slugs))}')
    print()

    orphaned_wt = find_orphaned_worktrees(worktrees, slugs)
    orphaned_sc = find_orphaned_scriv(scriv, slugs)

    if not orphaned_wt and not orphaned_sc:
        print('No orphaned worktrees or Scrivener projects found.')
        return

    if orphaned_wt:
        print(f'Orphaned worktrees ({len(orphaned_wt)}):')
        for p in orphaned_wt:
            print(f'  {p}')
        print()

    if orphaned_sc:
        print(f'Orphaned Scrivener projects ({len(orphaned_sc)}):')
        for p in orphaned_sc:
            print(f'  {p}')
        print()

    if dry_run:
        print('Dry run — nothing removed. Pass --force to execute.')
        return

    timestamp = datetime.now().strftime('%Y%m%dT%H%M%S')
    trash = scriv / '_trash'
    trash.mkdir(exist_ok=True)

    removed_wt, failed_wt = [], []
    for p in orphaned_wt:
        rc, out = run(['git', 'worktree', 'remove', '--force', str(p)], agora)
        if rc == 0:
            removed_wt.append(p.name)
            print(f'  Removed worktree: {p.name}')
        else:
            failed_wt.append((p.name, out))
            print(f'  FAILED worktree: {p.name} — {out}', file=sys.stderr)

    trashed_sc, failed_sc = [], []
    for p in orphaned_sc:
        stem = p.name[:-6]
        dest = trash / f'{stem}-{timestamp}.scriv'
        try:
            shutil.move(str(p), str(dest))
            trashed_sc.append(p.name)
            print(f'  Trashed: {p.name} → _trash/{dest.name}')
        except Exception as exc:
            failed_sc.append((p.name, str(exc)))
            print(f'  FAILED scriv: {p.name} — {exc}', file=sys.stderr)

    print()
    print(f'Done. Worktrees removed: {len(removed_wt)}, failed: {len(failed_wt)}. '
          f'Scrivener trashed: {len(trashed_sc)}, failed: {len(failed_sc)}.')
    if failed_wt or failed_sc:
        sys.exit(1)


if __name__ == '__main__':
    main()
