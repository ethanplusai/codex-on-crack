import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeHome, ROOT_MODEL } from './helpers.mjs';
import {
  AGENT_SCALAR_SETTINGS, checkAgentsShape, locations, mergeTables, readConfig, resolvePath,
} from '../plugins/codex-on-crack/skills/crack/scripts/lib/config.mjs';
import { parseToml, tomlString } from '../plugins/codex-on-crack/skills/crack/scripts/lib/toml.mjs';

test('tomlString round-trips quotes, backslashes, newlines, unicode, and DEL', () => {
  const value = `say "hi" \\ path\n\ttab é ${String.fromCharCode(127)} end`;
  assert.equal(parseToml(`k = ${tomlString(value)}`, 'x').k, value);
});

test('parseToml names the file but never echoes the offending source', () => {
  assert.throws(() => parseToml('token = "TEST_SECRET_KEY\n', 'config.toml'),
    (e) => e.code === 'invalid_toml' && e.message.includes('config.toml') && !e.message.includes('TEST_SECRET_KEY'));
});

test('locations keeps explicit real paths', (t) => {
  const h = makeHome(t);
  assert.deepEqual(locations({ home: h.home, codexHome: h.codexHome }), { home: h.home, codexHome: h.codexHome });
});

test('locations defaults CODEX_HOME to <home>/.codex when the variable is unset', (t) => {
  const h = makeHome(t);
  const saved = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  t.after(() => {
    if (saved !== undefined) process.env.CODEX_HOME = saved;
  });
  assert.equal(locations({ home: h.home }).codexHome, h.codexHome);
});

test('resolvePath expands CODEX_HOME, HOME, and ~, and anchors relative paths in CODEX_HOME', () => {
  const where = { home: '/h', codexHome: '/h/.codex' };
  assert.equal(resolvePath('$CODEX_HOME/a.json', where), '/h/.codex/a.json');
  assert.equal(resolvePath('${HOME}/b.json', where), '/h/b.json');
  assert.equal(resolvePath('~/c.json', where), '/h/c.json');
  assert.equal(resolvePath('d.json', where), '/h/.codex/d.json');
  assert.equal(resolvePath('/abs/e.json', where), '/abs/e.json');
});

test('mergeTables deep-merges tables and replaces scalars', () => {
  assert.deepEqual(mergeTables({ a: { b: 1, c: 2 }, d: 1 }, { a: { c: 3 }, d: 2 }), { a: { b: 1, c: 3 }, d: 2 });
});

test('readConfig reads and hashes config.toml', (t) => {
  const h = makeHome(t);
  const result = readConfig({ home: h.home, codexHome: h.codexHome });
  assert.equal(result.config.model, ROOT_MODEL);
  assert.deepEqual(Object.keys(result.inputHashes), [path.join(h.codexHome, 'config.toml')]);
  assert.equal(result.profile, null);
});

test('readConfig merges a standalone profile over the base config', (t) => {
  const h = makeHome(t);
  h.write('work.config.toml', 'model = "profile-root"\n');
  const result = readConfig({ home: h.home, codexHome: h.codexHome, profile: 'work' });
  assert.equal(result.config.model, 'profile-root');
  assert.equal(Object.keys(result.inputHashes).length, 2);
});

test('readConfig applies a legacy inline profile with a warning', (t) => {
  const h = makeHome(t);
  h.write('config.toml', `${h.read('config.toml')}\n[profiles.work]\nmodel = "legacy-root"\n`);
  const result = readConfig({ home: h.home, codexHome: h.codexHome, profile: 'work' });
  assert.equal(result.config.model, 'legacy-root');
  assert.equal(result.warnings.length, 1);
});

test('readConfig refuses a missing, ambiguous, or unsafe profile', (t) => {
  const h = makeHome(t);
  const where = { home: h.home, codexHome: h.codexHome };
  assert.throws(() => readConfig({ ...where, profile: 'nope' }), { code: 'profile_missing' });
  assert.throws(() => readConfig({ ...where, profile: '../x' }), { code: 'unsupported_profile' });
  h.write('config.toml', `${h.read('config.toml')}\n[profiles.work]\nmodel = "legacy"\n`);
  h.write('work.config.toml', 'model = "standalone"\n');
  assert.throws(() => readConfig({ ...where, profile: 'work' }), { code: 'ambiguous_profile' });
});

test('readConfig tracks an absent native config without creating it', (t) => {
  const h = makeHome(t, { config: null });
  const result = readConfig({ home: h.home, codexHome: h.codexHome });
  assert.deepEqual(result.config, {});
  assert.equal(result.inputHashes[path.join(h.codexHome, 'config.toml')], null);
  assert.equal(h.exists('config.toml'), false);
});

// Regression for a real incident: an agent satisfying an old installer
// prerequisite appended [agents] to config.toml, absorbing the two top-level
// realtime keys after it. Codex then refused to load its config at all.
test('checkAgentsShape catches keys absorbed into [agents] by shape, not by name', () => {
  const config = parseToml([
    'model = "m"',
    '[agents]',
    'default_subagent_model = "x"',
    'experimental_realtime_webrtc_call_base_url = "https://example.invalid/backend-api/codex"',
    'experimental_realtime_ws_base_url = "https://example.invalid/v1"',
  ].join('\n'), 'config.toml');
  assert.throws(() => checkAgentsShape(config), (e) => e.code === 'agents_absorbed_keys'
    && e.message.includes('experimental_realtime_webrtc_call_base_url, experimental_realtime_ws_base_url'));
});

test('checkAgentsShape accepts every recognized scalar and role tables', () => {
  const config = parseToml([
    '[agents]', 'enabled = true', 'default_subagent_model = "x"', 'default_subagent_reasoning_effort = "high"',
    'interrupt_message = true', 'max_concurrent_threads_per_session = 6', 'max_threads = 6', 'max_depth = 2',
    'job_max_runtime_seconds = 600', '[agents.my_role]', 'description = "a role"',
  ].join('\n'), 'config.toml');
  assert.equal(AGENT_SCALAR_SETTINGS.size, 8);
  assert.deepEqual(checkAgentsShape(config),
    ['The global default_subagent_model is neither used nor changed; each codex-on-crack role pins its own model.']);
});

test('checkAgentsShape rejects an agent name holding a scalar, a non-table, and disabled subagents', () => {
  assert.throws(() => checkAgentsShape(parseToml('[agents]\ncrack_builder = "not-a-table"\n', 'c')), { code: 'agents_absorbed_keys' });
  assert.throws(() => checkAgentsShape(parseToml('[agents]\nenabled = false\n', 'c')), { code: 'subagents_disabled' });
  assert.throws(() => checkAgentsShape({ agents: 'x' }), { code: 'agents_not_table' });
});
