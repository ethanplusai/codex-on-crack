import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cli, defaultCatalog, makeHome, DEFAULT_CONFIG, FLASH, ROLES_TOML } from './helpers.mjs';
import { MARKER } from '../plugins/codex-on-crack/skills/crack/scripts/lib/roles.mjs';

const doctor = (h) => cli('doctor.mjs', h.args);
const configured = (t, roles = ROLES_TOML, opts = {}) => {
  const h = makeHome(t, opts);
  const r = cli('setup.mjs', ['apply', '--roles', h.write('draft.toml', roles), ...h.args]);
  assert.equal(r.status, 0, r.stdout);
  return h;
};
const codes = (r) => r.json.problems.map((p) => p.code);

test('doctor reports workflow-only readiness before any roles are configured, and writes nothing', (t) => {
  const h = makeHome(t);
  const before = h.snapshot();
  const r = doctor(h);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.status, 'workflow-ready');
  assert.deepEqual(codes(r), []);
  assert.equal(r.json.delegation.configured, false);
  assert.equal(r.json.delegation.ready, false);
  assert.match(r.json.delegation.note, /no roles are configured/);
  assert.deepEqual(h.snapshot(), before);
});

test('doctor flags a generated role file that no crack.toml explains', (t) => {
  const h = makeHome(t);
  h.write('agents/crack_builder.toml', `${MARKER}\nname = "crack_builder"\n`);
  const r = doctor(h);
  assert.equal(r.status, 2);
  assert.deepEqual(codes(r), ['orphaned_agent_files']);
});

// Regression: an unreadable delegation catalog and disabled subagents are
// prerequisites for delegation, not for the direct workflow, so neither may
// fail a workflow-only check.
test('workflow-only readiness ignores a missing catalog and disabled subagents', (t) => {
  const noCatalog = doctor(makeHome(t, { catalog: null }));
  assert.equal(noCatalog.status, 0, noCatalog.stdout);
  assert.equal(noCatalog.json.status, 'workflow-ready');
  assert.deepEqual(codes(noCatalog), []);
  const disabled = doctor(makeHome(t, { config: `${DEFAULT_CONFIG}\n[agents]\nenabled = false\n` }));
  assert.equal(disabled.status, 0, disabled.stdout);
  assert.equal(disabled.json.status, 'workflow-ready');
  assert.ok(disabled.json.warnings.some((w) => /disabled/.test(w)));
});

test('doctor is static-ready after setup, with every rung in sync and its provider source', (t) => {
  const h = configured(t);
  const r = doctor(h);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.status, 'static-ready');
  assert.equal(r.json.delegation.configured, true);
  assert.equal(r.json.delegation.ready, true);
  assert.equal(r.json.runtime_verified, false);
  assert.equal(r.json.inference_request_made, false);
  assert.deepEqual(r.json.rungs.map((g) => [g.agent, g.file, g.provider_source]), [
    ['crack_builder', 'in-sync', 'inherited'],
    ['crack_builder_fallback', 'in-sync', 'router-agent'],
    ['crack_reviewer', 'in-sync', 'router-agent'],
  ]);
});

test('doctor distinguishes missing, edited, and stale agent files', (t) => {
  const h = configured(t);
  const agents = path.join(h.codexHome, 'agents');
  fs.rmSync(path.join(agents, 'crack_reviewer.toml'));
  fs.appendFileSync(path.join(agents, 'crack_builder_fallback.toml'), '# mine\n');
  h.write('crack/crack.toml', h.read('crack/crack.toml').replace('its tests.', 'its tests, carefully.'));
  const r = doctor(h);
  assert.equal(r.status, 2);
  assert.deepEqual(r.json.rungs.map((g) => g.file), ['stale', 'edited', 'missing']);
  assert.deepEqual(codes(r), ['agent_file_stale', 'agent_file_edited', 'agent_file_missing']);
});

test('doctor reports a model that stopped being subagent-capable', (t) => {
  const h = configured(t);
  const models = defaultCatalog().models.map((m) => (m.slug === FLASH ? { ...m, multi_agent_version: 'v1' } : m));
  h.write('catalog.json', JSON.stringify({ models }));
  assert.deepEqual(codes(doctor(h)), ['model_ineligible']);
});

test('doctor describes same-model review as separate sessions', (t) => {
  const h = configured(t, `schema_version = 1\n[roles.builder]\nmodel = "${FLASH}"\nwrites = true\nbrief = "b"\n[roles.reviewer]\nmodel = "${FLASH}"\nbrief = "r"\n`);
  const r = doctor(h);
  assert.equal(r.status, 0, r.stdout);
  assert.ok(r.json.warnings.some((w) => /separate sessions/.test(w)));
});

test('doctor reports keys absorbed into [agents] as a problem instead of crashing', (t) => {
  const h = configured(t);
  h.write('config.toml', `${DEFAULT_CONFIG}\n[agents]\nexperimental_realtime_ws_base_url = "https://example.invalid/v1"\n`);
  const r = doctor(h);
  assert.equal(r.status, 2);
  assert.ok(codes(r).includes('agents_absorbed_keys'));
});
