// Plugin packaging: the manifest follows the plugin.json conventions, the MCP
// server it declares exists, the skill is well formed, and registration is
// opt-in (the main plugin still declares no MCP server).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEV_ROOT, PLUGIN_ROOT as PANEL_ROOT, REPO_ROOT as REPO } from './fixtures.mjs';
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('manifest, MCP config, and skill are consistent', () => {
  const manifest = readJson(path.join(PANEL_ROOT, '.codex-plugin', 'plugin.json'));
  assert.equal(manifest.name, path.basename(PANEL_ROOT));
  assert.match(manifest.version, /^\d+\.\d+\.\d+/);
  assert.equal(readJson(path.join(DEV_ROOT, 'package.json')).version, manifest.version);
  for (const key of ['skills', 'mcpServers']) {
    assert.match(manifest[key], /^\.\//, `${key} is a ./ relative path`);
    assert.ok(fs.existsSync(path.join(PANEL_ROOT, manifest[key])), `${key} exists`);
  }
  for (const key of ['composerIcon', 'logo']) assert.equal(manifest.interface[key],undefined, `${key} omitted for text-only branding`);
  assert.ok(manifest.interface.defaultPrompt.length <= 3);
  for (const prompt of manifest.interface.defaultPrompt) assert.ok(prompt.length <= 128);
  assert.ok(!manifest.interface.capabilities.includes('Write'), 'the panel does not claim write capability');

  const mcp = readJson(path.join(PANEL_ROOT, '.mcp.json'));
  const server = mcp.mcpServers['codex-on-crack-panel'];
  assert.equal(server.command, 'node');
  assert.equal(server.cwd, '.');
  assert.ok(fs.existsSync(path.join(PANEL_ROOT, server.args[0])), 'the declared server entry is built');
  assert.equal(server.args[1], 'mcp');
  assert.equal(server.env, undefined, 'no environment or secrets are injected');

  const skill = fs.readFileSync(path.join(PANEL_ROOT, 'skills', 'crack-panel', 'SKILL.md'), 'utf8');
  const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(skill);
  assert.ok(front, 'SKILL.md has name and description frontmatter');
  assert.equal(front[1], 'crack-panel');
  assert.match(skill, /Do not approve or request changes/);
});

test('the plugin folder holds only runtime files', () => {
  // The host copies the plugin folder verbatim into its cache, so sources,
  // tests, and dependencies live in panel/ instead.
  const entries = fs.readdirSync(PANEL_ROOT).sort();
  assert.deepEqual(entries, ['.codex-plugin', '.mcp.json', 'README.md', 'assets', 'server', 'skills']);
});

test('registration is opt-in: available in the marketplace, never added to the main plugin', () => {
  const marketplace = readJson(path.join(REPO, '.agents', 'plugins', 'marketplace.json'));
  assert.equal(marketplace.plugins[0].name, 'codex-on-crack', 'the main plugin keeps its place');
  const entry = marketplace.plugins.find((p) => p.name === 'codex-on-crack-panel');
  assert.equal(entry.policy.installation, 'AVAILABLE');
  assert.equal(path.resolve(REPO, entry.source.path), PANEL_ROOT);
  const main = readJson(path.join(REPO, 'plugins', 'codex-on-crack', '.codex-plugin', 'plugin.json'));
  assert.equal(main.mcpServers, undefined, 'installing the main plugin never starts the panel server');
  assert.ok(!fs.existsSync(path.join(REPO, 'plugins', 'codex-on-crack', '.mcp.json')));
});
