#!/usr/bin/env python3
"""Build/check a source inventory; optionally package it without local artifacts."""
from pathlib import Path
import argparse
import hashlib
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = {'README.md', 'LICENSE', 'VERSION', 'INSTALL-IN-CODEX.md', 'POLICY.md',
              'WORKER-INSTRUCTIONS.md', 'SOURCES.md', 'CONTRIBUTING.md',
              'SECURITY.md', 'CHANGELOG.md', '.gitignore', 'install.py',
              'INSTALL-IN-OPENCODE.md', 'install_opencode.py'}
TREES = {'docs', 'skill', 'examples', 'tests', 'scripts', 'opencode'}
SUFFIXES = {'.md', '.py', '.json', '.yaml', '.svg'}


def selected(root=ROOT):
    files = []
    for p in root.rglob('*'):
        rel = p.relative_to(root)
        if p.is_symlink():
            if rel.parts[0] in TREES or rel.as_posix() in ROOT_FILES:
                raise ValueError(f'Symlink in distribution: {rel}')
            continue
        if not p.is_file():
            continue
        if any(part.startswith('.') or part == '__pycache__' for part in rel.parts) and rel.as_posix() != '.gitignore':
            continue
        if '.before-' in p.name or p.name in {'routing.json', 'receipt.json', 'auth.json'}:
            continue
        if rel.as_posix() in ROOT_FILES or (rel.parts[0] in TREES and p.suffix in SUFFIXES):
            files.append(p)
    return sorted(files)


def inventory(root=ROOT):
    return ''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(root).as_posix()}\n' for p in selected(root))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--zip', action='store_true')
    args = parser.parse_args()
    manifest = ROOT / 'MANIFEST.sha256'
    expected = inventory()
    if args.check or args.zip:
        if not manifest.exists() or manifest.read_text() != expected:
            raise SystemExit('Inventory stale. Review changes, then run python3 -B scripts/release.py.')
        print(f'Inventory valid: {len(selected())} files.')
    else:
        manifest.write_text(expected)
        print(f'Inventory written: {len(selected())} files.')
    if args.zip:
        version = (ROOT / 'VERSION').read_text().strip()
        if not version or any(c not in '0123456789.-abcdefghijklmnopqrstuvwxyz' for c in version):
            raise SystemExit('Unsafe version.')
        folder = f'astra-flash-orchestrator-{version}'
        out = ROOT / 'dist' / f'{folder}.zip'
        out.parent.mkdir(exist_ok=True)
        with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for p in selected() + [manifest]:
                info = zipfile.ZipInfo(f'{folder}/{p.relative_to(ROOT).as_posix()}', date_time=(2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, p.read_bytes())
        print(f'Archive: {out.name}')
        print(f'SHA256: {hashlib.sha256(out.read_bytes()).hexdigest()}')


if __name__ == '__main__':
    main()
