import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cli } from './helpers.mjs';

function gitRepo(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crack-repo-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const g = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(root, 'README.md'), 'r\n');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  return { root, g, read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8') };
}
const wt = (repo, command, ...args) => cli('worktree.mjs', [command, '--repo', repo.root, ...args]);

test('add creates an isolated worktree on its own branch and keeps .crack out of git status', (t) => {
  const repo = gitRepo(t);
  const r = wt(repo, 'add', '--task', 'T1');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.branch, 'crack/T1');
  assert.deepEqual(r.json.warnings, []);
  assert.equal(fs.readFileSync(path.join(r.json.path, 'src', 'a.txt'), 'utf8'), 'a\n');
  assert.equal(repo.g('status', '--porcelain'), '');
  assert.equal(wt(repo, 'add', '--task', 'T1').json.error, 'worktree_exists');
});

test('add rejects a baseline that would omit uncommitted changes', (t) => {
  const repo = gitRepo(t);
  fs.writeFileSync(path.join(repo.root, 'README.md'), 'dirty\n');
  assert.equal(wt(repo, 'add', '--task', 'T1').json.error, 'dirty_baseline');
  assert.equal(repo.g('branch', '--list', 'crack/T1'), '');
});

test('integrate refuses changes outside allowed_paths and applies nothing', (t) => {
  const repo = gitRepo(t);
  const dir = wt(repo, 'add', '--task', 'T1').json.path;
  fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'sneaky\n');
  const r = wt(repo, 'integrate', '--task', 'T1', '--allowed', 'src', '--apply');
  assert.equal(r.status, 2);
  assert.equal(r.json.error, 'scope_violation');
  assert.match(r.json.message, /README\.md/);
  assert.equal(repo.read('src/a.txt'), 'a\n');
});

test('integrate previews, then applies modified and new files without committing', (t) => {
  const repo = gitRepo(t);
  const dir = wt(repo, 'add', '--task', 'T1').json.path;
  fs.writeFileSync(path.join(dir, 'src', 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(dir, 'src', 'b.txt'), 'new\n');
  const preview = wt(repo, 'integrate', '--task', 'T1', '--allowed', 'src');
  assert.equal(preview.status, 0, preview.stdout);
  assert.deepEqual(preview.json.changed.sort(), ['src/a.txt', 'src/b.txt']);
  assert.equal(preview.json.applied, false);
  assert.equal(repo.read('src/a.txt'), 'a\n');
  const applied = wt(repo, 'integrate', '--task', 'T1', '--allowed', 'src', '--apply');
  assert.equal(applied.status, 0, applied.stdout);
  assert.equal(repo.read('src/a.txt'), 'changed\n');
  assert.equal(repo.read('src/b.txt'), 'new\n');
  assert.equal(repo.g('rev-list', '--count', 'HEAD').trim(), '1');
});

test('remove cleans up an integrated worktree and its branch, but refuses unintegrated work', (t) => {
  const repo = gitRepo(t);
  const one = wt(repo, 'add', '--task', 'T1').json.path;
  fs.writeFileSync(path.join(one, 'src', 'a.txt'), 'changed\n');
  wt(repo, 'integrate', '--task', 'T1', '--allowed', 'src', '--apply');
  const removed = wt(repo, 'remove', '--task', 'T1');
  assert.equal(removed.status, 0, removed.stdout);
  assert.equal(removed.json.branch_deleted, true);
  assert.equal(fs.existsSync(one), false);
  assert.equal(repo.g('branch', '--list', 'crack/T1'), '');
  assert.equal(wt(repo, 'add', '--task', 'T2').json.error, 'dirty_baseline');
  // Simulate the user's deliberate checkpoint; the helper itself never commits.
  repo.g('add', 'src/a.txt'); repo.g('commit', '-qm', 'accepted fixture');
  const two = wt(repo, 'add', '--task', 'T2').json.path;
  fs.writeFileSync(path.join(two, 'src', 'a.txt'), 'unreviewed\n');
  const refused = wt(repo, 'remove', '--task', 'T2');
  assert.equal(refused.status, 2);
  assert.equal(refused.json.error, 'git_failed');
  assert.equal(fs.existsSync(two), true);
  assert.equal(wt(repo, 'remove', '--task', 'T2', '--force').json.error, 'unsafe_cleanup');
  assert.equal(fs.existsSync(two), true);
});

test('worktree reports usage and location errors', (t) => {
  const repo = gitRepo(t);
  assert.equal(wt(repo, 'add').json.error, 'usage');
  assert.equal(wt(repo, 'add', '--task', 'a/b').json.error, 'usage');
  assert.equal(wt(repo, 'bogus', '--task', 'T1').json.error, 'usage');
  assert.equal(cli('worktree.mjs', ['add', '--repo', path.join(repo.root, 'src'), '--task', 'T1']).json.error, 'not_repo_root');
  wt(repo, 'add', '--task', 'T1');
  assert.equal(wt(repo, 'integrate', '--task', 'T1').json.error, 'usage');
  assert.equal(wt(repo, 'integrate', '--task', 'T9', '--allowed', 'src').json.error, 'worktree_missing');
});


test('cleanup preserves ignored data and a patch removed from the destination', (t) => {
  const repo=gitRepo(t);
  fs.writeFileSync(path.join(repo.root,'.gitignore'),'private.local\n');
  repo.g('add','.gitignore');repo.g('commit','-qm','ignore fixture');
  const dir=wt(repo,'add','--task','T1').json.path;
  fs.writeFileSync(path.join(dir,'src/a.txt'),'accepted\n');
  assert.equal(wt(repo,'integrate','--task','T1','--allowed','src','--apply').status,0);
  fs.writeFileSync(path.join(dir,'private.local'),'unintegrated fixture data');
  assert.equal(wt(repo,'remove','--task','T1').json.error,'remaining_files');
  assert.equal(fs.readFileSync(path.join(dir,'private.local'),'utf8'),'unintegrated fixture data');
  fs.unlinkSync(path.join(dir,'private.local'));
  fs.writeFileSync(path.join(repo.root,'src/a.txt'),'a\n');
  assert.equal(wt(repo,'remove','--task','T1').json.error,'git_failed');
  assert.equal(fs.existsSync(dir),true);
});
