#!/usr/bin/env node
// Write or check MANIFEST.sha256: the hashed inventory of distributable files.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_FILES = ['README.md', 'LICENSE', 'VERSION', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'SOURCES.md',
  'INSTALL-IN-CODEX.md', 'INSTALL-IN-OPENCODE.md', '.gitignore', 'package.json'];
const TREES = ['plugins', 'panel', 'docs', 'examples', 'tests', 'scripts', 'legacy', '.agents/plugins'];
const SUFFIXES = new Set(['.md', '.mjs', '.js', '.json', '.yaml', '.svg', '.toml', '.html', '.css', '.jpg', '.gif', '.py', '.sha256']);
// Internal design notes stay in the working tree but are not part of a release.
const EXCLUDED_DIRS = new Set(['docs/superpowers', 'docs/agent-work']);
const EXCLUDED_NAMES = new Set(['.DS_Store', 'routing.json', 'receipt.json', 'auth.json']);

export function selected(root = ROOT) {
  const files = ROOT_FILES.filter((file) => fs.existsSync(path.join(root, file)));
  const walk = (rel) => {
    const stat = fs.lstatSync(path.join(root, rel));
    if (stat.isSymbolicLink()) throw new Error(`Symlink in distribution: ${rel}`);
    if (stat.isDirectory()) {
      if (EXCLUDED_DIRS.has(rel) || path.basename(rel) === 'node_modules') return;
      for (const name of fs.readdirSync(path.join(root, rel))) walk(`${rel}/${name}`);
      return;
    }
    const base = path.basename(rel);
    if (EXCLUDED_NAMES.has(base) || base.includes('.before-')) return;
    if (SUFFIXES.has(path.extname(base)) || ['LICENSE', 'VERSION', '.gitignore'].includes(base)) files.push(rel);
  };
  for (const tree of TREES) if (fs.existsSync(path.join(root, tree))) walk(tree);
  for (const file of files) if (fs.lstatSync(path.join(root, file)).isSymbolicLink()) throw new Error(`Symlink in distribution: ${file}`);
  return [...new Set(files)].sort();
}

export function inventory(root = ROOT) {
  return selected(root)
    .map((rel) => `${createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex')}  ${rel}\n`)
    .join('');
}

export function buildArchive(root, output) {
  const manifest = fs.readFileSync(path.join(root, 'MANIFEST.sha256'), 'utf8');
  if (manifest !== inventory(root)) throw new Error('Inventory stale; refusing archive.');
  const files = [...selected(root), 'MANIFEST.sha256'].sort();
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'crack-release-'));
  const temp = path.join(stage, 'artifact.tar.gz');
  const contents = path.join(stage, 'contents');
  try {
    for (const file of files) {
      const target = path.join(contents, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, file), target);
      fs.chmodSync(target, 0o644);
    }
    execFileSync('tar', ['-czf', temp, '-C', contents, ...files]);
    const actual = execFileSync('tar', ['-tzf', temp], { encoding: 'utf8' }).trim().split('\n').sort();
    if (JSON.stringify(actual) !== JSON.stringify(files)) throw new Error('Archive file list differs from the inventory.');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(temp, output);
    return { file: output, files: files.length, sha256: createHash('sha256').update(fs.readFileSync(output)).digest('hex') };
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

function main() {
  const manifest = path.join(ROOT, 'MANIFEST.sha256');
  const expected = inventory();
  const count = expected.split('\n').filter(Boolean).length;
  if (process.argv.includes('--check') || process.argv.includes('--archive')) {
    if (!fs.existsSync(manifest) || fs.readFileSync(manifest, 'utf8') !== expected) {
      process.stderr.write('Inventory stale. Review the changes, then run: node scripts/release.mjs\n');
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`Inventory valid: ${count} files.\n`);
    if (process.argv.includes('--archive')) {
      const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
      if (!/^[a-zA-Z0-9.+-]+$/.test(version)) throw new Error('Unsafe version.');
      process.stdout.write(JSON.stringify(buildArchive(ROOT, path.join(ROOT, 'dist', `codex-on-crack-${version}.tar.gz`))) + '\n');
    }
  } else {
    fs.writeFileSync(manifest, expected);
    process.stdout.write(`Inventory written: ${count} files.\n`);
  }
}

// Only run the CLI when this file is the entrypoint. argv[1] is absent under
// `node --eval`, is "-" under `node --input-type=module -`, and can name a
// missing path; resolving those blindly raised ENOENT and broke plain imports.
export function isEntrypoint(argv = process.argv, moduleUrl = import.meta.url) {
  const target = argv[1];
  if (typeof target !== 'string' || target === '' || target === '-') return false;
  try {
    return fs.realpathSync(target) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntrypoint()) main();
