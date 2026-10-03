// Shared I/O for codex-on-crack scripts: JSON results, atomic writes, hashing.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class CrackError extends Error {
  constructor(code, message, hint = null) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export function sha256(data) {
  return data == null ? null : createHash('sha256').update(data).digest('hex');
}

// Refuse a path when it, or any ancestor, is a symlink. Roots come from
// locations(), which resolves them, so a symlink found here was planted inside
// the tree we are about to read or write.
export function refuseSymlinks(target) {
  let current = path.resolve(target);
  for (;;) {
    let stat = null;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    if (stat?.isSymbolicLink()) {
      throw new CrackError('symlink_refused', `Refusing to use a path through a symlink: ${current}`,
        'Replace the symlink with a real directory or file, then retry.');
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function readIfExists(file) {
  refuseSymlinks(file);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    // ENOTDIR: an ancestor is a regular file, so this file cannot exist.
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
  if (!stat.isFile()) {
    throw new CrackError('not_a_file', `Expected a regular file: ${file}`, 'Move whatever is at that path aside, then retry.');
  }
  return fs.readFileSync(file);
}

// The real path of a file the user pointed at. When it does not exist yet,
// resolve its nearest existing ancestor instead. macOS links /tmp and /var into
// /private, so user inputs routinely sit under a symlink.
export function realInput(file) {
  const resolved = path.resolve(file);
  try {
    return fs.realpathSync(resolved);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    const parent = path.dirname(resolved);
    return parent === resolved ? resolved : path.join(realInput(parent), path.basename(resolved));
  }
}

// Read a file the user chose (a draft, a plan, a log). Unlike readIfExists,
// which guards the trees we write into, this follows symlinks to the real file.
export function readInput(file) {
  return readIfExists(realInput(file));
}

export function atomicWrite(file, data, mode = 0o600) {
  refuseSymlinks(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(file), `.crack-${randomBytes(6).toString('hex')}`);
  try {
    const fd = fs.openSync(temp, 'wx', mode);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function ok(fields = {}) {
  return { ok: true, ...fields };
}

export function failure(error) {
  if (error instanceof CrackError) {
    return { ok: false, error: error.code, message: error.message, hint: error.hint };
  }
  // An unexpected error's message can quote file contents; never echo it.
  return {
    ok: false,
    error: 'internal_error',
    message: `Unexpected ${error?.name ?? 'error'}; no further detail is reported.`,
    hint: 'Re-run the same command. If it repeats, inspect locally.',
  };
}

export async function run(main) {
  let result;
  try {
    result = await main(process.argv.slice(2));
  } catch (error) {
    result = failure(error);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 2;
}
