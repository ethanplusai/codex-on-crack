import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CrackError, atomicWrite, failure, ok, readIfExists, readInput, refuseSymlinks, sha256,
} from '../plugins/codex-on-crack/skills/crack/scripts/lib/io.mjs';

function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crack-io-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('sha256 hashes bytes and passes null through', () => {
  assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256(null), null);
});

test('atomicWrite creates parents, sets the mode, and leaves no temp files', (t) => {
  const file = path.join(tempDir(t), 'a', 'b', 'x.toml');
  atomicWrite(file, 'hello', 0o600);
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['x.toml']);
  atomicWrite(file, 'again', 0o644);
  assert.equal(fs.readFileSync(file, 'utf8'), 'again');
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
});

test('refuseSymlinks rejects a symlinked ancestor, and atomicWrite will not write through one', (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'real'));
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
  assert.throws(() => refuseSymlinks(path.join(dir, 'link', 'x')), (e) => e instanceof CrackError && e.code === 'symlink_refused');
  assert.throws(() => atomicWrite(path.join(dir, 'link', 'x'), 'no'), { code: 'symlink_refused' });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'real')), []);
});

test('readIfExists returns null for a missing file, bytes for a file, and refuses a directory', (t) => {
  const dir = tempDir(t);
  assert.equal(readIfExists(path.join(dir, 'missing')), null);
  fs.writeFileSync(path.join(dir, 'plain'), 'x');
  assert.equal(readIfExists(path.join(dir, 'plain', 'child')), null);
  fs.writeFileSync(path.join(dir, 'f'), 'data');
  assert.equal(readIfExists(path.join(dir, 'f')).toString('utf8'), 'data');
  assert.throws(() => readIfExists(dir), { code: 'not_a_file' });
});

test('failure shapes expected errors and never echoes an unexpected error message', () => {
  const unexpected = failure(new Error('api_key=TEST_SECRET_KEY'));
  assert.equal(unexpected.ok, false);
  assert.equal(unexpected.error, 'internal_error');
  assert.ok(!JSON.stringify(unexpected).includes('TEST_SECRET_KEY'));
  assert.deepEqual(failure(new CrackError('x', 'msg', 'hint')), { ok: false, error: 'x', message: 'msg', hint: 'hint' });
  assert.deepEqual(ok({ a: 1 }), { ok: true, a: 1 });
});

// macOS links /tmp and /var into /private, so a draft or plan the user points
// at routinely sits under a symlink. Inputs follow it; managed trees never do.
test('readInput follows a symlinked ancestor that readIfExists refuses', (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'real'));
  fs.writeFileSync(path.join(dir, 'real', 'draft.toml'), 'x = 1\n');
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
  assert.equal(readInput(path.join(dir, 'link', 'draft.toml')).toString('utf8'), 'x = 1\n');
  assert.throws(() => readIfExists(path.join(dir, 'link', 'draft.toml')), { code: 'symlink_refused' });
  assert.equal(readInput(path.join(dir, 'link', 'missing.toml')), null);
});
