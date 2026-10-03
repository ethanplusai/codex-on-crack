// Change sets for the files codex-on-crack owns: preview, apply with a receipt,
// roll back on failure, and undo later. config.toml is never a valid target.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CrackError, atomicWrite, readIfExists, readInput, refuseSymlinks, sha256 } from './io.mjs';
import { MARKER } from './roles.mjs';

export const BACKUPS = 'crack-backups';
export const POLICY_BEGIN = '<!-- BEGIN codex-on-crack managed policy -->';
export const POLICY_END = '<!-- END codex-on-crack managed policy -->';
const AGENT_FILE = /^crack_[a-z0-9_]+\.toml$/;
const REFERENCES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'references');

export function managedPaths(codexHome) {
  return {
    crackToml: path.join(codexHome, 'crack', 'crack.toml'),
    agentsDir: path.join(codexHome, 'agents'),
    policy: [path.join(codexHome, 'AGENTS.md'), path.join(codexHome, 'AGENTS.override.md')],
  };
}

export function isManagedPath(codexHome, file) {
  const paths = managedPaths(codexHome);
  if (file === paths.crackToml || paths.policy.includes(file)) return true;
  return path.dirname(file) === paths.agentsDir && AGENT_FILE.test(path.basename(file));
}

export function policyBlock() {
  return fs.readFileSync(path.join(REFERENCES, 'policy.md'), 'utf8');
}

function malformed(message) {
  return new CrackError('policy_markers_malformed', message, 'Reconcile the codex-on-crack markers in AGENTS.md by hand, then retry.');
}

export function managedPolicy(original, block) {
  const count = (marker) => original.split(marker).length - 1;
  if (count(POLICY_BEGIN) !== count(POLICY_END) || count(POLICY_BEGIN) > 1) {
    throw malformed('The codex-on-crack policy block is malformed or duplicated.');
  }
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const body = `${block.replace(/\r\n/g, '\n').trimEnd().replace(/\n/g, newline)}${newline}`;
  if (original.includes(POLICY_BEGIN)) {
    const start = original.indexOf(POLICY_BEGIN);
    let end = original.indexOf(POLICY_END) + POLICY_END.length;
    if (end < start) throw malformed('The codex-on-crack policy markers are reversed.');
    if (original.slice(end, end + newline.length) === newline) end += newline.length;
    return original.slice(0, start) + body + original.slice(end);
  }
  const separator = !original ? '' : original.endsWith(newline) ? newline : newline + newline;
  return original + separator + body;
}

function readReceipts(codexHome) {
  const dir = path.join(codexHome, BACKUPS);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => !name.startsWith('.')).sort();
  } catch {
    return [];
  }
  const records = names.flatMap((name) => {
    const data = readIfExists(path.join(dir, name, 'receipt.json'));
    if (data === null) return [];
    try {
      return [{ ...JSON.parse(data.toString('utf8')), receipt_name: name }];
    } catch {
      return [];
    }
  });
  const legacy = records.filter((r) => !Number.isSafeInteger(r.operation_seq));
  if (new Set(legacy.map((r) => r.receipt_name.split('-')[0])).size !== legacy.length) {
    throw new CrackError('ambiguous_history', 'Legacy receipts have ambiguous operation order.', 'Preserve the files and receipts; reconcile ownership from backups before updating.');
  }
  return records.sort((a, b) => (a.operation_seq ?? 0) - (b.operation_seq ?? 0) || a.receipt_name.localeCompare(b.receipt_name));
}

function nextSequence(codexHome) {
  return Math.max(0, ...readReceipts(codexHome).map((r) => r.operation_seq ?? 0)) + 1;
}

function locked(codexHome, action) {
  const lock = path.join(codexHome, BACKUPS, '.lock');
  refuseSymlinks(lock);
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  try { fs.mkdirSync(lock); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new CrackError('setup_locked', 'Another setup or undo may be running.', 'Wait for it. After a crash, inspect before removing the stale .lock directory.');
  }
  try { return action(); } finally { fs.rmdirSync(lock); }
}

// What each managed file should contain now according to our own receipts:
// the hash we last wrote, or the hash an undo restored (null means absent).
export function ledger(codexHome) {
  const expected = new Map();
  for (const record of readReceipts(codexHome)) {
    for (const entry of record.files ?? []) {
      if (record.status === 'applied') expected.set(entry.path, entry.after_hash);
      if (record.status === 'restored') expected.set(entry.path, entry.before_hash);
    }
  }
  return expected;
}

function foreign(file) {
  return new CrackError('foreign_file', `${file} exists and was not created by codex-on-crack.`, 'Rename or remove it, then retry.');
}

// requested: Map<absolute path, string | null>, where null means delete.
export function planChanges(codexHome, requested) {
  const paths = managedPaths(codexHome);
  const expected = ledger(codexHome);
  const changes = [];
  for (const [file, after] of requested) {
    if (!isManagedPath(codexHome, file)) {
      throw new CrackError('unmanaged_path', `Refusing to write outside codex-on-crack's files: ${file}`, 'This is a bug; nothing was written.');
    }
    const before = readIfExists(file);
    const beforeText = before === null ? null : before.toString('utf8');
    if (beforeText === after) continue;
    if (before !== null && path.dirname(file) === paths.agentsDir) {
      if (!beforeText.startsWith(MARKER)) throw foreign(file);
      if (expected.get(file) !== sha256(before)) {
        throw new CrackError('edited_file', `${file} was edited after codex-on-crack wrote it.`,
          'Move your edits into crack.toml, delete the file, then retry.');
      }
    }
    if (before !== null && file === paths.crackToml && !beforeText.startsWith(MARKER)) throw foreign(file);
    changes.push({
      path: file,
      action: before === null ? 'create' : after === null ? 'delete' : 'update',
      before,
      after: after === null ? null : Buffer.from(after),
      mode: before === null ? 0o600 : fs.statSync(file).mode & 0o777,
    });
  }
  return changes;
}

function stamp() {
  const time = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${time}-${randomBytes(4).toString('hex')}`;
}

export function applyChanges(codexHome, changes, inputHashes = {}) {
  if (!changes.length) return null;
  return locked(codexHome, () => applyUnlocked(codexHome, changes, inputHashes));
}

function applyUnlocked(codexHome, changes, inputHashes) {
  if (!changes.length) return null;
  for (const [file, hash] of Object.entries(inputHashes)) {
    if (sha256(readInput(file)) !== hash) {
      throw new CrackError('inputs_changed', 'Codex configuration changed while setup was running.', 'Run setup again.');
    }
  }
  for (const change of changes) {
    if (sha256(readIfExists(change.path)) !== sha256(change.before)) {
      throw new CrackError('target_changed', `${change.path} changed while setup was running.`, 'Run setup again.');
    }
  }
  const dir = path.join(codexHome, BACKUPS, stamp());
  refuseSymlinks(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = changes.map((change, index) => {
    const beforeFile = change.before === null ? null : `before-${index}.bin`;
    if (beforeFile) atomicWrite(path.join(dir, beforeFile), change.before);
    return {
      path: change.path,
      action: change.action,
      before_file: beforeFile,
      before_hash: sha256(change.before),
      after_hash: sha256(change.after),
      mode: change.mode,
    };
  });
  const receipt = path.join(dir, 'receipt.json');
  const record = { format: 1, kind: 'codex-on-crack', status: 'prepared', operation_seq: nextSequence(codexHome), files };
  const save = () => atomicWrite(receipt, `${JSON.stringify(record, null, 2)}\n`);
  save();
  const done = [];
  try {
    for (const change of changes) {
      if (change.after === null) fs.rmSync(change.path);
      else atomicWrite(change.path, change.after, change.mode);
      done.push(change);
    }
  } catch (error) {
    for (const change of done.reverse()) {
      if (change.before === null) fs.rmSync(change.path, { force: true });
      else atomicWrite(change.path, change.before, change.mode);
    }
    record.status = 'rolled-back';
    save();
    throw error;
  }
  record.status = 'applied';
  save();
  return receipt;
}

export function undoReceipt(codexHome, receiptPath, { apply = false } = {}) {
  return apply ? locked(codexHome, () => undoUnlocked(codexHome, receiptPath, true)) : undoUnlocked(codexHome, receiptPath, false);
}

function undoUnlocked(codexHome, receiptPath, apply) {
  const root = path.join(codexHome, BACKUPS);
  const resolved = path.resolve(receiptPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative) || path.basename(resolved) !== 'receipt.json') {
    throw new CrackError('receipt_outside', "The receipt must be a receipt.json inside this CODEX_HOME's crack-backups folder.",
      'Pass the receipt path that setup apply printed.');
  }
  const data = readIfExists(resolved);
  if (data === null) throw new CrackError('receipt_missing', 'No receipt at that path.', 'Pass the receipt path that setup apply printed.');
  let record;
  try {
    record = JSON.parse(data.toString('utf8'));
  } catch {
    throw new CrackError('receipt_invalid', 'The receipt is not valid JSON.', 'Nothing was restored.');
  }
  if (record.format !== 1 || record.kind !== 'codex-on-crack' || record.status !== 'applied' || !Array.isArray(record.files)) {
    throw new CrackError('receipt_not_undoable', 'This receipt does not describe an applied, undoable change.',
      'Only an applied change can be undone, and only once.');
  }
  const pending = record.files.map((entry) => {
    if (typeof entry.path !== 'string' || !path.isAbsolute(entry.path) || !isManagedPath(codexHome, entry.path)) {
      throw new CrackError('receipt_outside', "The receipt names a file outside codex-on-crack's paths.", 'Nothing was restored.');
    }
    const current = readIfExists(entry.path);
    if (sha256(current) !== entry.after_hash) {
      throw new CrackError('edited_since', `Refusing undo: ${entry.path} changed after setup wrote it.`,
        'Preserve or reconcile those edits first.');
    }
    let before = null;
    if (entry.before_file !== null) {
      if (typeof entry.before_file !== 'string' || path.basename(entry.before_file) !== entry.before_file) {
        throw new CrackError('receipt_invalid', 'Invalid backup filename in receipt.', 'Nothing was restored.');
      }
      before = readIfExists(path.join(path.dirname(resolved), entry.before_file));
    }
    if (sha256(before) !== entry.before_hash) {
      throw new CrackError('backup_mismatch', 'A backup no longer matches its receipt.', 'Nothing was restored.');
    }
    return { path: entry.path, before, current, currentMode: current === null ? 0o600 : fs.statSync(entry.path).mode & 0o777, mode: entry.mode, action: before === null ? 'remove' : 'restore' };
  });
  if (apply) {
    const done = [];
    try {
      for (const item of pending) {
        if (item.before === null) fs.rmSync(item.path, { force: true });
        else atomicWrite(item.path, item.before, item.mode);
        done.push(item);
      }
    } catch (error) {
      for (const item of done.reverse()) {
        if (item.current === null) fs.rmSync(item.path, { force: true });
        else atomicWrite(item.path, item.current, item.currentMode);
      }
      throw error;
    }
    record.operation_seq = nextSequence(codexHome);
    record.status = 'restored';
    atomicWrite(resolved, `${JSON.stringify(record, null, 2)}\n`);
  }
  return { actions: pending.map((item) => ({ action: item.action, path: item.path })), applied: apply };
}

export const LEGACY_BEGIN = '<!-- BEGIN astra-flash-orchestrator managed policy -->';
export const LEGACY_END = '<!-- END astra-flash-orchestrator managed policy -->';
export function removeBlock(text, begin, end) {
  if (!text.includes(begin) && !text.includes(end)) return text;
  if (text.split(begin).length !== 2 || text.split(end).length !== 2 || text.indexOf(end) < text.indexOf(begin)) {
    throw malformed('The managed policy markers are malformed.');
  }
  const start = text.indexOf(begin);
  let finish = text.indexOf(end) + end.length;
  if (text.slice(finish, finish + 2) === '\r\n') finish += 2;
  else if (text[finish] === '\n') finish++;
  return text.slice(0, start) + text.slice(finish);
}
export function policyMigration(codexHome, requested, { policy = false, migrateLegacy = false } = {}) {
  const files = managedPaths(codexHome).policy;
  const texts = files.map((f) => readIfExists(f)?.toString('utf8') ?? '');
  const legacy = texts.some((t) => t.includes(LEGACY_BEGIN) || t.includes(LEGACY_END));
  if (legacy && !migrateLegacy) throw new CrackError('legacy_policy_active', 'The old Astra/Flash managed policy is still active.',
    'Preview with --migrate-legacy to back up and remove only its managed block. Old roles/skills remain untouched.');
  const target = texts[1].trim() ? 1 : 0;
  texts.forEach((original, index) => {
    let text = migrateLegacy ? removeBlock(original, LEGACY_BEGIN, LEGACY_END) : original;
    if (policy) text = index === target ? managedPolicy(text, policyBlock()) : removeBlock(text, POLICY_BEGIN, POLICY_END);
    if (text !== original) requested.set(files[index], text);
  });
}
