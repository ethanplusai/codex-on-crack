import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, cli, makeHome } from './helpers.mjs';
import { pathsOverlap, validatePlan } from '../plugins/codex-on-crack/skills/crack/scripts/lib/plan.mjs';

const ROLES = new Map([
  ['builder', { writes: true }],
  ['tester', { writes: true }],
  ['scout', { writes: false }],
  ['reviewer', { writes: false }],
]);

function repo(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crack-plan-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'spec.md'), '# spec\n');
  fs.mkdirSync(path.join(root, 'tasks'));
  for (const id of ['T1', 'T2', 'T3', 'T4']) fs.writeFileSync(path.join(root, 'tasks', `${id}.md`), `# ${id}\n`);
  return root;
}
const check = [{ command: 'npm test', expected: 'passes' }];
const task = (id, extra = {}) => ({
  id, phase: 'P1', role: 'builder', risk: 'normal', state: 'planned', depends_on: [], brief: `tasks/${id}.md`,
  allowed_paths: [`src/${id}`], acceptance: ['works'], checks: check, ...extra,
});
const phase = (id, extra = {}) => ({ id, goal: 'ship it', depends_on: [], integration_checks: check, ...extra });
const plan = (tasks, extra = {}) => ({ schema_version: 2, project: 'demo', spec: 'spec.md', phases: [phase('P1')], tasks, ...extra });
const waves = (root, p) => validatePlan(p, root, ROLES).waves.map((w) => w.tasks);
const rejects = (root, p, pattern) => assert.throws(() => validatePlan(p, root, ROLES),
  (e) => e.code === 'plan_invalid' && pattern.test(e.message));

// A repository-relative plan fixture for the CLI tests: one task whose role can
// be swapped between the direct and delegated cases.
function cliRepo(t, role) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crack-cliplan-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'spec.md'), '# spec\n');
  fs.mkdirSync(path.join(root, 'tasks'));
  fs.writeFileSync(path.join(root, 'tasks', 'T1.md'), '# T1\n');
  const planPath = path.join(root, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify(plan([
    task('T1', { role, allowed_paths: ['src/a'] }),
  ])));
  return planPath;
}

function delegatedRepo(t) {
  const root = repo(t);
  fs.writeFileSync(path.join(root, 'tasks/T0.md'), '# Read-only discovery');
  const fixture = plan([
    task('T0', { role: 'scout', allowed_paths: [] }),
    task('T1', { depends_on: ['T0'] }),
  ]);
  const file = path.join(root, 'plan.json');
  fs.writeFileSync(file, JSON.stringify(fixture));
  return file;
}

test('pathsOverlap matches equal paths and ancestors only', () => {
  assert.equal(pathsOverlap('src', 'src/a'), true);
  assert.equal(pathsOverlap('src/a', 'src/a'), true);
  assert.equal(pathsOverlap('src/a', 'src/ab'), false);
});

test('writers with disjoint scopes share a wave and get worktrees', (t) => {
  const root = repo(t);
  const result = validatePlan(plan([task('T1'), task('T2')], { max_parallel_writers: 2 }), root, ROLES);
  assert.equal(result.status, 'structure-valid');
  assert.deepEqual(result.waves, [{ wave: 1, tasks: ['T1', 'T2'], writers: ['T1', 'T2'], worktrees: true }]);
});

test('overlapping writers and the writer cap split a level into sub-waves', (t) => {
  const root = repo(t);
  assert.deepEqual(waves(root, plan([task('T1', { allowed_paths: ['src'] }), task('T2', { allowed_paths: ['src/x'] })])), [['T1'], ['T2']]);
  assert.deepEqual(waves(root, plan([task('T1'), task('T2')], { max_parallel_writers: 1 })), [['T1'], ['T2']]);
});

test('readers join the first sub-wave and dependents wait for their level', (t) => {
  const root = repo(t);
  const result = validatePlan(plan([
    task('T1', { role: 'scout', allowed_paths: [] }),
    task('T2'),
    task('T3', { depends_on: ['T2'] }),
  ]), root, ROLES);
  assert.deepEqual(result.waves, [
    { wave: 1, tasks: ['T1', 'T2'], writers: ['T2'], worktrees: false },
    { wave: 2, tasks: ['T3'], writers: ['T3'], worktrees: false },
  ]);
});

test('a prerequisite phase orders tasks even without task dependencies', (t) => {
  const root = repo(t);
  const p = plan([task('T1'), task('T2', { phase: 'P2' })], { phases: [phase('P1'), phase('P2', { depends_on: ['P1'] })] });
  assert.deepEqual(waves(root, p), [['T1'], ['T2']]);
});

test('the orchestrator may own a sensitive task; other roles may not', (t) => {
  const root = repo(t);
  assert.equal(validatePlan(plan([task('T1', { role: 'orchestrator', risk: 'sensitive' })]), root, ROLES).tasks, 1);
  rejects(root, plan([task('T1', { risk: 'sensitive' })]), /stay with the orchestrator/);
});

test('validatePlan rejects role, scope, and state mistakes', (t) => {
  const root = repo(t);
  rejects(root, plan([task('T1', { role: 'wizard' })]), /not in crack\.toml/);
  rejects(root, plan([task('T1', { role: 'reviewer' })]), /read-only role/);
  rejects(root, plan([task('T1', { allowed_paths: [] })]), /needs allowed_paths/);
  rejects(root, plan([task('T1', { state: 'done' })]), /invalid state/);
  rejects(root, plan([task('T1', { rung: 'cheap' })]), /rung/);
  rejects(root, plan([task('T1', { review_cycles: -1 })]), /review_cycles/);
  rejects(root, plan([task('T1')], { max_parallel_writers: 9 }), /max_parallel_writers/);
});

test('validatePlan rejects unsafe paths, placeholders, missing briefs, cycles, and bad phase links', (t) => {
  const root = repo(t);
  rejects(root, plan([task('T1', { allowed_paths: ['src/*.js'] })]), /literal path/);
  rejects(root, plan([task('T1', { allowed_paths: ['../escape'] })]), /repository-relative/);
  rejects(root, plan([task('T1', { allowed_paths: ['.git/config'] })]), /repository-relative/);
  rejects(root, plan([task('T1', { acceptance: ['TODO later'] })]), /placeholder/);
  rejects(root, plan([task('T1', { brief: 'tasks/missing.md' })]), /existing document/);
  rejects(root, plan([task('T1', { depends_on: ['T2'] }), task('T2', { depends_on: ['T1'] })]), /cycle/);
  const crossPhase = plan([task('T1', { phase: 'P2' }), task('T2', { depends_on: ['T1'] })],
    { phases: [phase('P1'), phase('P2')] });
  rejects(root, crossPhase, /not declared as its prerequisite/);
  rejects(root, { ...plan([task('T1')]), schema_version: 1 }, /schema_version 2/);
});

test('validate-plan CLI checks a temporary fixture against a crack.toml', (t) => {
  const h = makeHome(t);
  const crack = h.write('crack/crack.toml', '# Managed by codex-on-crack.\nschema_version = 1\n[roles.scout]\nmodel = "m"\nwrites = false\nbrief = "s"\n[roles.builder]\nmodel = "m"\nwrites = true\nbrief = "b"\n');
  const example = delegatedRepo(t);
  const r = cli('validate-plan.mjs', [example, '--crack-toml', crack]);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.json.waves.map((w) => w.tasks), [['T0'], ['T1']]);
  const viaCodexHome = cli('validate-plan.mjs', [example, ...h.args]);
  assert.equal(viaCodexHome.status, 0, viaCodexHome.stdout);
  fs.rmSync(crack);
  const delegated = cli('validate-plan.mjs', [example, ...h.args]);
  assert.equal(delegated.json.error, 'plan_invalid');
  assert.match(delegated.json.message, /is not in crack\.toml/);
  assert.equal(cli('validate-plan.mjs', [...h.args]).json.error, 'usage');
});

test('validate-plan CLI runs a direct orchestrator-only plan with no roles configured', (t) => {
  const h = makeHome(t);
  assert.equal(h.exists('crack/crack.toml'), false);
  const r = cli('validate-plan.mjs', [cliRepo(t, 'orchestrator'), ...h.args]);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.json.waves.map((w) => w.tasks), [['T1']]);
});

test('validate-plan CLI fails a delegated plan with no roles configured and points at setup', (t) => {
  const h = makeHome(t);
  const r = cli('validate-plan.mjs', [cliRepo(t, 'builder'), ...h.args]);
  assert.equal(r.status, 2);
  assert.equal(r.json.error, 'plan_invalid');
  assert.match(r.json.message, /role "builder" is not in crack\.toml/);
  assert.match(r.json.hint, /orchestrator/);
  assert.match(r.json.hint, /crack-setup/);
});

// An explicitly named config is a statement that it exists: refuse to fall back
// to "no roles configured" when the path is missing or the file is malformed.
test('validate-plan CLI fails closed on an explicitly supplied missing config path', (t) => {
  const h = makeHome(t);
  const r = cli('validate-plan.mjs', [cliRepo(t, 'orchestrator'), '--crack-toml', path.join(h.home, 'nope.toml')]);
  assert.equal(r.status, 2);
  assert.equal(r.json.error, 'roles_missing');
});

test('validate-plan CLI fails closed on a malformed existing default config', (t) => {
  const h = makeHome(t);
  h.write('crack/crack.toml', 'schema_version = 1\n[roles.builder\nmodel = "x"\n');
  const r = cli('validate-plan.mjs', [cliRepo(t, 'orchestrator'), ...h.args]);
  assert.equal(r.status, 2);
  assert.equal(r.json.error, 'invalid_toml');
});

test('validate-plan CLI reads a plan and crack.toml reached through symlinked directories', (t) => {
  const h = makeHome(t);
  const crack = h.write('crack/crack.toml', '# Managed by codex-on-crack.\nschema_version = 1\n[roles.scout]\nmodel = "m"\nbrief = "s"\n[roles.builder]\nmodel = "m"\nwrites = true\nbrief = "b"\n');
  fs.symlinkSync(path.dirname(delegatedRepo(t)), path.join(h.home, 'fixture-link'));
  fs.symlinkSync(path.dirname(crack), path.join(h.home, 'crack-link'));
  const r = cli('validate-plan.mjs', [path.join(h.home, 'fixture-link', 'plan.json'),
    '--crack-toml', path.join(h.home, 'crack-link', 'crack.toml')]);
  assert.equal(r.status, 0, r.stdout);
});


test('parallelism is opt-in; omitted writer cap stays sequential', (t) => {
  const root=repo(t);
  assert.deepEqual(waves(root,plan([task('T1'),task('T2')])),[['T1'],['T2']]);
});
