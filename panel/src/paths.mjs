// Path containment and safe artifact reads for the panel controller.
//
// Every file the panel reads is named by trusted startup configuration or by
// a validated evidence submission, and must resolve (after following every
// symlink) inside one of the registered workspace roots. Reads are bounded,
// refuse symlinked leaves, and confirm the opened file is the one that was
// checked.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalPathSync } from '../../plugins/codex-on-crack/skills/crack/scripts/lib/external-lead.mjs';
import { isInsideRoot } from '../../plugins/codex-on-crack/skills/crack/scripts/lib/lead-protocol.mjs';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_TEXT_BYTES = 256 * 1024;

export class PanelError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// The canonical location of `candidate` when it lies inside one of `roots`
// (which must already be canonical), otherwise null. Lexical traversal is
// collapsed first, then every existing ancestor is resolved, so neither
// `root/../x` nor a symlink inside a root can widen the scope.
export function resolveInside(roots, candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || candidate.includes('\0')) return null;
  const canonical = canonicalPathSync(candidate);
  if (canonical === null) return null;
  return roots.some((root) => isInsideRoot(root, canonical)) ? canonical : null;
}

export function canonicalDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  try {
    const real = fs.realpathSync(value);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

const SIGNATURES = [
  { type: 'image/png', test: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/jpeg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', test: (b) => b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')) },
  { type: 'image/webp', test: (b) => b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

// Raster formats only, identified by content rather than extension. SVG is
// deliberately excluded: it can carry script.
export function sniffImage(buffer) {
  return SIGNATURES.find((signature) => signature.test(buffer))?.type ?? null;
}

const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
const APPEND_FLAGS = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
const CREATE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);

// The one read path for every file the panel consumes: evidence, registered
// request/prompt files, run artifacts, and its own state. The file is opened
// (O_NOFOLLOW, O_NONBLOCK so a FIFO cannot hang the panel), then checked
// *through the open descriptor*: a regular file within the size limit, and
// still the file that the canonical path names once the open has happened.
// The bytes returned are read from that descriptor, so there is no
// check-then-reread window. `exact` additionally pins the canonical path, so a
// run directory swapped for a symlink (even one pointing inside a root) is
// refused instead of followed.
//
// `reuse(stat)` lets a display-only caller skip re-reading bytes it already
// hashed for this exact descriptor identity; it runs after every safety check.
export function readVerifiedSync(roots, candidate, { maxBytes = MAX_IMAGE_BYTES, exact = null, reuse = null } = {}) {
  const canonical = resolveInside(roots, candidate);
  if (canonical === null) throw new PanelError('outside_roots', 'The file is not inside a registered location.', 403);
  if (exact !== null && canonical !== exact) throw new PanelError('path_changed', 'The file no longer resolves where it was registered.', 409);
  let fd;
  try {
    fd = fs.openSync(canonical, READ_FLAGS);
  } catch (error) {
    if (error.code === 'ENOENT') throw new PanelError('artifact_missing', 'The file does not exist.', 404);
    if (error.code === 'ELOOP' || error.code === 'EMLINK') throw new PanelError('artifact_changed', 'The file was replaced by a symlink.', 409);
    throw new PanelError('artifact_unreadable', 'The file could not be opened.', 403);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new PanelError('artifact_unreadable', 'The file is not a regular file.', 403);
    if (stat.size > maxBytes) throw new PanelError('artifact_too_large', `The file exceeds the ${maxBytes}-byte limit.`, 413);
    let after = null;
    try { after = fs.lstatSync(canonical); } catch { after = null; }
    if (canonicalPathSync(canonical) !== canonical || after === null || after.dev !== stat.dev || after.ino !== stat.ino) {
      throw new PanelError('artifact_changed', 'The file changed while it was being opened.', 409);
    }
    const reused = reuse?.(stat);
    if (reused !== undefined && reused !== null) return { path: canonical, data: null, stat, reused };
    // A growing file (a live event stream) is read up to its size at open,
    // never past the limit.
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const bytesRead = fs.readSync(fd, buffer, offset, length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { path: canonical, data: buffer.subarray(0, offset), stat };
  } finally {
    fs.closeSync(fd);
  }
}

export async function readContained(roots, candidate, options = {}) {
  return readVerifiedSync(roots, candidate, options);
}

// A private directory owned by this user: created 0700 if absent, and refused
// when it is a symlink, not a directory, or owned by someone else.
export function ensurePrivateDir(dir, { create = true } = {}) {
  if (create) {
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new PanelError('state_invalid', 'A panel state directory is not a plain directory.', 500);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new PanelError('state_invalid', 'A panel state directory belongs to another user.', 500);
  return stat;
}

// Append one line to a controller state file without following a symlink and
// without writing through a hard link to some other file.
export function appendPrivateLine(file, line) {
  const fd = fs.openSync(file, APPEND_FLAGS, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new PanelError('state_invalid', 'A panel state file is not a private regular file.', 500);
    fs.writeSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
}

// Create a new file exclusively (never reusing or following an existing
// entry) and write `data` to it.
export function writeExclusiveSync(file, data) {
  const fd = fs.openSync(file, CREATE_FLAGS, 0o600);
  try {
    fs.writeSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

export async function readImage(roots, candidate, options = {}) {
  const { path: canonical, data } = readVerifiedSync(roots, candidate, options);
  const type = sniffImage(data);
  if (type === null) throw new PanelError('unsupported_image', 'Only PNG, JPEG, GIF, and WebP evidence images are served.', 415);
  return { path: canonical, data, type, sha256: sha256(data), bytes: data.length };
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// A short label for display: the file name only, never the directory.
export function fileLabel(file) {
  const base = path.basename(String(file ?? ''));
  return base.replace(/[^\w .()+-]/g, '_').slice(0, 80) || 'file';
}
