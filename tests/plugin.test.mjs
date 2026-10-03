import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './helpers.mjs';

const PLUGIN = path.join(ROOT, 'plugins', 'codex-on-crack');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const SKILL_NAMES = ['crack', 'crack-plan', 'crack-setup'];

function codexBinary() {
  const candidates = [process.env.CODEX_BIN, '/Applications/ChatGPT.app/Contents/Resources/codex'];
  const onPath = spawnSync('sh', ['-c', 'command -v codex'], { encoding: 'utf8' }).stdout.trim();
  if (onPath) candidates.splice(1, 0, onPath);
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? null;
}

test('manifest, marketplace, package.json, and VERSION agree', () => {
  const manifest = readJson(path.join(PLUGIN, '.codex-plugin', 'plugin.json'));
  const marketplace = readJson(path.join(ROOT, '.agents', 'plugins', 'marketplace.json'));
  const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
  assert.equal(manifest.name, 'codex-on-crack');
  assert.equal(manifest.version, version);
  assert.equal(readJson(path.join(ROOT, 'package.json')).version, version);
  assert.equal(manifest.skills, './skills/');
  assert.ok(fs.existsSync(path.join(PLUGIN, 'skills', 'crack', 'SKILL.md')));
  assert.equal(manifest.interface.displayName, 'Codex on Crack');
  assert.ok(manifest.interface.defaultPrompt.length >= 1);
  const [entry] = marketplace.plugins;
  assert.equal(marketplace.name, 'codex-on-crack');
  assert.equal(entry.name, 'codex-on-crack');
  assert.equal(entry.source.source, 'local');
  assert.equal(path.resolve(ROOT, entry.source.path), PLUGIN);
});

test('Codex installs the plugin from the local marketplace into a scratch CODEX_HOME', (t) => {
  const codex = codexBinary();
  if (!codex) {
    t.skip('No codex binary found; set CODEX_BIN to run this end-to-end check.');
    return;
  }
  const codexHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crack-e2e-')));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-6-astra"\n');
  const env = { ...process.env, CODEX_HOME: codexHome };
  const runCodex = (...args) => spawnSync(codex, args, { encoding: 'utf8', env, cwd: codexHome, timeout: 120_000 });
  const added = runCodex('plugin', 'marketplace', 'add', ROOT);
  assert.equal(added.status, 0, `${added.stdout}\n${added.stderr}`);
  const installed = runCodex('plugin', 'add', 'codex-on-crack@codex-on-crack');
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
  const installedSkills = fs.readdirSync(codexHome, { recursive: true })
    .filter((file) => /skills[\\/][^\\/]+[\\/]SKILL\.md$/.test(file))
    .map((file) => path.basename(path.dirname(file)));
  assert.deepEqual([...new Set(installedSkills)].sort(), [...SKILL_NAMES].sort(),
    'the installed plugin cache contains exactly the two pilot skills');
  const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  assert.match(config, /codex-on-crack/);
});
