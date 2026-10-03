// Installer, doctor, and uninstall: fresh-home restriction, strict receipts,
// symlink/path escape refusal, and fail-closed tamper handling.
//
// The installer validates the package manifest before it writes anything, so
// every test stages a copy of the package and refreshes that copy's manifest.
// That keeps the working tree's own MANIFEST/archive untouched while still
// exercising the real validation path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './helpers.mjs';

// A deterministic stand-in for the official CLI: marketplace mapping included,
// plus switches for failure, unregistration, remapping, and registry loss.
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const home = process.env.CODEX_HOME;
const stateFile = path.join(home, 'fake-cli-state.json');
const log = process.env.FAKE_LOG;
if (log) fs.appendFileSync(log, args.join(' ') + '\\n');
const read = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { registered: false }; } };
const write = (state) => { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state)); };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const fail = (code, message) => { process.stderr.write(message + '\\n'); process.exit(code); };
const VERSION = process.env.FAKE_VERSION || '9.9.9';
const cacheDir = path.join(home, 'plugins/cache/codex-on-crack/codex-on-crack', VERSION);

if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
  if (process.env.FAKE_FAIL_MARKETPLACE === '1') fail(1, 'marketplace unavailable');
  const source = args[3];
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), '[marketplaces.codex-on-crack]\\nsource_type = "local"\\nsource = "' + source + '"\\n');
  write({ registered: false, source });
  out({ marketplaceName: 'codex-on-crack', installedRoot: source, alreadyAdded: false });
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'add') {
  if (process.env.FAKE_FAIL_ADD === '1') fail(1, 'plugin add refused');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'plugin.json'), JSON.stringify({ name: 'codex-on-crack', version: VERSION }));
  fs.writeFileSync(path.join(cacheDir, 'SKILL.md'), '# fake skill\\n');
  fs.mkdirSync(path.join(home, '.tmp/marketplaces'), { recursive: true });
  fs.mkdirSync(path.join(home, 'tmp'), { recursive: true });
  const prior = read();
  write({ registered: true, version: VERSION, cacheDir, source: prior.source || process.env.FAKE_SOURCE || null });
  out({ pluginId: 'codex-on-crack@codex-on-crack', name: 'codex-on-crack', marketplaceName: 'codex-on-crack', version: VERSION, installedPath: cacheDir, authPolicy: 'ON_INSTALL' });
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'list') {
  const state = read();
  const hide = process.env.FAKE_UNREGISTER === '1' || process.env.FAKE_REGISTRY_MISSING === '1';
  const source = process.env.FAKE_REMAP_SOURCE || state.source || null;
  const installed = state.registered && !hide
    ? [{ pluginId: 'codex-on-crack@codex-on-crack', name: 'codex-on-crack', marketplaceName: 'codex-on-crack', version: state.version, enabled: true, installed: true, marketplaceSource: { sourceType: 'local', source } }]
    : [];
  out({ installed });
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'remove') {
  const state = read();
  if (state.cacheDir) fs.rmSync(state.cacheDir, { recursive: true, force: true });
  write({ registered: false, version: state.version, source: state.source });
  out({ removed: true });
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove') {
  fs.writeFileSync(path.join(home, 'config.toml'), '');
  out({ removed: true });
  process.exit(0);
}
fail(64, 'unsupported fake command: ' + args.join(' '));
`;

async function scratch(t, name = 'root') {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'crack-product-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// A copy of the package with its own freshly built manifest.
async function stagedPackage(t, { version = null } = {}) {
  const root = await scratch(t, 'stage');
  const pkg = path.join(root, 'package');
  fs.cpSync(ROOT, pkg, { recursive: true, filter: (src) => !/(^|\/)(\.git|dist|node_modules|\.local)(\/|$)/.test(src) });
  if (version !== null) {
    fs.writeFileSync(path.join(pkg, 'VERSION'), `${version}\n`);
    const pluginJson = path.join(pkg, 'plugins', 'codex-on-crack', '.codex-plugin', 'plugin.json');
    const doc = JSON.parse(fs.readFileSync(pluginJson, 'utf8'));
    doc.version = version;
    fs.writeFileSync(pluginJson, `${JSON.stringify(doc, null, 2)}\n`);
  }
  const refreshed = spawnSync(process.execPath, [path.join(pkg, 'scripts', 'release.mjs')], { encoding: 'utf8' });
  assert.equal(refreshed.status, 0, refreshed.stderr);
  return { root, pkg, product: path.join(pkg, 'scripts', 'product.mjs') };
}

function product(stage, args, env = {}) {
  const result = spawnSync(process.execPath, [stage.product, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
}

async function fakeCli(t, env = {}) {
  const root = await scratch(t, 'fake-cli');
  const bin = path.join(root, 'codex');
  fs.writeFileSync(bin, FAKE_CODEX, { mode: 0o755 });
  return { path: `${root}:${process.env.PATH}`, log: path.join(root, 'calls.log'), env };
}

function realCodex() {
  const found = spawnSync('sh', ['-c', 'command -v codex'], { encoding: 'utf8' }).stdout.trim();
  return found && fs.existsSync(found) ? found : null;
}

const receiptOf = (home) => JSON.parse(fs.readFileSync(path.join(home, 'codex-on-crack-receipt.json'), 'utf8'));
const transactionOf = (home) => JSON.parse(fs.readFileSync(path.join(home, 'codex-on-crack-transaction.json'), 'utf8'));

test('install requires an explicit isolated absolute home', async (t) => {
  const stage = await stagedPackage(t);
  const root = await scratch(t, 'targets');
  const target = path.join(root, 'home');
  assert.equal(product(stage, ['install']).json.error, 'home_required');
  assert.equal(product(stage, ['install', '--home', 'relative/path']).json.error, 'unsafe_target');
  assert.equal(product(stage, ['install', '--home', `${target}/../escape`]).json.error, 'unsafe_target');
  assert.equal(product(stage, ['install', '--home', '/']).json.error, 'unsafe_target');
  const link = path.join(root, 'link');
  fs.symlinkSync(root, link);
  assert.equal(product(stage, ['install', '--home', link, '--via', 'source']).json.error, 'unsafe_target');
  assert.equal(fs.existsSync(target), false);
});

test('both the real default home and the active CODEX_HOME are protected', async (t) => {
  const stage = await stagedPackage(t);
  const root = await scratch(t, 'protected');
  const active = path.join(root, 'active-home');
  fs.mkdirSync(active, { recursive: true });
  assert.equal(product(stage, ['install', '--home', path.join(os.homedir(), '.codex'), '--via', 'source'], { CODEX_HOME: active }).json.error, 'main_home_refused');
  assert.equal(product(stage, ['install', '--home', active, '--via', 'source'], { CODEX_HOME: active }).json.error, 'main_home_refused');
  const allowed = product(stage, ['install', '--home', active, '--via', 'source', '--allow-main-home', '--yes'], { CODEX_HOME: active });
  assert.equal(allowed.status, 0, allowed.stdout);
});

test('an unreceipted home must be absent or empty', async (t) => {
  const stage = await stagedPackage(t);
  const root = await scratch(t, 'shape');
  const empty = path.join(root, 'empty');
  fs.mkdirSync(path.join(empty, 'nested', 'deeper'), { recursive: true });
  assert.equal(product(stage, ['install', '--home', empty, '--via', 'source']).status, 0, 'empty directories are acceptable');

  const dirty = path.join(root, 'dirty');
  fs.mkdirSync(dirty);
  fs.writeFileSync(path.join(dirty, 'keep.txt'), 'mine\n');
  const refused = product(stage, ['install', '--home', dirty, '--via', 'source']);
  assert.equal(refused.status, 2);
  assert.equal(refused.json.error, 'home_not_empty');
  assert.equal(fs.readFileSync(path.join(dirty, 'keep.txt'), 'utf8'), 'mine\n');

  const withPlugin = path.join(root, 'plugin-home');
  fs.mkdirSync(path.join(withPlugin, 'plugins', 'other'), { recursive: true });
  fs.writeFileSync(path.join(withPlugin, 'plugins', 'other', 'index.js'), '// someone else\n');
  assert.equal(product(stage, ['install', '--home', withPlugin, '--via', 'source']).json.error, 'home_not_empty');
});

test('a symlinked component in the target home is refused before any write', async (t) => {
  const stage = await stagedPackage(t);
  const root = await scratch(t, 'symlinks');

  const sourceHome = path.join(root, 'source-home');
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(sourceHome);
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(sourceHome, '.agents'));
  const sourceRefused = product(stage, ['install', '--home', sourceHome, '--via', 'source']);
  assert.equal(sourceRefused.status, 2);
  assert.equal(sourceRefused.json.error, 'unsafe_target');
  assert.equal(fs.readdirSync(elsewhere).length, 0, 'nothing was written through the symlink');

  const cliHome = path.join(root, 'cli-home');
  const fake = await fakeCli(t);
  fs.mkdirSync(cliHome);
  fs.symlinkSync(path.join(root, 'elsewhere', 'config.toml'), path.join(cliHome, 'config.toml'));
  const cliRefused = product(stage, ['install', '--home', cliHome, '--via', 'cli'], { PATH: fake.path });
  assert.equal(cliRefused.status, 2);
  assert.equal(cliRefused.json.error, 'unsafe_target');
});

test('a symlinked receipt is refused', async (t) => {
  const stage = await stagedPackage(t);
  const root = await scratch(t, 'receipt-link');
  const home = path.join(root, 'home');
  product(stage, ['install', '--home', home, '--via', 'source']);
  const receipt = path.join(home, 'codex-on-crack-receipt.json');
  const saved = fs.readFileSync(receipt);
  const decoy = path.join(root, 'decoy.json');
  fs.writeFileSync(decoy, saved);
  fs.rmSync(receipt);
  fs.symlinkSync(decoy, receipt);

  const doctor = product(stage, ['doctor', '--home', home]);
  assert.equal(doctor.json.ok, false);
  assert.equal(doctor.json.status, 'receipt-invalid');
  assert.equal(doctor.json.problems[0].code, 'unsafe_target');
  assert.equal(product(stage, ['uninstall', '--home', home]).json.error, 'unsafe_target');
  assert.deepEqual(fs.readFileSync(decoy), saved, 'the symlink target is untouched');
});

test('a source install is idempotent without mutations and uninstalls cleanly', async (t) => {
  const stage = await stagedPackage(t);
  const root = await scratch(t, 'source-install');
  const home = path.join(root, 'home');
  const first = product(stage, ['install', '--home', home, '--via', 'source']);
  assert.equal(first.status, 0, first.stdout);
  assert.equal(first.json.hostLoaded, false);
  assert.equal(first.json.wrote, true);
  const receiptBytes = fs.readFileSync(path.join(home, 'codex-on-crack-receipt.json'));
  const receiptStat = fs.statSync(path.join(home, 'codex-on-crack-receipt.json'));

  const repeat = product(stage, ['install', '--home', home, '--via', 'source']);
  assert.equal(repeat.status, 0, repeat.stdout);
  assert.equal(repeat.json.status, 'unchanged');
  assert.equal(repeat.json.wrote, false, 'a same-manifest repeat writes nothing');
  assert.deepEqual(fs.readFileSync(path.join(home, 'codex-on-crack-receipt.json')), receiptBytes, 'the receipt is preserved byte for byte');
  assert.equal(fs.statSync(path.join(home, 'codex-on-crack-receipt.json')).mtimeMs, receiptStat.mtimeMs);

  const doctor = product(stage, ['doctor', '--home', home]);
  assert.equal(doctor.status, 0, doctor.stdout);
  assert.equal(doctor.json.install.installed, true);
  assert.match(doctor.json.install.evidence, /static source install/);
  assert.equal(doctor.json.model_calls_made, false);

  const uninstall = product(stage, ['uninstall', '--home', home]);
  assert.equal(uninstall.status, 0, uninstall.stdout);
  assert.equal(uninstall.json.status, 'uninstalled');
  assert.equal(fs.existsSync(home), false, 'an empty home created by the install is removed');
  assert.equal(product(stage, ['uninstall', '--home', home]).json.status, 'nothing-installed');
});

test('a different package version refuses in-place upgrade', async (t) => {
  const stage = await stagedPackage(t);
  const root = await scratch(t, 'upgrade');
  const home = path.join(root, 'home');
  product(stage, ['install', '--home', home, '--via', 'source']);
  const upgraded = await stagedPackage(t, { version: '9.9.9+codex.29990101000000' });
  const refused = product(upgraded, ['install', '--home', home, '--via', 'source']);
  assert.equal(refused.status, 2);
  assert.equal(refused.json.error, 'upgrade_requires_fresh_home');
  assert.match(refused.json.hint, /fresh home/);
});

test('a tampered or foreign receipt is rejected without touching anything', async (t) => {
  const stage = await stagedPackage(t);
  const root = await scratch(t, 'tamper');
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'keep me\n');
  const cases = [
    ['traversal', (r) => { r.files['../../outside.txt'] = 'a'.repeat(64); }],
    ['absolute', (r) => { r.files[outside] = 'a'.repeat(64); }],
    ['foreign plugin', (r) => { r.files['plugins/codex-on-crack/../../other/file.txt'] = 'a'.repeat(64); }],
    ['bad hash', (r) => { r.files['plugins/codex-on-crack/skills/crack/SKILL.md'] = 'not-a-hash'; }],
    ['no marketplace', (r) => { r.marketplace = null; }],
    ['wrong marketplace path', (r) => { r.marketplace.path = path.join(root, 'elsewhere.json'); }],
  ];
  for (const [label, mutate] of cases) {
    const home = path.join(root, `home-${label.replace(/\s+/g, '-')}`);
    fs.mkdirSync(home, { recursive: true });
    assert.equal(product(stage, ['install', '--home', home, '--via', 'source']).status, 0, label);
    const file = path.join(home, 'codex-on-crack-receipt.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    mutate(doc);
    fs.writeFileSync(file, JSON.stringify(doc));
    const doctor = product(stage, ['doctor', '--home', home]);
    assert.equal(doctor.json.ok, false, `${label}: doctor must fail`);
    const uninstall = product(stage, ['uninstall', '--home', home]);
    assert.equal(uninstall.status, 2, `${label}: uninstall must refuse`);
    assert.equal(uninstall.json.error, 'receipt_invalid', `${label}: ${uninstall.json.error}`);
    assert.ok(fs.existsSync(path.join(home, 'plugins', 'codex-on-crack', 'skills', 'crack', 'SKILL.md')), `${label}: nothing was removed`);
  }
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me\n');
});

test('a CLI receipt naming another plugin or version is rejected', async (t) => {
  const stage = await stagedPackage(t);
  const fake = await fakeCli(t);
  const root = await scratch(t, 'cli-receipt');
  const home = path.join(root, 'home');
  assert.equal(product(stage, ['install', '--home', home, '--via', 'cli'], { PATH: fake.path }).status, 0);
  const file = path.join(home, 'codex-on-crack-receipt.json');

  const foreign = JSON.parse(fs.readFileSync(file, 'utf8'));
  foreign.files['plugins/cache/other-plugin/other-plugin/1.0.0/x.js'] = 'a'.repeat(64);
  fs.writeFileSync(file, JSON.stringify(foreign));
  assert.equal(product(stage, ['doctor', '--home', home], { PATH: fake.path }).json.status, 'receipt-invalid');
  assert.equal(product(stage, ['uninstall', '--home', home], { PATH: fake.path }).json.error, 'receipt_invalid');

  const movedCache = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete movedCache.files['plugins/cache/other-plugin/other-plugin/1.0.0/x.js'];
  movedCache.cli.cacheDir = path.join(home, 'plugins/cache/codex-on-crack/codex-on-crack/0.0.1');
  fs.writeFileSync(file, JSON.stringify(movedCache));
  assert.equal(product(stage, ['uninstall', '--home', home], { PATH: fake.path }).json.error, 'receipt_invalid');
});

test('extra files anywhere in the owned tree stop install and uninstall', async (t) => {
  const stage = await stagedPackage(t);
  const root = await scratch(t, 'extra');
  const home = path.join(root, 'home');
  product(stage, ['install', '--home', home, '--via', 'source']);
  const extra = path.join(home, 'plugins', 'codex-on-crack', 'notes.txt');
  fs.writeFileSync(extra, 'not mine\n');

  const doctor = product(stage, ['doctor', '--home', home]);
  assert.equal(doctor.json.ok, false);
  assert.ok(doctor.json.install.extra.includes('plugins/codex-on-crack/notes.txt'));
  assert.equal(product(stage, ['install', '--home', home, '--via', 'source']).json.error, 'install_state_changed');
  assert.equal(product(stage, ['uninstall', '--home', home]).json.error, 'install_state_changed');
  assert.equal(fs.readFileSync(extra, 'utf8'), 'not mine\n', 'the extra file is never deleted');
});

test('a changed marketplace after install is reported and never dropped', async (t) => {
  const stage = await stagedPackage(t);
  const root = await scratch(t, 'marketplace');
  const home = path.join(root, 'home');
  product(stage, ['install', '--home', home, '--via', 'source']);
  const marketplace = path.join(home, '.agents', 'plugins', 'marketplace.json');
  const doc = JSON.parse(fs.readFileSync(marketplace, 'utf8'));
  doc.plugins.push({ name: 'someone-else', source: { source: 'local', path: './plugins/someone-else' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Other' });
  fs.writeFileSync(marketplace, `${JSON.stringify(doc, null, 2)}\n`);
  assert.equal(product(stage, ['doctor', '--home', home]).json.ok, false);
  assert.equal(product(stage, ['uninstall', '--home', home]).json.error, 'install_state_changed');
  assert.deepEqual(JSON.parse(fs.readFileSync(marketplace, 'utf8')).plugins.map((p) => p.name).sort(), ['codex-on-crack', 'someone-else']);
});

test('CLI cache tampering, registry loss, and marketplace remapping refuse cleanly', async (t) => {
  const stage = await stagedPackage(t);
  const fake = await fakeCli(t);
  const root = await scratch(t, 'cli-tamper');
  const home = path.join(root, 'home');
  const env = { PATH: fake.path };
  const install = product(stage, ['install', '--home', home, '--via', 'cli'], env);
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const cacheDir = install.json.installedPath;
  assert.equal(receiptOf(home).cli.registry.marketplaceSource, path.dirname(path.dirname(stage.product)));

  const healthy = product(stage, ['doctor', '--home', home], env);
  assert.equal(healthy.json.install.installed, true);
  assert.match(healthy.json.install.evidence, /host-loaded evidence/);
  assert.equal(product(stage, ['install', '--home', home, '--via', 'cli'], env).json.status, 'unchanged');

  fs.appendFileSync(path.join(cacheDir, 'SKILL.md'), 'tampered\n');
  assert.equal(product(stage, ['doctor', '--home', home], env).json.ok, false);
  assert.equal(product(stage, ['uninstall', '--home', home], env).json.error, 'install_state_changed');
  fs.writeFileSync(path.join(cacheDir, 'SKILL.md'), '# fake skill\n');

  fs.writeFileSync(path.join(cacheDir, 'extra.txt'), 'unexpected\n');
  const withExtra = product(stage, ['doctor', '--home', home], env);
  assert.equal(withExtra.json.ok, false);
  assert.ok(withExtra.json.install.extra.length >= 1);
  fs.rmSync(path.join(cacheDir, 'extra.txt'));

  fs.rmSync(cacheDir, { recursive: true, force: true });
  const deleted = product(stage, ['doctor', '--home', home], env);
  assert.equal(deleted.json.ok, false);
  assert.equal(deleted.json.install.installed, false);

  // Restore a consistent cache, then change the marketplace mapping.
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'plugin.json'), JSON.stringify({ name: 'codex-on-crack', version: '9.9.9' }));
  fs.writeFileSync(path.join(cacheDir, 'SKILL.md'), '# fake skill\n');
  const remapped = product(stage, ['doctor', '--home', home], { PATH: fake.path, FAKE_REMAP_SOURCE: '/somewhere/else' });
  assert.equal(remapped.json.ok, false);
  assert.ok(remapped.json.problems.some((p) => p.code === 'registry_changed'));
  const removed = product(stage, ['uninstall', '--home', home], { PATH: fake.path, FAKE_REMAP_SOURCE: '/somewhere/else' });
  assert.equal(removed.status, 2);
  assert.equal(removed.json.error, 'registry_remapped');
  assert.ok(fs.existsSync(cacheDir), 'a remapped registration is never unregistered or deleted');
});

test('an unverifiable CLI install leaves a transaction record and never deletes the cache', async (t) => {
  const stage = await stagedPackage(t);
  const fake = await fakeCli(t);
  const root = await scratch(t, 'transaction');
  const home = path.join(root, 'home');
  const failed = product(stage, ['install', '--home', home, '--via', 'cli'], { PATH: fake.path, FAKE_REGISTRY_MISSING: '1' });
  assert.equal(failed.status, 2);
  assert.equal(failed.json.error, 'registry_unverified');

  const record = transactionOf(home);
  assert.equal(record.status, 'unverified');
  assert.match(record.guidance, /Nothing was deleted/);
  const cacheDir = path.join(home, 'plugins/cache/codex-on-crack/codex-on-crack/9.9.9');
  assert.ok(fs.existsSync(cacheDir), 'the unverified cache is preserved');

  const doctor = product(stage, ['doctor', '--home', home], { PATH: fake.path });
  assert.equal(doctor.json.status, 'incomplete-install');
  assert.equal(doctor.json.ok, false);
  assert.equal(doctor.json.install.transaction.status, 'unverified');
  assert.equal(product(stage, ['install', '--home', home, '--via', 'cli'], { PATH: fake.path }).json.error, 'transaction_pending');

  const recovered = product(stage, ['uninstall', '--home', home], { PATH: fake.path });
  assert.equal(recovered.status, 2, recovered.stdout);
  assert.equal(recovered.json.error, 'transaction_unverified');
  assert.equal(fs.existsSync(cacheDir), true);
  assert.equal(fs.existsSync(path.join(home, 'codex-on-crack-transaction.json')), true);
});

test('a failed CLI add rolls back the registration and writes no receipt', async (t) => {
  const stage = await stagedPackage(t);
  const fake = await fakeCli(t);
  const root = await scratch(t, 'rollback');
  const home = path.join(root, 'home');
  const result = product(stage, ['install', '--home', home, '--via', 'cli'], { PATH: fake.path, FAKE_LOG: fake.log, FAKE_FAIL_ADD: '1' });
  assert.equal(result.status, 2);
  assert.equal(result.json.error, 'plugin_add_failed');
  assert.equal(result.json.rolledBack, true);
  const calls = fs.readFileSync(fake.log, 'utf8');
  assert.match(calls, /plugin marketplace add/);
  assert.match(calls, /plugin marketplace remove/);
  assert.equal(fs.existsSync(path.join(home, 'codex-on-crack-receipt.json')), false);
  assert.equal(fs.existsSync(path.join(home, 'codex-on-crack-transaction.json')), false, 'a clean rollback needs no record');
});

test('a failed marketplace registration leaves an explicit transaction record', async (t) => {
  const stage = await stagedPackage(t);
  const fake = await fakeCli(t);
  const root = await scratch(t, 'marketplace-fail');
  const home = path.join(root, 'home');
  const result = product(stage, ['install', '--home', home, '--via', 'cli'], { PATH: fake.path, FAKE_FAIL_MARKETPLACE: '1' });
  assert.equal(result.status, 2);
  assert.equal(result.json.error, 'marketplace_add_failed');
  const record = transactionOf(home);
  assert.equal(record.failedStep, 'marketplace add');
  assert.match(record.guidance, /Inspect/);
});

test('the supported plugin CLI installs into a new empty home, repeats, doctors, and uninstalls', async (t) => {
  if (realCodex() === null) {
    t.skip('no codex binary on PATH');
    return;
  }
  const stage = await stagedPackage(t);
  const root = await scratch(t, 'real-cli');
  const home = path.join(root, 'home');
  const install = product(stage, ['install', '--home', home, '--via', 'cli']);
  assert.equal(install.status, 0, install.stdout + install.stderr);
  assert.equal(install.json.hostLoaded, true);
  assert.ok(fs.existsSync(path.join(install.json.installedPath, '.codex-plugin', 'plugin.json')));
  const receipt = receiptOf(home);
  assert.equal(receipt.cli.registry.marketplaceSource, stage.pkg);

  const repeat = product(stage, ['install', '--home', home, '--via', 'cli']);
  assert.equal(repeat.status, 0, repeat.stdout);
  assert.equal(repeat.json.status, 'unchanged');
  assert.equal(repeat.json.wrote, false);

  const doctor = product(stage, ['doctor', '--home', home]);
  assert.equal(doctor.status, 0, doctor.stdout);
  assert.equal(doctor.json.install.installed, true);
  assert.match(doctor.json.install.evidence, /host-loaded evidence/);

  const uninstall = product(stage, ['uninstall', '--home', home]);
  assert.equal(uninstall.status, 0, uninstall.stdout);
  assert.equal(uninstall.json.status, 'uninstalled', JSON.stringify(uninstall.json));
  assert.equal(fs.existsSync(install.json.installedPath), false, 'the cache is removed');
  assert.equal(fs.existsSync(home), false, 'the empty home is removed');
});

test('doctor reports an uninstalled home without claiming verification', async (t) => {
  const stage = await stagedPackage(t);
  const root = await scratch(t, 'doctor');
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const doctor = product(stage, ['doctor', '--home', home]);
  assert.equal(doctor.status, 0, doctor.stdout);
  assert.equal(doctor.json.status, 'not-installed');
  assert.equal(doctor.json.runtime_verified, false);
  assert.equal(doctor.json.model_calls_made, false);
  assert.match(doctor.json.providerFacts.note, /not provider access/);
});

test('a stale package manifest stops the install before any write', async (t) => {
  const stage = await stagedPackage(t);
  const root = await scratch(t, 'stale');
  fs.appendFileSync(path.join(stage.pkg, 'README.md'), '\nlocal change\n');
  const home = path.join(root, 'home');
  const result = product(stage, ['install', '--home', home, '--via', 'source']);
  assert.equal(result.status, 2);
  assert.equal(result.json.error, 'manifest_invalid');
  assert.equal(fs.existsSync(home), false);
});
