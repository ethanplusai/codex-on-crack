import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  catalogEntry, cli, makeHome, DEFAULT_CONFIG, DUPLICATED, FLASH, OPUS, ROLES_TOML, ROOT_MODEL, V1_ONLY,
} from './helpers.mjs';
import { parseToml } from '../plugins/codex-on-crack/skills/crack/scripts/lib/toml.mjs';

const setup = (h, ...args) => cli('setup.mjs', [...args, ...h.args]);
const draft = (h, text = ROLES_TOML) => h.write('draft.toml', text);
const rel = (h, changes) => changes.map((c) => [c.action, path.relative(h.codexHome, c.path)]);

test('scan reports eligible and ineligible models without writing or leaking anything', (t) => {
  const h = makeHome(t);
  const before = h.snapshot();
  const r = setup(h, 'scan');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.root_model, ROOT_MODEL);
  assert.equal(r.json.catalog.source, 'model_catalog_json');
  assert.deepEqual(r.json.eligible.map((m) => m.model), [ROOT_MODEL, FLASH, OPUS]);
  assert.deepEqual(r.json.ineligible.map((m) => [m.model, m.reason]),
    [[V1_ONLY, 'not_subagent_capable'], [DUPLICATED, 'duplicate']]);
  assert.deepEqual(Object.keys(r.json.default_roles), ['scout', 'builder', 'tester', 'reviewer', 'designer']);
  assert.equal(r.json.existing.crack_toml, null);
  assert.equal(r.json.existing.astra_flash_builder, null);
  assert.deepEqual(h.snapshot(), before);
  assert.ok(!r.stdout.includes('TEST_SECRET_KEY'));
});

test('scan detects an existing astra-flash role for migration', (t) => {
  const h = makeHome(t);
  h.write('agents/astra_flash_builder.toml', `name = "astra_flash_builder"\nmodel = "${FLASH}"\n`);
  assert.equal(setup(h, 'scan').json.existing.astra_flash_builder.model, FLASH);
});

test('plan previews every file and provider without writing', (t) => {
  const h = makeHome(t);
  const file = draft(h);
  const before = h.snapshot();
  const r = setup(h, 'plan', '--roles', file);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(rel(h, r.json.changes), [
    ['create', 'crack/crack.toml'],
    ['create', 'agents/crack_builder.toml'],
    ['create', 'agents/crack_builder_fallback.toml'],
    ['create', 'agents/crack_reviewer.toml'],
  ]);
  assert.deepEqual(r.json.providers.map((p) => p.provider_source), ['inherited', 'router-agent', 'router-agent']);
  assert.deepEqual(h.snapshot(), before);
});

test('apply writes crack.toml and agent files, never config.toml, and is idempotent', (t) => {
  const h = makeHome(t);
  const config = h.read('config.toml');
  const r = setup(h, 'apply', '--roles', draft(h));
  assert.equal(r.status, 0, r.stdout);
  assert.ok(r.json.receipt);
  assert.equal(h.read('config.toml'), config);
  assert.ok(h.read('crack/crack.toml').startsWith('# Managed by codex-on-crack.'));
  const builder = parseToml(h.read('agents/crack_builder.toml'), 'b');
  assert.equal(builder.model, FLASH);
  assert.equal('model_provider' in builder, false);
  assert.equal(parseToml(h.read('agents/crack_builder_fallback.toml'), 'f').model_provider, 'codex-router');
  const again = setup(h, 'apply');
  assert.equal(again.status, 0, again.stdout);
  assert.equal(again.json.receipt, null);
  assert.deepEqual(again.json.changes, []);
});

test('apply retires the agent files of a removed role or rung', (t) => {
  const h = makeHome(t);
  setup(h, 'apply', '--roles', draft(h));
  const r = setup(h, 'apply', '--roles', draft(h, `schema_version = 1\n[roles.builder]\nmodel = "${FLASH}"\nwrites = true\nbrief = "b"\n`));
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(rel(h, r.json.changes).sort(), [
    ['delete', 'agents/crack_builder_fallback.toml'],
    ['delete', 'agents/crack_reviewer.toml'],
    ['update', 'agents/crack_builder.toml'],
    ['update', 'crack/crack.toml'],
  ]);
  assert.equal(h.exists('agents/crack_reviewer.toml'), false);
});

test('apply refuses to overwrite an agent file the user edited', (t) => {
  const h = makeHome(t);
  setup(h, 'apply', '--roles', draft(h));
  fs.appendFileSync(path.join(h.codexHome, 'agents', 'crack_builder.toml'), '# mine\n');
  const r = setup(h, 'apply', '--roles', draft(h, ROLES_TOML.replace('its tests.', 'its tests, carefully.')));
  assert.equal(r.status, 2);
  assert.equal(r.json.error, 'edited_file');
});

test('--policy writes one marked block into AGENTS.md, and undo restores everything', (t) => {
  const h = makeHome(t);
  h.write('AGENTS.md', '# my rules\n');
  const first = setup(h, 'apply', '--policy', '--roles', draft(h));
  assert.equal(first.status, 0, first.stdout);
  assert.match(h.read('AGENTS.md'), /^# my rules\n\n<!-- BEGIN codex-on-crack managed policy -->/);
  assert.deepEqual(setup(h, 'apply', '--policy').json.changes, []);
  const preview = setup(h, 'undo', '--receipt', first.json.receipt);
  assert.equal(preview.status, 0, preview.stdout);
  assert.equal(preview.json.applied, false);
  assert.equal(h.exists('crack/crack.toml'), true);
  const undone = setup(h, 'undo', '--receipt', first.json.receipt, '--apply');
  assert.equal(undone.status, 0, undone.stdout);
  assert.equal(h.read('AGENTS.md'), '# my rules\n');
  assert.equal(h.exists('crack/crack.toml'), false);
  assert.equal(h.exists('agents/crack_builder.toml'), false);
});

test('setup refuses a config with keys absorbed into [agents], and writes nothing', (t) => {
  const h = makeHome(t, { config: `${DEFAULT_CONFIG}\n[agents]\nexperimental_realtime_ws_base_url = "https://example.invalid/v1"\n` });
  const file = draft(h);
  const before = h.snapshot();
  const r = setup(h, 'apply', '--roles', file);
  assert.equal(r.status, 2);
  assert.equal(r.json.error, 'agents_absorbed_keys');
  assert.deepEqual(h.snapshot(), before);
});

test('setup rejects an ineligible model and reports usage errors', (t) => {
  const h = makeHome(t);
  const bad = setup(h, 'apply', '--roles', draft(h, `schema_version = 1\n[roles.builder]\nmodel = "${V1_ONLY}"\nbrief = "b"\n`));
  assert.equal(bad.json.error, 'model_ineligible');
  assert.equal(setup(h, 'bogus').json.error, 'usage');
  assert.equal(setup(h, 'scan', '--nope').json.error, 'usage');
  assert.equal(setup(h, 'undo').json.error, 'usage');
  assert.equal(setup(h, 'apply').json.error, 'roles_missing');
});

test('setup works without a router, from Codex\'s own models_cache.json', (t) => {
  const h = makeHome(t, { config: `model = "${ROOT_MODEL}"\n`, catalog: null });
  h.write('models_cache.json', JSON.stringify({ models: [catalogEntry('gpt-5.6-mini')] }));
  assert.equal(setup(h, 'scan').json.catalog.source, 'models_cache');
  const r = setup(h, 'apply', '--roles', draft(h, 'schema_version = 1\n[roles.builder]\nmodel = "gpt-5.6-mini"\nwrites = true\nbrief = "b"\n'));
  assert.equal(r.status, 0, r.stdout);
  assert.equal(parseToml(h.read('agents/crack_builder.toml'), 'b').model, 'gpt-5.6-mini');
});

test('setup accepts a draft and a receipt reached through symlinked directories, as under macOS /tmp', (t) => {
  const h = makeHome(t);
  const real = path.join(h.home, 'drafts');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'draft.toml'), ROLES_TOML);
  fs.symlinkSync(real, path.join(h.home, 'drafts-link'));
  const viaLink = path.join(h.home, 'drafts-link', 'draft.toml');
  assert.equal(setup(h, 'plan', '--roles', viaLink).status, 0);
  const applied = setup(h, 'apply', '--roles', viaLink);
  assert.equal(applied.status, 0, applied.stdout);
  fs.symlinkSync(h.codexHome, path.join(h.home, 'codex-link'));
  const receiptViaLink = path.join(h.home, 'codex-link', path.relative(h.codexHome, applied.json.receipt));
  const undone = setup(h, 'undo', '--receipt', receiptViaLink, '--apply');
  assert.equal(undone.status, 0, undone.stdout);
  assert.equal(h.exists('crack/crack.toml'), false);
});
