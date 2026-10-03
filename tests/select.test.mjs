import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cli, makeHome, FLASH, OPUS, ROLES_TOML, DEFAULT_CONFIG, ROOT_MODEL } from './helpers.mjs';
function installed(t, text = ROLES_TOML, options) {
  const h = makeHome(t, options);
  const result = cli('setup.mjs', ['apply', '--roles', h.write('draft.toml', text), ...h.args]);
  assert.equal(result.status, 0, result.stdout);
  return h;
}
const select = (h, ...args) => cli('select.mjs', [...h.args, ...args]);
test('selection defaults only unmapped builder to implementation and stays read-only', (t) => {
  const h = installed(t); const before = h.snapshot();
  const result = select(h, '--task', 'implementation');
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.json.status, 'selected');
  assert.equal(result.json.selected.agent, 'crack_builder');
  assert.equal(result.json.selected.model, FLASH);
  assert.equal(result.json.selected.effort, 'high');
  assert.equal(result.json.runtime_verified, false);
  assert.equal(select(h, '--task', 'review').json.status, 'needs-choice');
  assert.equal(select(h, '--task', 'review', '--role', 'reviewer').json.selected.agent, 'crack_reviewer');
  assert.equal(select(h, '--task', 'ui').json.selected, null);
  assert.deepEqual(h.snapshot(), before);
});
test('multiple configured choices remain ambiguous; exact role bypasses mapping only', (t) => {
  const h = installed(t, ROLES_TOML + `\n[roles.second]\nmodel = "${OPUS}"\nwrites = true\ntasks = ["implementation", "ui"]\nbrief = "Implementation"\n`);
  const result = select(h, '--task', 'implementation');
  assert.equal(result.json.status, 'needs-choice'); assert.equal(result.json.candidates.length, 2);
  assert.equal(select(h, '--task', 'implementation', '--role', 'second').json.selected.model, OPUS);
  assert.equal(select(h, '--task', 'ui', '--role', 'builder', '--vision').json.selected.model, FLASH);
  assert.equal(select(h, '--task', 'implementation', '--role', 'reviewer').json.selected, null);
  assert.equal(select(h, '--task', 'review', '--role', 'builder').json.selected, null);
  assert.equal(select(h, '--task', 'implementation', '--role', 'absent').json.selected, null);
  assert.equal(select(h, '--task', 'implementation', '--role', 'second', '--vision').json.selected, null);
  assert.equal(select(h, '--task', 'implementation', '--min-context', '300000').json.selected.model, FLASH);
  assert.equal(select(h, '--task', 'implementation', '--min-context', '9999999').json.selected, null);
});
test('unknown context is never treated as sufficient, mappings can disable builder default', (t) => {
  const h = installed(t, ROLES_TOML.replace('writes = true', 'writes = true\ntasks = []'));
  assert.equal(select(h, '--task', 'implementation').json.selected, null);
  const catalog = JSON.parse(h.read('catalog.json'));
  delete catalog.models.find((model) => model.slug === FLASH).context_window;
  h.write('catalog.json', JSON.stringify(catalog));
  assert.equal(select(h, '--task', 'implementation', '--role', 'builder', '--min-context', '1').json.selected, null);
});
test('stale, edited, missing, disabled, or incompatible roles never become ready', (t) => {
  const h = installed(t);
  h.write('crack/crack.toml', h.read('crack/crack.toml').replace('its tests.', 'its tests carefully.'));
  let result = select(h, '--task', 'implementation');
  assert.equal(result.status, 2); assert.equal(result.json.selected, null);
  assert.equal(result.json.status, 'not-ready');
  assert.ok(result.json.problems.some((p) => p.code === 'agent_file_stale'));
  const other = installed(t);
  fs.rmSync(path.join(other.codexHome, 'agents/crack_builder.toml'));
  assert.equal(select(other, '--task', 'implementation').json.selected, null);
  const routing = installed(t);
  routing.write('config.toml', DEFAULT_CONFIG.replace('http://127.0.0.1:4202/v1', 'https://incompatible.invalid/v1'));
  assert.ok(select(routing, '--task', 'implementation', '--role', 'builder').json.problems.some((p) => p.code === 'provider_incompatible'));
  const disabled = installed(t);
  disabled.write('config.toml', `${DEFAULT_CONFIG}\n[agents]\nenabled = false\n`);
  assert.equal(select(disabled, '--task', 'implementation').json.selected, null);
});
test('selection respects recorded profiles and validates flags', (t) => {
  const text = `schema_version = 1\n[roles.builder]\nmodel = "${ROOT_MODEL}"\nwrites = true\nbrief = "Implement"\n`;
  const h = makeHome(t, { config: `model = "${ROOT_MODEL}"\nmodel_catalog_json = "catalog.json"\n[profiles.native]\nmodel = "${ROOT_MODEL}"\n` });
  const result = cli('setup.mjs', ['apply', '--roles', h.write('draft.toml', text), '--profile', 'native', ...h.args]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(select(h, '--task', 'implementation').json.selected.model, ROOT_MODEL);
  for (const args of [[], ['--task', 'nope'], ['--task', 'ui', '--min-context', '0'], ['--task', 'ui', '--min-context', '1e6'], ['--task', 'ui', '--role', '../bad'], ['--task', 'ui', '--unexpected']]) {
    assert.equal(select(h, ...args).json.error, 'usage');
  }
});
