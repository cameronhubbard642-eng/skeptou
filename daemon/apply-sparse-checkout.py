#!/usr/bin/env python3
"""
apply-sparse-checkout.py — retroactively apply cone-mode sparse-checkout to
all existing dunamis worktrees under ~/Documents/agora-worktrees/dunamis/.

Each worktree is configured to show only:
    papers/<slug>/    working/<slug>/    templates/    slugs.yaml

The slug is resolved by matching the worktree directory name (<slug>-<direction>)
against the slug list in energeia:slugs.yaml.

Usage:
    python3 daemon/apply-sparse-checkout.py [--dry-run]
    python3 daemon/apply-sparse-checkout.py --agora PATH --worktrees PATH

Options:
    --agora PATH        Path to agora git repo  (default: ~/Documents/agora)
    --worktrees PATH    Path to dunamis worktrees dir (default: ~/Documents/agora-worktrees/dunamis)
    --dry-run           Print what would be done without executing
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path


def run(cmd: list[str], cwd: Path) -> tuple[int, str]:
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=30)
    return r.returncode, (r.stdout + r.stderr).strip()


def fetch_slugs(agora: Path) -> list[str]:
    """Read slug list from energeia branch of agora repo."""
    for ref in ('origin/energeia', 'energeia'):
        rc, out = run(['git', 'show', f'{ref}:slugs.yaml'], agora)
        if rc == 0:
            return re.findall(r'-\s+slug:\s*"?([a-z0-9][a-z0-9-]+)"?', out)
    print('ERROR: could not read slugs.yaml from energeia branch', file=sys.stderr)
    sys.exit(1)


def resolve_slug(stem: str, slugs: list[str]) -> str | None:
    """Find the paper slug whose name is a prefix of the worktree stem."""
    # Sort longest-first so 'style-constraint-agency' beats 'style'
    for slug in sorted(slugs, key=len, reverse=True):
        if stem == slug or stem.startswith(slug + '-'):
            return slug
    return None


def apply_sparse(worktree: Path, slug: str, dry_run: bool) -> bool:
    cmds = [
        ['git', 'sparse-checkout', 'init', '--cone'],
        ['git', 'sparse-checkout', 'set',
         f'papers/{slug}', f'working/{slug}', 'templates', 'slugs.yaml'],
    ]
    for cmd in cmds:
        if dry_run:
            print(f'  [dry-run] {" ".join(cmd)}')
            continue
        rc, out = run(cmd, worktree)
        if rc != 0:
            print(f'  ERROR: {" ".join(cmd[1:3])} → {out}')
            return False
    return True


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--agora', type=Path,
                   default=Path.home() / 'Documents' / 'agora')
    p.add_argument('--worktrees', type=Path,
                   default=Path.home() / 'Documents' / 'agora-worktrees' / 'dunamis')
    p.add_argument('--dry-run', action='store_true')
    args = p.parse_args()

    if not args.agora.exists():
        print(f'ERROR: agora not found at {args.agora}', file=sys.stderr)
        sys.exit(1)
    if not args.worktrees.exists():
        print(f'No worktrees directory found at {args.worktrees}')
        sys.exit(0)

    slugs = fetch_slugs(args.agora)
    print(f'Known slugs ({len(slugs)}): {", ".join(slugs)}')
    print()

    ok_count = skip_count = err_count = 0

    for wt in sorted(args.worktrees.iterdir()):
        if not wt.is_dir():
            continue
        stem = wt.name
        slug = resolve_slug(stem, slugs)
        if not slug:
            print(f'[SKIP]  {stem} — no matching slug in slugs.yaml')
            skip_count += 1
            continue

        label = '[dry-run]' if args.dry_run else '[apply] '
        print(f'{label} {stem} → slug={slug}')
        ok = apply_sparse(wt, slug, args.dry_run)
        if ok:
            print(f'  papers/{slug}/, working/{slug}/, templates/, slugs.yaml')
            ok_count += 1
        else:
            err_count += 1

    print()
    print(f'Done: {ok_count} applied, {skip_count} skipped, {err_count} errors')
    if err_count:
        sys.exit(1)


if __name__ == '__main__':
    main()
