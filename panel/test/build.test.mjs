// The committed server/ bundle is what an installed plugin runs. It must match
// a fresh build from src/ and the pinned lockfile, carry no packaging-host
// paths, and run without node_modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEV_ROOT, PLUGIN_ROOT, REPO_ROOT, hasModule } from './fixtures.mjs';

const SERVER = path.join(PLUGIN_ROOT, 'server');
const canBuild = hasModule('esbuild') && hasModule('@modelcontextprotocol/sdk') && hasModule('@openai/mcp-extensions');

function files(dir) {
  return fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort();
}

test('the committed bundle matches a fresh build', { skip: !canBuild && 'build dependencies are not installed (npm ci)' }, async (t) => {
  const { buildAll } = await import('../scripts/build.mjs');
  const out = await fsp.mkdtemp(path.join(os.tmpdir(), 'crack-panel-build-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  await buildAll({ out });
  assert.deepEqual(files(out), files(SERVER));
  for (const file of files(out)) {
    assert.ok(fs.readFileSync(path.join(out, file)).equals(fs.readFileSync(path.join(SERVER, file))), `server/${file} is stale; run npm run build`);
  }
});

test('the bundle carries no host paths and runs without node_modules', async (t) => {
  for (const file of files(SERVER)) {
    const text = fs.readFileSync(path.join(SERVER, file), 'utf8');
    assert.ok(!text.includes(os.homedir()), `server/${file} contains the packaging host home path`);
    assert.ok(!text.includes(REPO_ROOT) && !text.includes(DEV_ROOT), `server/${file} contains an absolute source path`);
  }
  // Copy the bundle somewhere with no node_modules above it and run it there.
  const copy = await fsp.mkdtemp(path.join(os.tmpdir(), 'crack-panel-copy-'));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  await fsp.cp(SERVER, path.join(copy, 'server'), { recursive: true });
  const check = spawnSync(process.execPath, [path.join(copy, 'server', 'panel.mjs'), 'check', '--config', path.join(copy, 'missing.json')], { encoding: 'utf8' });
  assert.equal(check.status, 1);
  assert.equal(JSON.parse(check.stdout).ok, false);
  const doctor = spawnSync(process.execPath, [path.join(copy, 'server', 'lead.mjs'), 'doctor'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.model_calls_made, false);
  assert.equal(report.dependencies.find((d) => d.name === 'claude').status, 'unavailable');
});
