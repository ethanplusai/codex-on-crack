#!/usr/bin/env node
// Isolated worktrees for parallel writers: add, integrate (scope-checked), remove.
// Never commits, merges, pushes, or deletes a branch that holds unmerged commits.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { CrackError, atomicWrite, ok, readIfExists, run, sha256 } from './lib/io.mjs';
import { normalizePath } from './lib/plan.mjs';

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const OPTIONS = {
  repo: { type: 'string' },
  task: { type: 'string' },
  base: { type: 'string' },
  allowed: { type: 'string', multiple: true },
  apply: { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
};
const USAGE = 'Usage: worktree.mjs <add|integrate|remove> --repo <root> --task <id> [--base <ref>] [--allowed <path>]... [--apply] [--force]';

function git(cwd, args, input) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    const detail = String(error.stderr ?? '').trim().split('\n').pop() || 'no detail';
    throw new CrackError('git_failed', `git ${args[0]} failed: ${detail}`, 'Inspect the repository state, then retry.');
  }
}

function context(values) {
  if (!values.repo || !values.task) throw new CrackError('usage', '--repo and --task are required.', USAGE);
  if (!TASK_ID.test(values.task)) throw new CrackError('usage', '--task must be a plan task id.', USAGE);
  let repo;
  try {
    repo = fs.realpathSync(values.repo);
  } catch {
    throw new CrackError('not_repo_root', `${values.repo} does not exist.`, 'Pass the repository root as --repo.');
  }
  const top = fs.realpathSync(git(repo, ['rev-parse', '--show-toplevel']).trim());
  if (top !== repo) throw new CrackError('not_repo_root', 'Pass the repository root as --repo.', `The root is ${top}.`);
  const dir = path.join(repo, '.crack', 'worktrees', values.task);
  return {
    repo,
    task: values.task,
    dir,
    branch: `crack/${values.task}`,
    baseFile: `${dir}.base`,
    integratedFile: `${dir}.integrated`,
  };
}

function excludeCrackDir(repo) {
  const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  const file = path.join(common, 'info', 'exclude');
  const current = readIfExists(file)?.toString('utf8') ?? '';
  if (current.split('\n').includes('/.crack/')) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}/.crack/\n`);
}

function readBase(c) {
  const base = readIfExists(c.baseFile)?.toString('utf8').trim();
  if (!base) throw new CrackError('worktree_missing', `The base commit record for ${c.task} is missing.`, 'Recreate the worktree.');
  return base;
}

// Every path the worker changed relative to the base, including new files.
function changedPaths(c, base) {
  const untracked = git(c.dir, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  if (untracked.length) git(c.dir, ['add', '--intent-to-add', '--', ...untracked]);
  return git(c.dir, ['diff', '--name-only', '--no-renames', '-z', base]).split('\0').filter(Boolean);
}

function patchFor(c, base) {
  return git(c.dir, ['diff', '--binary', '--no-renames', base]);
}

function add(values) {
  const c = context(values);
  if (fs.existsSync(c.dir)) throw new CrackError('worktree_exists', `A worktree for ${c.task} already exists.`, 'Integrate or remove it first.');
  if (git(c.repo, ['status', '--porcelain']).trim()) {
    throw new CrackError('dirty_baseline', 'A new worktree would omit uncommitted dependency outputs or user work.',
      'Continue sequentially in the current workspace. Do not auto-commit or discard changes to bypass this guard.');
  }
  excludeCrackDir(c.repo);
  const base = git(c.repo, ['rev-parse', '--verify', `${values.base ?? 'HEAD'}^{commit}`]).trim();
  git(c.repo, ['worktree', 'add', '-b', c.branch, c.dir, base]);
  atomicWrite(c.baseFile, `${base}\n`, 0o644);
  const dirty = git(c.repo, ['status', '--porcelain']).trim() !== '';
  return ok({
    path: c.dir,
    branch: c.branch,
    base,
    warnings: dirty
      ? ['The main workspace has uncommitted changes. They are not in this worktree, which starts from the base commit; brief the worker accordingly.']
      : [],
  });
}

function integrate(values) {
  const c = context(values);
  if (!fs.existsSync(c.dir)) throw new CrackError('worktree_missing', `No worktree for ${c.task}.`, 'Add it first.');
  const allowed = (values.allowed ?? []).map((entry) => normalizePath(entry, '--allowed'));
  if (!allowed.length) throw new CrackError('usage', "--allowed is required: pass the task's allowed_paths.", USAGE);
  const base = readBase(c);
  const changed = changedPaths(c, base);
  const outside = changed.filter((file) => !allowed.some((scope) => file === scope || file.startsWith(`${scope}/`)));
  if (outside.length) {
    throw new CrackError('scope_violation', `The worktree changed paths outside the task's allowed_paths: ${outside.join(', ')}.`,
      'Send the task back for correction. Nothing was applied.');
  }
  if (!changed.length) return ok({ changed, applied: false, note: 'Nothing to integrate.' });
  const patch = patchFor(c, base);
  git(c.repo, ['apply', '--check', '--whitespace=nowarn'], patch);
  if (values.apply) {
    git(c.repo, ['apply', '--whitespace=nowarn'], patch);
    atomicWrite(c.integratedFile, `${sha256(patch)}\n`, 0o644);
  }
  return ok({
    changed,
    applied: values.apply,
    note: values.apply
      ? 'Applied to the main workspace without committing. Review it there, then remove the worktree.'
      : 'Preview only: the patch applies cleanly. Add --apply to apply it.',
  });
}

function remove(values) {
  const c = context(values);
  if (!fs.existsSync(c.dir)) throw new CrackError('worktree_missing', `No worktree for ${c.task}.`, 'Nothing to remove.');
  if (values.force) throw new CrackError('unsafe_cleanup', 'Forced cleanup is not supported by this helper.', 'Preserve remaining files and inspect the worktree manually.');
  const ignored = git(c.dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  if (ignored.length) throw new CrackError('remaining_files', 'Ignored files remain in the worktree; cleanup refused.', 'Preserve or explicitly remove them yourself before retrying.');
  let force = false;
  const integrated = readIfExists(c.integratedFile)?.toString('utf8').trim();
  if (!force && integrated) {
    // Safe to discard only if the worktree still holds exactly what was integrated.
    const base = readBase(c);
    changedPaths(c, base);
    const patch = patchFor(c, base);
    force = integrated === sha256(patch);
    if (force) git(c.repo, ['apply', '--reverse', '--check', '--whitespace=nowarn'], patch);
  }
  git(c.repo, ['worktree', 'remove', ...(force ? ['--force'] : []), c.dir]);
  for (const file of [c.baseFile, c.integratedFile]) fs.rmSync(file, { force: true });
  let branchDeleted = true;
  try {
    git(c.repo, ['branch', '-d', c.branch]);
  } catch {
    branchDeleted = false;
  }
  return ok({
    removed: c.dir,
    branch: c.branch,
    branch_deleted: branchDeleted,
    note: branchDeleted ? 'Removed.' : `Kept branch ${c.branch}: it has commits that are not merged.`,
  });
}

const COMMANDS = { add, integrate, remove };

run((argv) => {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new CrackError('usage', error.message, USAGE);
  }
  const command = COMMANDS[parsed.positionals[0]];
  if (!command || parsed.positionals.length !== 1) throw new CrackError('usage', 'Unknown or missing command.', USAGE);
  return command(parsed.values);
});
