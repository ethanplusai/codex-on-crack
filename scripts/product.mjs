#!/usr/bin/env node
// Install, inspect, and uninstall this package in an isolated Codex home.
//
// Deliberately narrow beta scope:
//   - the target home must be fresh (absent or empty of files) or already
//     receipted by this product;
//   - every path this product touches must be inside a strict, mode-specific
//     owned namespace, with no symlinked component;
//   - an intact install of the same package manifest is idempotent and writes
//     nothing; a different version is refused rather than upgraded in place;
//   - modified, missing, or extra files stop install and uninstall instead of
//     guessing, and there is no --force.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inventory } from './release.mjs';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ID = 'codex-on-crack@codex-on-crack';
const PLUGIN_NAME = 'codex-on-crack';
const MARKETPLACE_NAME = 'codex-on-crack';
const RECEIPT_NAME = 'codex-on-crack-receipt.json';
const TRANSACTION_NAME = 'codex-on-crack-transaction.json';
const RECEIPT_VERSION = 3;
const PLUGIN_SOURCE = path.join(PACKAGE_ROOT, 'plugins', PLUGIN_NAME);
const SOURCE_PREFIX = `plugins/${PLUGIN_NAME}/`;
const CACHE_ROOT = `plugins/cache/${MARKETPLACE_NAME}/${PLUGIN_NAME}`;
const MARKETPLACE_REL = '.agents/plugins/marketplace.json';
const CONFIG_REL = 'config.toml';
const SHA256_RE = /^[0-9a-f]{64}$/;

const USAGE = [
  'Usage:',
  '  product.mjs install   --home <dir> [--via cli|source] [--dry-run] [--allow-main-home --yes]',
  '  product.mjs doctor    [--home <dir>]',
  '  product.mjs uninstall --home <dir> [--dry-run]',
  '',
  'Installs into a fresh (absent or empty) isolated home, or verifies an intact',
  'existing install. The main Codex home is refused unless --allow-main-home --yes',
  'is given explicitly.',
].join('\n');

class Refused extends Error {
  constructor(code, message, hint = null, extra = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.extra = extra;
  }
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const real = (value) => {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
};

// ---------------------------------------------------------------- paths

function canonicalHome(value, label = 'install') {
  if (typeof value !== 'string' || !value.trim()) throw new Refused('home_required', `--home is required for ${label}.`, 'Pass an absolute path to an isolated Codex home.');
  if (value.split(/[\\/]/).includes('..')) throw new Refused('unsafe_target', `--home must not contain "..": ${value}`, 'Pass a normalized absolute path.');
  if (!path.isAbsolute(value)) throw new Refused('unsafe_target', `--home must be an absolute path: ${value}`, 'Pass an absolute path.');
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new Refused('unsafe_target', '--home must not be the filesystem root.', 'Pass an isolated directory.');
  let stat = null;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (stat?.isSymbolicLink()) throw new Refused('unsafe_target', `--home is a symlink: ${resolved}`, 'Pass the real directory, or a new one.');
  if (stat && !stat.isDirectory()) throw new Refused('unsafe_target', `--home is not a directory: ${resolved}`, 'Pass an isolated directory.');
  let current = resolved;
  const tail = [];
  for (;;) {
    try {
      const root = fs.realpathSync(current);
      return tail.length === 0 ? root : path.join(root, ...tail);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw new Refused('unsafe_target', `--home cannot be resolved: ${resolved}`, 'Pass an existing absolute path.');
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function protectedHomes() {
  const homes = new Set([real(path.join(os.homedir(), '.codex'))]);
  if (typeof process.env.CODEX_HOME === 'string' && process.env.CODEX_HOME.trim()) {
    homes.add(real(path.resolve(process.env.CODEX_HOME.trim())));
  }
  return homes;
}

// Walk every component of `rel` under `home`; refuse a symlink anywhere, and
// return the concrete path. This is what stops a symlinked config.toml,
// .agents/, cache entry, or receipt from redirecting a read or write.
function ownedPath(home, rel, mode) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
    throw new Refused('receipt_invalid', `Refusing a path that is not relative: ${JSON.stringify(rel)}`, 'Reinstall into a fresh home.');
  }
  const normalized = rel.split(path.sep).join('/');
  const allowed = mode === 'source'
    ? normalized === MARKETPLACE_REL || normalized.startsWith(SOURCE_PREFIX)
    : normalized === CONFIG_REL || normalized.startsWith(`${CACHE_ROOT}/`);
  if (!allowed) {
    throw new Refused('receipt_invalid', `Refusing a path outside this install's own namespace: ${normalized}`, 'Reinstall into a fresh home.');
  }
  let current = path.resolve(home);
  let checking = true;
  for (const segment of normalized.split('/')) {
    current = path.join(current, segment);
    // Keep building the full path even after a component is missing; only the
    // existence check stops. Returning a truncated path here would let a write
    // land on a parent directory.
    if (!checking) continue;
    let stat = null;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') {
        checking = false;
        continue;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Refused('unsafe_target', `Refusing to follow a symlink inside the home: ${current}`, 'Remove the symlink, then retry.');
    }
  }
  return current;
}

// Paths the install itself will touch, before it touches them.
function assertInstallPathsSafe(home, mode) {
  const needed = mode === 'source'
    ? ['plugins', `plugins/${PLUGIN_NAME}`, '.agents', '.agents/plugins', MARKETPLACE_REL]
    : [CONFIG_REL, '.tmp', 'tmp', 'plugins', 'plugins/cache', CACHE_ROOT];
  for (const rel of needed) {
    let current = path.resolve(home);
    for (const segment of rel.split('/')) {
      current = path.join(current, segment);
      let stat = null;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if (error.code === 'ENOENT') break;
        throw error;
      }
      if (stat.isSymbolicLink()) {
        throw new Refused('unsafe_target', `Refusing to install through a symlink: ${current}`, 'Remove the symlink, or use a fresh home.');
      }
      if (!stat.isDirectory() && current !== path.join(home, rel)) {
        throw new Refused('unsafe_target', `Refusing to install through a non-directory: ${current}`, 'Use a fresh home.');
      }
    }
  }
}

// A fresh target is absent, or contains no files at all.
function assertAbsentOrEmpty(home) {
  if (!fs.existsSync(home)) return;
  const visit = (dir, depth) => {
    if (depth > 8) throw new Refused('home_not_empty', `Refusing a home nested deeper than expected: ${dir}`, 'Use a fresh empty directory.');
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Refused('unsafe_target', `Refusing a symlink in a fresh home: ${full}`, 'Remove it, or use a fresh home.');
      if (entry.isDirectory()) visit(full, depth + 1);
      else throw new Refused('home_not_empty', `Refusing a home that already contains ${path.relative(home, full)}.`, 'Use a fresh empty directory; this beta does not adopt an existing home.');
    }
  };
  visit(home, 0);
}

// ---------------------------------------------------------------- package

function packageState() {
  const file = path.join(PACKAGE_ROOT, 'MANIFEST.sha256');
  const versionFile = path.join(PACKAGE_ROOT, 'VERSION');
  if (!fs.existsSync(file)) throw new Refused('manifest_missing', 'MANIFEST.sha256 is missing from this package.', 'Re-extract the archive.');
  const expected = fs.readFileSync(file, 'utf8');
  if (expected !== inventory(PACKAGE_ROOT)) {
    throw new Refused('manifest_invalid', 'MANIFEST.sha256 does not match the files in this package.', 'Rebuild the release inventory, then retry.');
  }
  const version = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : null;
  if (typeof version !== 'string' || !version) throw new Refused('manifest_invalid', 'VERSION is missing from this package.', 'Re-extract the archive.');
  return { manifestSha256: sha256(expected), version };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeNewFile(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // 'wx' refuses an existing path, so a symlink or stale file can never be
  // followed or overwritten by accident.
  const fd = fs.openSync(file, 'wx', mode);
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

function walkFiles(root, { refuseSymlinks = true } = {}) {
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (refuseSymlinks) throw new Refused('unsafe_target', `Refusing to walk a symlink: ${full}`, 'Remove the symlink, then retry.');
        continue;
      }
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  if (fs.existsSync(root)) visit(root);
  return out;
}

function codexBinary() {
  const found = spawnSync('sh', ['-c', 'command -v codex'], { encoding: 'utf8' }).stdout.trim();
  return found && fs.existsSync(found) ? found : null;
}

function runCodex(binary, home, args) {
  return spawnSync(binary, args, { encoding: 'utf8', env: { ...process.env, CODEX_HOME: home }, timeout: 120_000 });
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// The live CLI view of our own plugin: identity, version, and the marketplace
// mapping it came from. A remapped or unknown source is never treated as ours.
function registryState(binary, home) {
  if (binary === null) return null;
  const listed = runCodex(binary, home, ['plugin', 'list', '--json']);
  const parsed = parseJson(listed.stdout);
  if (parsed === null || !Array.isArray(parsed.installed)) return null;
  const entry = parsed.installed.find((item) => item?.pluginId === PLUGIN_ID);
  if (!entry) return { pluginId: null };
  return {
    pluginId: entry.pluginId ?? null,
    name: entry.name ?? null,
    version: entry.version ?? null,
    enabled: entry.enabled ?? null,
    marketplaceName: entry.marketplaceName ?? null,
    marketplaceSourceType: entry.marketplaceSource?.sourceType ?? null,
    marketplaceSource: entry.marketplaceSource?.source ?? null,
  };
}

function registryMatches(recorded, current) {
  if (!recorded || !current) return false;
  return current.pluginId === recorded.pluginId
    && (current.version ?? null) === (recorded.version ?? null)
    && (current.marketplaceName ?? null) === (recorded.marketplaceName ?? null)
    && (current.marketplaceSourceType ?? null) === (recorded.marketplaceSourceType ?? null)
    && (current.marketplaceSource ?? null) === (recorded.marketplaceSource ?? null);
}

// ---------------------------------------------------------------- receipt

const receiptPath = (home) => path.join(home, RECEIPT_NAME);
const transactionPath = (home) => path.join(home, TRANSACTION_NAME);

function readOwnJsonDocument(file, code, hint) {
  let stat = null;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Refused('unsafe_target', `Refusing a symlinked document: ${file}`, 'Remove the symlink, then retry.');
  if (!stat.isFile()) throw new Refused(code, `${file} is not a regular file.`, hint);
  const parsed = readJson(file);
  if (parsed === null) throw new Refused(code, `${file} is not valid JSON.`, hint);
  return parsed;
}

function loadReceipt(home) {
  const file = receiptPath(home);
  const receipt = readOwnJsonDocument(file, 'receipt_invalid', 'Move it aside, or install into a fresh home.');
  if (receipt === null) return null;
  if (receipt.schemaVersion !== RECEIPT_VERSION || receipt.product !== PLUGIN_NAME || !['cli', 'source'].includes(receipt.mode)) {
    throw new Refused('receipt_invalid', `${file} is not a receipt written by this version of the product.`, 'Uninstall with the version that wrote it, or use a fresh home.');
  }
  if (typeof receipt.packageVersion !== 'string' || !receipt.packageVersion) throw new Refused('receipt_invalid', `${file} has no package version.`, 'Reinstall into a fresh home.');
  if (typeof receipt.manifestSha256 !== 'string' || !SHA256_RE.test(receipt.manifestSha256)) throw new Refused('receipt_invalid', `${file} has no valid manifest hash.`, 'Reinstall into a fresh home.');
  if (typeof receipt.files !== 'object' || receipt.files === null || Object.keys(receipt.files).length === 0) {
    throw new Refused('receipt_invalid', `${file} lists no owned files.`, 'Reinstall into a fresh home.');
  }
  for (const [rel, hash] of Object.entries(receipt.files)) {
    ownedPath(home, rel, receipt.mode);
    if (typeof hash !== 'string' || !SHA256_RE.test(hash)) {
      throw new Refused('receipt_invalid', `${file} has an invalid hash for ${rel}.`, 'Reinstall into a fresh home.');
    }
  }
  if (receipt.mode === 'source') {
    if (typeof receipt.marketplace?.path !== 'string' || typeof receipt.marketplace?.hash !== 'string' || !SHA256_RE.test(receipt.marketplace.hash)) {
      throw new Refused('receipt_invalid', `${file} has no valid marketplace record.`, 'Reinstall into a fresh home.');
    }
    if (path.relative(home, receipt.marketplace.path) !== MARKETPLACE_REL) {
      throw new Refused('receipt_invalid', `${file} names an unexpected marketplace path.`, 'Reinstall into a fresh home.');
    }
    ownedPath(home, MARKETPLACE_REL, 'source');
  } else {
    if (typeof receipt.cli?.version !== 'string' || !receipt.cli.version) throw new Refused('receipt_invalid', `${file} has no recorded plugin version.`, 'Reinstall into a fresh home.');
    const expectedCache = path.join(home, CACHE_ROOT, receipt.cli.version);
    if (typeof receipt.cli.cacheDir !== 'string' || path.resolve(receipt.cli.cacheDir) !== path.resolve(expectedCache)) {
      throw new Refused('receipt_invalid', `${file} names a cache directory that is not this plugin and version.`, 'Reinstall into a fresh home.');
    }
    for (const rel of Object.keys(receipt.files)) {
      if (!rel.startsWith(`${CACHE_ROOT}/${receipt.cli.version}/`)) {
        throw new Refused('receipt_invalid', `${file} lists a file outside this plugin and version: ${rel}`, 'Reinstall into a fresh home.');
      }
    }
    if (receipt.cli.registry?.pluginId !== PLUGIN_ID || typeof receipt.cli.registry?.marketplaceSource !== 'string') {
      throw new Refused('receipt_invalid', `${file} has no verified registry mapping.`, 'Reinstall into a fresh home.');
    }
  }
  return receipt;
}

function loadTransaction(home) {
  return readOwnJsonDocument(transactionPath(home), 'transaction_invalid', 'Inspect it yourself, then remove it.');
}

function inspectInstall(home, receipt) {
  const modified = [];
  const missing = [];
  for (const [rel, expected] of Object.entries(receipt.files)) {
    const file = ownedPath(home, rel, receipt.mode);
    if (!fs.existsSync(file)) {
      missing.push(rel);
      continue;
    }
    if (sha256(fs.readFileSync(file)) !== expected) modified.push(rel);
  }
  const extra = [];
  if (receipt.mode === 'source') {
    const root = path.join(home, SOURCE_PREFIX.replace(/\/$/, ''));
    for (const file of walkFiles(root)) {
      const rel = path.relative(home, file);
      if (!(rel in receipt.files)) extra.push(rel);
    }
    const marketplace = ownedPath(home, MARKETPLACE_REL, 'source');
    if (!fs.existsSync(marketplace)) missing.push(MARKETPLACE_REL);
    else if (sha256(fs.readFileSync(marketplace)) !== receipt.marketplace.hash) modified.push(MARKETPLACE_REL);
  } else {
    if (!fs.existsSync(receipt.cli.cacheDir)) {
      missing.push(path.relative(home, receipt.cli.cacheDir));
    } else {
      for (const file of walkFiles(receipt.cli.cacheDir)) {
        const rel = path.relative(home, file);
        if (!(rel in receipt.files)) extra.push(rel);
      }
    }
  }
  return {
    modified: [...new Set(modified)].sort(),
    missing: [...new Set(missing)].sort(),
    extra: [...new Set(extra)].sort(),
    intact: modified.length === 0 && missing.length === 0 && extra.length === 0,
  };
}

function rememberTransaction(home, record) {
  const file = transactionPath(home);
  try {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    writeNewFile(file, `${JSON.stringify({ schemaVersion: 1, product: PLUGIN_NAME, at: new Date().toISOString(), ...record }, null, 2)}\n`);
    return file;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- install

function planSourceFiles() {
  return walkFiles(PLUGIN_SOURCE).map((full) => ({
    from: full,
    rel: `${SOURCE_PREFIX}${path.relative(PLUGIN_SOURCE, full).split(path.sep).join('/')}`,
  }));
}

function installSource(home) {
  const created = [];
  try {
    for (const file of planSourceFiles()) {
      const target = ownedPath(home, file.rel, 'source');
      if (fs.existsSync(target)) throw new Refused('home_not_empty', `Refusing to overwrite ${file.rel}.`, 'Use a fresh empty home.');
      writeNewFile(target, fs.readFileSync(file.from), 0o644);
      created.push(file.rel);
    }
    const marketplace = ownedPath(home, MARKETPLACE_REL, 'source');
    if (fs.existsSync(marketplace)) throw new Refused('home_not_empty', `Refusing to adopt an existing ${MARKETPLACE_REL}.`, 'Use a fresh empty home.');
    const doc = {
      name: MARKETPLACE_NAME,
      interface: { displayName: 'Codex on Crack' },
      plugins: [{
        name: PLUGIN_NAME,
        source: { source: 'local', path: `./plugins/${PLUGIN_NAME}` },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Developer Tools',
      }],
    };
    writeNewFile(marketplace, `${JSON.stringify(doc, null, 2)}\n`, 0o644);
    created.push(MARKETPLACE_REL);
    const files = {};
    for (const rel of created) {
      if (rel === MARKETPLACE_REL) continue;
      files[rel] = sha256(fs.readFileSync(path.join(home, rel)));
    }
    return {
      files,
      marketplace: { path: marketplace, hash: sha256(fs.readFileSync(marketplace)) },
      installedPath: path.join(home, SOURCE_PREFIX.replace(/\/$/, '')),
    };
  } catch (error) {
    for (const rel of [...created].reverse()) {
      try {
        fs.rmSync(path.join(home, rel), { force: true });
      } catch {
        // best effort: the error below reports the failure
      }
    }
    pruneEmptyTree(path.join(home, 'plugins'));
    pruneEmptyTree(path.join(home, '.agents', 'plugins'));
    if (error instanceof Refused) throw new Refused(error.code, error.message, error.hint, { rolledBack: true });
    throw error;
  }
}

function installCli(home, binary) {
  const before = {
    configExisted: fs.existsSync(path.join(home, CONFIG_REL)),
    tmpExisted: fs.existsSync(path.join(home, '.tmp')),
    stagingExisted: fs.existsSync(path.join(home, 'tmp')),
  };
  const steps = [];
  const added = runCodex(binary, home, ['plugin', 'marketplace', 'add', PACKAGE_ROOT, '--json']);
  steps.push({ step: 'marketplace add', status: added.status === 0 ? 'ok' : 'failed' });
  if (added.status !== 0) {
    rememberTransaction(home, {
      status: 'failed', failedStep: 'marketplace add', steps,
      guidance: 'The CLI reported a failure while registering the marketplace. Inspect it, then remove the home or retry.',
    });
    throw new Refused('marketplace_add_failed', `codex plugin marketplace add failed: ${(added.stderr || added.stdout).trim().slice(0, 400)}`, 'Inspect the CLI output and the transaction record in the home.');
  }
  const installed = runCodex(binary, home, ['plugin', 'add', PLUGIN_ID, '--json']);
  steps.push({ step: 'plugin add', status: installed.status === 0 ? 'ok' : 'failed' });
  if (installed.status !== 0) {
    const undone = runCodex(binary, home, ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME, '--json']);
    const rolledBack = undone.status === 0;
    steps.push({ step: 'marketplace remove (rollback)', status: rolledBack ? 'ok' : 'failed' });
    if (!rolledBack) {
      rememberTransaction(home, {
        status: 'rollback_failed', failedStep: 'plugin add', steps,
        guidance: 'The plugin failed to install and the marketplace registration could not be removed. Inspect the home and the CLI.',
      });
    }
    throw new Refused('plugin_add_failed',
      `codex plugin add failed: ${(installed.stderr || installed.stdout).trim().slice(0, 400)}`,
      rolledBack ? 'The marketplace registration was rolled back; retry when the CLI is healthy.' : 'Registration rollback failed; inspect the transaction record in the home.',
      { rolledBack });
  }
  const addJson = parseJson(installed.stdout) ?? {};
  const version = typeof addJson.version === 'string' && addJson.version ? addJson.version : null;
  const registry = registryState(binary, home);
  const fail = (code, message, hint) => {
    rememberTransaction(home, {
      status: 'unverified', failedStep: version === null ? 'plugin add (version)' : 'registry verify', steps,
      cacheDir: typeof addJson.installedPath === 'string' ? addJson.installedPath : null,
      guidance: 'The CLI installed something this tool could not verify. Nothing was deleted. Inspect the home, then remove it or finish the install manually.',
    });
    throw new Refused(code, message, hint);
  };
  if (version === null) fail('cache_unexpected_layout', 'The CLI did not report a plugin version.', 'Inspect the CLI output and the transaction record in the home.');
  const expectedCache = path.join(home, CACHE_ROOT, version);
  if (typeof addJson.installedPath !== 'string' || path.resolve(addJson.installedPath) !== path.resolve(expectedCache)) {
    fail('cache_unexpected_layout', `The CLI installed outside this plugin's own cache path (${addJson.installedPath ?? 'unknown'}).`, 'Inspect the CLI output; this beta will not adopt an unexpected layout.');
  }
  if (!registry || registry.pluginId !== PLUGIN_ID || registry.version !== version
    || registry.marketplaceSourceType !== 'local' || registry.marketplaceSource !== PACKAGE_ROOT) {
    fail('registry_unverified', 'The CLI did not report this plugin with the expected marketplace mapping.', 'Inspect the CLI output and the transaction record in the home.');
  }
  // Hash only the verified cache path.
  const files = {};
  for (const file of walkFiles(expectedCache)) {
    files[path.relative(home, file).split(path.sep).join('/')] = sha256(fs.readFileSync(file));
  }
  if (Object.keys(files).length === 0) fail('cache_unexpected_layout', 'The CLI reported success but its cache directory is empty.', 'Inspect the CLI output; this beta will not record an empty install.');
  return { addJson, marketplaceJson: parseJson(added.stdout) ?? {}, cacheDir: expectedCache, version, registry, before, files };
}

function install(values) {
  const home = canonicalHome(values.home, 'install');
  const state = packageState();
  const via = values.via ?? (codexBinary() === null ? 'source' : 'cli');
  if (!['cli', 'source'].includes(via)) throw new Refused('usage', '--via must be cli or source.', USAGE);
  const binary = codexBinary();
  if (protectedHomes().has(real(home)) && !(values['allow-main-home'] === true && values.yes === true)) {
    throw new Refused('main_home_refused',
      '--home resolves to the main Codex home (the real ~/.codex or the active CODEX_HOME).',
      'Use an isolated directory, or pass --allow-main-home --yes if you really mean the main profile.');
  }
  // Nothing is written before this point: home shape, symlinks, transaction
  // state, receipt integrity, and the existing install are all verified first.
  const transaction = loadTransaction(home);
  if (transaction !== null) {
    throw new Refused('transaction_pending',
      `An earlier install left a transaction record (${transaction.status ?? 'unknown'}).`,
      'Inspect the record and isolated home manually; automatic removal refuses unverified state.');
  }
  const existing = loadReceipt(home);
  if (existing !== null) {
    if (existing.mode !== via) throw new Refused('mode_conflict', `This home was installed with --via ${existing.mode}; refusing to switch to ${via}.`, 'Uninstall first, then install again.');
    const inspected = inspectInstall(home, existing);
    if (!inspected.intact) throw new Refused('install_state_changed', 'The installed files no longer match the receipt.', 'Uninstall first, or use a fresh home.');
    if (existing.mode === 'cli' && !registryMatches(existing.cli.registry, registryState(binary, home))) {
      throw new Refused('install_state_changed', 'The CLI registration no longer matches the receipt.', 'Uninstall first, or use a fresh home.');
    }
    if (existing.manifestSha256 === state.manifestSha256 && existing.packageVersion === state.version) {
      // Same manifest, intact state: idempotent, and nothing at all is written.
      return { ok: true, status: 'unchanged', mode: via, hostLoaded: via === 'cli', home, installedPath: existing.mode === 'cli' ? existing.cli.cacheDir : path.join(home, SOURCE_PREFIX.replace(/\/$/, '')), files: Object.keys(existing.files).length, receipt: receiptPath(home), wrote: false };
    }
    throw new Refused('upgrade_requires_fresh_home',
      `This home holds ${existing.packageVersion}; this package is ${state.version}.`,
      'Uninstall and reinstall into a fresh home; in-place upgrades are intentionally not supported.');
  }
  if (fs.existsSync(home)) {
    assertAbsentOrEmpty(home);
    assertInstallPathsSafe(home, via);
  }
  if (values['dry-run'] === true) {
    const actions = via === 'source'
      ? [`copy ${planSourceFiles().length} files to ${path.join(home, `plugins/${PLUGIN_NAME}`)}`, `write ${path.join(home, MARKETPLACE_REL)}`, `write ${receiptPath(home)}`]
      : [`CODEX_HOME=${home} codex plugin marketplace add ${PACKAGE_ROOT} --json`, `CODEX_HOME=${home} codex plugin add ${PLUGIN_ID} --json`, `verify ${path.join(home, CACHE_ROOT)}`, `write ${receiptPath(home)}`];
    return { ok: true, status: 'dry-run', mode: via, home, actions, wrote: false };
  }
  if (via === 'cli' && binary === null) throw new Refused('codex_missing', 'No codex binary was found on PATH.', 'Use --via source, or install the Codex CLI.');

  const homeExistedBefore = fs.existsSync(home);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const result = via === 'cli' ? installCli(home, binary) : installSource(home);
  const receipt = {
    schemaVersion: RECEIPT_VERSION,
    product: PLUGIN_NAME,
    pluginId: PLUGIN_ID,
    marketplaceName: MARKETPLACE_NAME,
    mode: via,
    hostLoaded: via === 'cli',
    homeExisted: homeExistedBefore,
    packageRoot: PACKAGE_ROOT,
    packageVersion: state.version,
    manifestSha256: state.manifestSha256,
    createdAt: new Date().toISOString(),
    files: result.files,
    marketplace: via === 'source' ? { path: result.marketplace.path, hash: result.marketplace.hash } : null,
    cli: via === 'cli'
      ? { cacheDir: result.cacheDir, version: result.version, registry: result.registry, marketplace: result.marketplaceJson, plugin: result.addJson, before: result.before }
      : null,
  };
  writeNewFile(receiptPath(home), `${JSON.stringify(receipt, null, 2)}\n`);
  return {
    ok: true,
    status: 'installed',
    mode: via,
    hostLoaded: via === 'cli',
    home,
    installedPath: result.installedPath ?? result.cacheDir,
    files: Object.keys(result.files).length,
    receipt: receiptPath(home),
    pluginId: PLUGIN_ID,
    wrote: true,
  };
}

// ---------------------------------------------------------------- doctor

function doctor(values) {
  const home = values.home === undefined ? null : canonicalHome(values.home, 'doctor');
  let manifestValid = false;
  let manifestError = null;
  let packageInfo = null;
  try {
    packageInfo = packageState();
    manifestValid = true;
  } catch (error) {
    manifestError = error.message;
  }
  const binary = codexBinary();
  const version = binary === null ? null : (spawnSync(binary, ['--version'], { encoding: 'utf8' }).stdout ?? '').trim() || null;
  const claude = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout.trim() || null;

  const problems = [];
  let install;
  let transaction = null;
  let receiptError = null;
  if (home !== null) {
    try {
      transaction = loadTransaction(home);
    } catch (error) {
      receiptError = error instanceof Refused ? error.code : 'transaction_invalid';
    }
  }
  if (home === null) {
    install = { installed: false, mode: null, hostLoaded: false, home: null, note: 'Pass --home to inspect an installation.' };
  } else if (receiptError !== null) {
    problems.push({ code: receiptError, message: 'The receipt or transaction record in this home is not usable.' });
    install = { installed: false, mode: null, hostLoaded: false, home, receipt: receiptPath(home), problems: [receiptError] };
  } else if (transaction !== null) {
    problems.push({ code: 'transaction_pending', message: `An earlier install left a transaction record (${transaction.status ?? 'unknown'}).` });
    install = {
      installed: false, mode: transaction.mode ?? null, hostLoaded: false, home, receipt: receiptPath(home),
      transaction: { status: transaction.status ?? null, failedStep: transaction.failedStep ?? null, guidance: typeof transaction.guidance === 'string' ? transaction.guidance : null },
      problems: ['transaction_pending'],
    };
  } else {
    let receipt = null;
    try {
      receipt = loadReceipt(home);
    } catch (error) {
      receiptError = error instanceof Refused ? error.code : 'receipt_invalid';
    }
    if (receiptError !== null) {
      problems.push({ code: receiptError, message: 'The receipt in this home is not usable.' });
      install = { installed: false, mode: null, hostLoaded: false, home, receipt: receiptPath(home), problems: [receiptError] };
    } else if (receipt === null) {
      install = { installed: false, mode: null, hostLoaded: false, home, receipt: receiptPath(home) };
    } else {
      const inspected = inspectInstall(home, receipt);
      const registry = receipt.mode === 'cli' ? registryState(binary, home) : null;
      const registryOk = receipt.mode !== 'cli' || registryMatches(receipt.cli.registry, registry);
      const installed = inspected.intact && registryOk;
      if (!inspected.intact) problems.push({ code: 'install_state_changed', message: `Files differ from the receipt: ${inspected.modified.length + inspected.missing.length + inspected.extra.length} path(s).` });
      if (!registryOk) problems.push({ code: 'registry_changed', message: 'The CLI no longer reports this plugin with the recorded marketplace mapping.' });
      install = {
        installed,
        mode: receipt.mode,
        hostLoaded: receipt.hostLoaded === true,
        home,
        receipt: receiptPath(home),
        packageVersion: receipt.packageVersion,
        installedPath: receipt.mode === 'cli' ? receipt.cli.cacheDir : path.join(home, SOURCE_PREFIX.replace(/\/$/, '')),
        version: receipt.cli?.version ?? null,
        registry: receipt.mode === 'cli' ? registry : null,
        modified: inspected.modified,
        missing: inspected.missing,
        extra: inspected.extra,
        evidence: receipt.hostLoaded
          ? 'The supported plugin CLI reported the install; this is host-loaded evidence.'
          : 'Files were copied into the home; this is a static source install, not proof the host loaded them.',
      };
    }
  }

  return {
    ok: manifestValid && problems.length === 0,
    status: !manifestValid ? 'package-invalid' : receiptError !== null ? 'receipt-invalid' : transaction !== null ? 'incomplete-install' : install.installed ? 'installed' : home === null ? 'package-ok' : 'not-installed',
    package: { root: PACKAGE_ROOT, manifestValid, manifestError, version: packageInfo?.version ?? null },
    install,
    problems,
    dependencies: [
      { name: 'node', status: Number(process.versions.node.split('.')[0]) >= 20 ? 'available' : 'unavailable', detail: `Node ${process.versions.node}; 20+ required` },
      { name: 'codex', status: binary === null ? 'unavailable' : 'available-unverified', detail: binary === null ? 'Not found on PATH; install with --via source instead.' : `Found at ${binary}${version ? ` (${version})` : ''}` },
      { name: 'claude', status: claude === null ? 'unavailable' : 'available-unverified', detail: claude === null ? 'Optional: only needed for the external Claude mode.' : 'Found. Login state is only observable from a real run.' },
    ],
    providerFacts: {
      catalog: home === null ? 'unknown' : (fs.existsSync(path.join(home, 'catalog.json')) ? 'present' : 'absent'),
      config: home === null ? 'unknown' : (fs.existsSync(path.join(home, CONFIG_REL)) ? 'present' : 'absent'),
      note: 'Catalog presence is not provider access. Live routing and account quota stay unknown here.',
    },
    unknown: [
      'Whether the desktop app or CLI will load the plugin in a fresh session',
      'Live provider routing, serving identity, and account quota',
      'Whether a configured worker role is currently reachable',
    ],
    runtime_verified: false,
    model_calls_made: false,
  };
}

// ---------------------------------------------------------------- uninstall

function pruneEmptyTree(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) pruneEmptyTree(path.join(dir, entry.name));
  }
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // keep anything non-empty
  }
}

function uninstall(values) {
  const home = canonicalHome(values.home, 'uninstall');
  const transaction = loadTransaction(home);
  const receipt = loadReceipt(home);
  if (receipt === null && transaction === null) return { ok: true, status: 'nothing-installed', home, removed: [], kept: [] };
  if (transaction !== null) {
    throw new Refused('transaction_unverified',
      'The incomplete installation has no verified ownership record for automatic removal.',
      'Inspect codex-on-crack-transaction.json and the isolated home manually. All files are preserved.');
  }

  const binary = codexBinary();
  const inspected = inspectInstall(home, receipt);
  const changed = [...inspected.modified, ...inspected.missing, ...inspected.extra];
  if (changed.length) {
    throw new Refused('install_state_changed', `Refusing to uninstall: ${changed.length} path(s) differ from the receipt.`, 'Inspect the home and remove it yourself.', { changed });
  }
  if (receipt.mode === 'cli') {
    const current = registryState(binary, home);
    if (!registryMatches(receipt.cli.registry, current)) {
      throw new Refused('registry_remapped', 'The CLI now reports a different plugin or marketplace mapping for this id.', 'Inspect the home and remove it yourself; this beta will not unregister an unknown owner.');
    }
  }
  const actions = receipt.mode === 'cli'
    ? [`CODEX_HOME=${home} codex plugin remove ${PLUGIN_ID} --json`, `CODEX_HOME=${home} codex plugin marketplace remove ${MARKETPLACE_NAME} --json`, `remove ${receiptPath(home)}`]
    : [`remove ${Object.keys(receipt.files).length} files`, `remove ${MARKETPLACE_REL}`, `remove ${receiptPath(home)}`];
  if (values['dry-run'] === true) return { ok: true, status: 'dry-run', home, mode: receipt.mode, actions, wrote: false };
  if (receipt.mode === 'cli' && binary === null) throw new Refused('codex_missing', 'The codex binary is gone; refusing to guess at cache removal.', 'Remove the cache and config entries yourself.');

  const removed = [];
  if (receipt.mode === 'cli') {
    for (const args of [['plugin', 'remove', PLUGIN_ID, '--json'], ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME, '--json']]) {
      const result = runCodex(binary, home, args);
      if (result.status !== 0 && !/not (?:installed|found)|no such/i.test(`${result.stderr}${result.stdout}`)) {
        throw new Refused('cli_remove_failed', `codex ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`, 'Inspect the CLI output, then retry.');
      }
    }
    if (fs.existsSync(receipt.cli.cacheDir)) {
      throw new Refused('cache_left_behind', 'The CLI reported success but the cache directory is still present.', 'Inspect the home; this beta will not delete it unverified.');
    }
  }
  for (const rel of Object.keys(receipt.files)) {
    const file = ownedPath(home, rel, receipt.mode);
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      removed.push(rel);
    }
  }
  if (receipt.mode === 'source') {
    const marketplace = ownedPath(home, MARKETPLACE_REL, 'source');
    if (fs.existsSync(marketplace) && sha256(fs.readFileSync(marketplace)) === receipt.marketplace.hash) {
      fs.rmSync(marketplace, { force: true });
      removed.push(MARKETPLACE_REL);
    }
    pruneEmptyTree(path.join(home, SOURCE_PREFIX.replace(/\/$/, '')));
    pruneEmptyTree(path.join(home, 'plugins'));
    pruneEmptyTree(path.join(home, '.agents', 'plugins'));
    pruneEmptyTree(path.join(home, '.agents'));
  }
  fs.rmSync(receiptPath(home), { force: true });
  if (receipt.mode === 'cli') {
    const before = receipt.cli.before ?? {};
    pruneEmptyTree(path.join(home, 'plugins', 'cache'));
    pruneEmptyTree(path.join(home, 'plugins'));
    if (before.tmpExisted !== true) pruneEmptyTree(path.join(home, '.tmp'));
    if (before.stagingExisted !== true) pruneEmptyTree(path.join(home, 'tmp'));
    const configFile = ownedPath(home, CONFIG_REL, 'cli');
    if (before.configExisted !== true && fs.existsSync(configFile) && fs.readFileSync(configFile, 'utf8').trim() === '') {
      fs.rmSync(configFile, { force: true });
    }
  }
  if (receipt.homeExisted !== true) {
    try {
      if (fs.readdirSync(home).length === 0) fs.rmdirSync(home);
    } catch {
      // keep a non-empty or already-removed home
    }
  }
  return { ok: true, status: 'uninstalled', home, mode: receipt.mode, removed, kept: [] };
}

// ---------------------------------------------------------------- cli

function parse(argv) {
  const [command, ...rest] = argv;
  try {
    const { values } = parseArgs({
      args: rest,
      strict: true,
      options: {
        home: { type: 'string' }, via: { type: 'string' }, 'dry-run': { type: 'boolean' },
        'allow-main-home': { type: 'boolean' }, yes: { type: 'boolean' }, help: { type: 'boolean' },
      },
    });
    return { command, values };
  } catch (error) {
    throw new Refused('usage', error.message, USAGE);
  }
}

function emit(result, code) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = code;
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  try {
    const { command, values } = parse(process.argv.slice(2));
    if (values.help || !command) {
      process.stdout.write(`${USAGE}\n`);
      process.exitCode = values.help ? 0 : 2;
    } else if (command === 'install') {
      emit(install(values), values['dry-run'] === true ? 3 : 0);
    } else if (command === 'doctor') {
      const result = doctor(values);
      emit(result, result.ok ? 0 : 2);
    } else if (command === 'uninstall') {
      emit(uninstall(values), values['dry-run'] === true ? 3 : 0);
    } else {
      throw new Refused('usage', `Unknown command ${JSON.stringify(command)}.`, USAGE);
    }
  } catch (error) {
    if (process.env.PRODUCT_DEBUG === '1') throw error;
    const refused = error instanceof Refused;
    emit({
      ok: false,
      error: refused ? error.code : 'internal_error',
      message: refused ? error.message : 'Unexpected failure; no further detail is reported.',
      hint: refused ? error.hint : null,
      ...(refused ? error.extra : {}),
    }, 2);
  }
}
