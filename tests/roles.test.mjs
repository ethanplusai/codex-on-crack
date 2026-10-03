import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeHome, FLASH, OPUS, ROLES_TOML, V1_ONLY } from './helpers.mjs';
import { describeModels, effectiveCatalog } from '../plugins/codex-on-crack/skills/crack/scripts/lib/catalog.mjs';
import {
  DEFAULT_ROLES, MARKER, agentFiles, parseCrackToml, renderAgentFile, renderCrackToml, reviewWarnings,
  validateRoles, workerContract,
} from '../plugins/codex-on-crack/skills/crack/scripts/lib/roles.mjs';
import { parseToml } from '../plugins/codex-on-crack/skills/crack/scripts/lib/toml.mjs';

function modelsFor(h) {
  const config = { model_catalog_json: 'catalog.json' };
  return describeModels(effectiveCatalog({ config, home: h.home, codexHome: h.codexHome }).entries);
}
const draft = (roles) => `schema_version = 1\n${roles}`;

test('validateRoles builds rungs with agent names and resolved efforts', (t) => {
  const { roles, warnings } = validateRoles(parseCrackToml(ROLES_TOML), modelsFor(makeHome(t)));
  assert.deepEqual(warnings, []);
  const builder = roles.find((r) => r.name === 'builder');
  assert.equal(builder.writes, true);
  assert.deepEqual(builder.rungs, [
    { kind: 'primary', agent: 'crack_builder', model: FLASH, effort: 'high' },
    { kind: 'fallback', agent: 'crack_builder_fallback', model: OPUS, effort: 'high' },
  ]);
  assert.equal(roles.find((r) => r.name === 'reviewer').writes, false);
});

test('validateRoles rejects unsupported effort rather than substituting it', (t) => {
  const text = draft(`[roles.builder]\nmodel = "${FLASH}"\nfallback = "${OPUS}"\neffort = "max"\nbrief = "b"\n`);
  assert.throws(() => validateRoles(parseCrackToml(text), modelsFor(makeHome(t))), /does not support effort/);
});

test('validateRoles defaults writes to false', (t) => {
  const { roles } = validateRoles(parseCrackToml(draft(`[roles.scout]\nmodel = "${FLASH}"\nbrief = "b"\n`)), modelsFor(makeHome(t)));
  assert.equal(roles[0].writes, false);
  assert.equal(roles[0].rungs.length, 1);
});

test('validateRoles rejects malformed roles with specific messages', (t) => {
  const models = modelsFor(makeHome(t));
  const bad = (text, code, pattern) => assert.throws(() => validateRoles(parseCrackToml(text), models),
    (e) => e.code === code && pattern.test(e.message));
  bad('[roles.a]\nmodel = "x"\nbrief = "b"\n', 'invalid_roles', /schema_version/);
  bad('schema_version = 1\n', 'invalid_roles', /at least one/);
  bad(draft(`[roles.Bad]\nmodel = "${FLASH}"\nbrief = "b"\n`), 'invalid_roles', /must match/);
  bad(draft(`[roles.x_fallback]\nmodel = "${FLASH}"\nbrief = "b"\n`), 'invalid_roles', /_fallback/);
  bad(draft(`[roles.a]\nmodle = "${FLASH}"\nbrief = "b"\n`), 'invalid_roles', /unknown key\(s\): modle/);
  bad(draft('[roles.a]\nbrief = "b"\n'), 'invalid_roles', /model is required/);
  bad(draft(`[roles.a]\nmodel = "${FLASH}"\nfallback = "${FLASH}"\nbrief = "b"\n`), 'invalid_roles', /must differ/);
  bad(draft(`[roles.a]\nmodel = "${FLASH}"\nwrites = "yes"\nbrief = "b"\n`), 'invalid_roles', /true or false/);
  bad(draft(`[roles.a]\nmodel = "${FLASH}"\n`), 'invalid_roles', /brief/);
  bad(draft(`[roles.a]\nmodel = "${V1_ONLY}"\nbrief = "b"\n`), 'model_ineligible', /not_subagent_capable/);
  bad(draft('[roles.a]\nmodel = "nobody/none"\nbrief = "b"\n'), 'model_not_in_catalog', /nobody\/none/);
});

test('renderCrackToml round-trips through validateRoles', (t) => {
  const models = modelsFor(makeHome(t));
  const { roles } = validateRoles(parseCrackToml(ROLES_TOML), models);
  const text = renderCrackToml(roles);
  assert.ok(text.startsWith(MARKER));
  assert.deepEqual(validateRoles(parseCrackToml(text), models).roles, roles);
});

test('renderAgentFile pins one model, disables recursion, and carries the contract and role', (t) => {
  const { roles } = validateRoles(parseCrackToml(ROLES_TOML), modelsFor(makeHome(t)));
  const builder = roles.find((r) => r.name === 'builder');
  const contract = workerContract();
  const primaryText = renderAgentFile({ role: builder, rung: builder.rungs[0], provider: null, contract });
  assert.ok(primaryText.startsWith(MARKER));
  const primary = parseToml(primaryText, 'a');
  assert.equal(primary.name, 'crack_builder');
  assert.equal(primary.model, FLASH);
  assert.equal(primary.model_reasoning_effort, 'high');
  assert.equal('model_provider' in primary, false);
  assert.deepEqual(primary.agents, { enabled: false });
  assert.ok(primary.developer_instructions.startsWith(contract.trim()));
  assert.match(primary.developer_instructions, /## Your role: builder/);
  const fallback = parseToml(renderAgentFile({ role: builder, rung: builder.rungs[1], provider: 'codex-router', contract }), 'b');
  assert.equal(fallback.model_provider, 'codex-router');
  assert.match(fallback.developer_instructions, /escalation rung/);
  const reviewer = roles.find((r) => r.name === 'reviewer');
  const readOnly = parseToml(renderAgentFile({ role: reviewer, rung: reviewer.rungs[0], provider: null, contract }), 'c');
  assert.match(readOnly.developer_instructions, /You are read-only/);
});

test('agentFiles maps each rung to its file and mirrors the router provider', (t) => {
  const h = makeHome(t);
  const { roles } = validateRoles(parseCrackToml(ROLES_TOML), modelsFor(h));
  const files = agentFiles({ codexHome: h.codexHome, roles });
  assert.deepEqual(files.map((f) => path.basename(f.file)),
    ['crack_builder.toml', 'crack_builder_fallback.toml', 'crack_reviewer.toml']);
  assert.deepEqual(files.map((f) => f.provider), [null, 'codex-router', 'codex-router']);
});

test('reviewWarnings flags a reviewer on the same model as the builder', () => {
  assert.equal(reviewWarnings([{ name: 'builder', model: 'm' }, { name: 'reviewer', model: 'm' }]).length, 1);
  assert.equal(reviewWarnings([{ name: 'builder', model: 'm' }, { name: 'reviewer', model: 'n' }]).length, 0);
  assert.equal(reviewWarnings([{ name: 'builder', model: 'm' }]).length, 0);
});

test('the worker contract is model-agnostic and DEFAULT_ROLES covers the five defaults', () => {
  assert.doesNotMatch(workerContract(), /Astra|Flash|DeepSeek/);
  assert.deepEqual(Object.keys(DEFAULT_ROLES), ['scout', 'builder', 'tester', 'reviewer', 'designer']);
  assert.deepEqual(Object.values(DEFAULT_ROLES).map((r) => r.writes), [false, true, true, false, true]);
});

test('optional task mappings round-trip without inferred strength ratings', (t) => {
  const models = modelsFor(makeHome(t));
  const doc = parseCrackToml(ROLES_TOML);
  doc.roles.builder.tasks = ['implementation', 'ui', 'tests'];
  doc.roles.reviewer.tasks = [];
  const first = validateRoles(doc, models).roles;
  assert.deepEqual(validateRoles(parseCrackToml(renderCrackToml(first)), models).roles, first);
  for (const tasks of ['ui', ['unknown'], ['ui', 'ui'], [1], null]) {
    doc.roles.builder.tasks = tasks;
    assert.throws(() => validateRoles(doc, models), { code: 'invalid_roles' });
  }
});
