#!/usr/bin/env node
// Build the clean distributable archive.
//
// The archive contains exactly the release inventory plus MANIFEST.sha256, and
// the build refuses if:
//   - MANIFEST.sha256 does not match the files in this package;
//   - any entry looks like a private log, VCS data, dependency tree, or archive;
//   - any text entry contains the packaging host's home path or a
//     credential-shaped string.
// The ZIP is written store-only with fixed timestamps, so the same input
// produces the same bytes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inventory, selected } from './release.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN_ENTRY = /(^|\/)(?:node_modules|\.git|dist|\.local|\.crack|sessions|captures|recordings|agent-work|superpowers)(\/|$)|\.(?:log|jsonl|zip|tar|tgz|gz)$|(^|\/)\.env|(^|\/)(?:AGENTS|CLAUDE|MEMORY)\.md$/i;
const CREDENTIAL_SHAPES = [
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /sk-(?:proj|live)-[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{30,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[baprs]-[A-Za-z0-9-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Store-only ZIP with a fixed DOS timestamp (1980-01-01) for reproducibility.
export function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += local.length + name.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuffer, end]);
}

export function readZipEntries(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end === -1) throw new Error('not a zip archive');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory');
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    out.push({ name, size, data: buffer.subarray(start, start + size) });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

export function scanEntries(entries, home = os.homedir()) {
  const problems = [];
  for (const entry of entries) {
    if (FORBIDDEN_ENTRY.test(entry.name)) problems.push({ entry: entry.name, reason: 'forbidden path' });
    let text = null;
    try {
      text = entry.data.toString('utf8');
      if (text.includes('\u0000')) text = null;
    } catch {
      text = null;
    }
    if (text === null) continue;
    if (text.includes(home)) problems.push({ entry: entry.name, reason: 'contains the packaging host home path' });
    for (const shape of CREDENTIAL_SHAPES) {
      if (shape.test(text)) {
        problems.push({ entry: entry.name, reason: `matches credential shape ${shape}` });
        break;
      }
    }
  }
  return problems;
}

export function pack({ out = null, root = PACKAGE_ROOT, home = os.homedir(), now = () => new Date() } = {}) {
  const manifest = path.join(root, 'MANIFEST.sha256');
  if (!fs.existsSync(manifest)) throw new Error('MANIFEST.sha256 is missing');
  if (fs.readFileSync(manifest, 'utf8') !== inventory(root)) {
    throw new Error('MANIFEST.sha256 does not match this package; run node scripts/release.mjs first');
  }
  const names = [...new Set([...selected(root), 'MANIFEST.sha256'])].sort();
  const entries = names.map((name) => ({ name, data: fs.readFileSync(path.join(root, name)) }));
  const problems = scanEntries(entries, home);
  if (problems.length) {
    const error = new Error(`refusing to pack: ${problems.length} entr(ies) failed the content scan`);
    error.problems = problems;
    throw error;
  }
  const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  const target = out ?? path.join(root, 'dist', `codex-on-crack-${version}.zip`);
  const buffer = buildZip(entries);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  fs.writeFileSync(target, buffer, { mode: 0o644 });
  return {
    ok: true,
    archive: path.resolve(target),
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    bytes: buffer.length,
    files: entries.length,
    generatedAt: now().toISOString(),
    contents: entries.map((entry) => entry.name),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let values = {};
  try {
    ({ values } = parseArgs({ strict: true, options: { out: { type: 'string' }, help: { type: 'boolean' } } }));
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'usage', message: error.message }, null, 2)}\n`);
    process.exit(2);
  }
  if (values.help) {
    process.stdout.write('Usage: pack.mjs [--out dist/archive.zip]\nWrites the clean distributable archive from MANIFEST.sha256.\n');
  } else {
    try {
      const result = pack({ out: values.out ?? null });
      process.stdout.write(`${JSON.stringify({ ...result, contents: undefined, contentCount: result.contents.length }, null, 2)}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: 'pack_failed', message: error.message, problems: error.problems ?? null }, null, 2)}\n`);
      process.exit(2);
    }
  }
}
