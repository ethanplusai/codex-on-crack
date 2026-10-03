// The planning entry skill: recommendations come from local configured facts,
// the user keeps the choice, and nothing is written or called.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, ROLES_TOML, DEFAULT_CONFIG, OPUS, cli, makeHome } from './helpers.mjs';

const PLANNER = path.join(ROOT, 'plugins', 'codex-on-crack', 'skills', 'crack-plan', 'scripts', 'plan.mjs');

function plan(args = []) {
  const result = spawnSync(process.execPath, [PLANNER, ...args], { encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
}

const configured = (t, roles = ROLES_TOML, opts = {}) => {
  const home = makeHome(t, opts);
  const applied = cli('setup.mjs', ['apply', '--roles', home.write('draft.toml', roles), ...home.args]);
  assert.equal(applied.status, 0, applied.stdout);
  return home;
};

test('planning without configured roles keeps solo available and writes nothing', (t) => {
  const home = makeHome(t);
  const before = home.snapshot();
  const result = plan(['--home', home.home, '--codex-home', home.codexHome]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.json.status, 'workflow-only');
  assert.equal(result.json.ok, true, 'solo/direct work is still available');
  assert.equal(result.json.solo.available, true);
  assert.equal(result.json.delegated.ready, false);
  assert.ok(result.json.delegated.blocked.includes('no-roles-configured'));
  assert.ok(result.json.choice.required.some((c) => c.what === 'worker'));
  assert.equal(result.json.model_calls_made, false);
  assert.equal(result.json.inference_request_made, false);
  assert.deepEqual(home.snapshot(), before, 'planning must not write to the home');
});

test('one qualifying worker is recommended with a labelled reason', (t) => {
  const home = configured(t);
  const result = plan(['--task', 'implementation', '--home', home.home, '--codex-home', home.codexHome]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.json.status, 'plan-ready');
  assert.equal(result.json.ok, true);
  assert.deepEqual(result.json.worker.candidates.map((c) => c.role), ['builder']);
  assert.equal(result.json.worker.recommended.role, 'builder');
  assert.equal(result.json.worker.recommended.basis, 'qualitative-judgment-not-measured');
  assert.ok(result.json.worker.recommended.why.some((reason) => /explicitly includes/.test(reason)), JSON.stringify(result.json.worker.recommended));
  assert.equal(result.json.worker.choiceRequired, false);
  assert.equal(result.json.lead.source, 'user-selected');
  assert.equal(result.json.externalLead.model, 'claude-opus-5-5');
  assert.notEqual(result.json.lead.selected, result.json.externalLead.model, 'host model and external lead are distinct');
  assert.match(result.json.externalLead.note, /never receives Codex tools/);
});

test('several qualifying workers get a reasoned recommendation the user may override', (t) => {
  const twoBuilders = `${ROLES_TOML}
[roles.builder_two]
model = "${OPUS}"
writes = true
tasks = ["implementation", "tests"]
brief = "Second configured implementation worker."
`;
  const home = configured(t, twoBuilders);
  const result = plan(['--task', 'implementation', '--home', home.home, '--codex-home', home.codexHome]);
  assert.equal(result.json.worker.candidates.length, 2);
  assert.ok(result.json.worker.recommended, 'a recommendation is offered instead of nothing');
  assert.equal(result.json.worker.choiceRequired, true, 'the user can still choose');
  assert.equal(result.json.worker.recommended.qualitative, true);
  const detail = result.json.choice.required.find((c) => c.what === 'worker');
  assert.match(detail.detail, /reasoned recommendation/);
  assert.match(detail.detail, /choose differently/);
  assert.equal(result.json.status, 'plan-ready');
});

test('an explicit role or mode is honored without redundant confirmation', (t) => {
  const twoBuilders = `${ROLES_TOML}
[roles.builder_two]
model = "${OPUS}"
writes = true
tasks = ["implementation"]
brief = "Second configured implementation worker."
`;
  const home = configured(t, twoBuilders);
  const named = plan(['--task', 'implementation', '--role', 'builder_two', '--home', home.home, '--codex-home', home.codexHome]);
  assert.equal(named.json.worker.recommended.role, 'builder_two');
  assert.equal(named.json.worker.recommended.basis, 'user-requested');
  assert.equal(named.json.worker.choiceRequired, false, 'no redundant worker choice');
  assert.ok(named.json.choice.satisfied.some((c) => c.what === 'worker'));

  const solo = plan(['--task', 'implementation', '--mode', 'solo', '--home', home.home, '--codex-home', home.codexHome]);
  assert.equal(solo.json.mode, 'solo');
  assert.ok(solo.json.choice.satisfied.some((c) => c.what === 'mode'));
  assert.ok(!solo.json.choice.required.some((c) => c.what === 'worker'), 'solo needs no worker choice');
  assert.equal(solo.json.delegated.ready, false);

  const impossible = plan(['--task', 'implementation', '--role', 'reviewer', '--home', home.home, '--codex-home', home.codexHome]);
  assert.equal(impossible.json.worker.recommended, null, 'an unqualified named role is not substituted');
  assert.ok(impossible.json.delegated.blocked.includes('requested-role-does-not-qualify'));
});

test('no qualifying worker reports solo-only instead of a false plan-ready', (t) => {
  const home = configured(t);
  const result = plan(['--task', 'ui', '--home', home.home, '--codex-home', home.codexHome]);
  assert.equal(result.json.status, 'solo-only');
  assert.equal(result.json.ok, true, 'solo is still a valid way to proceed');
  assert.equal(result.json.delegated.ready, false);
  assert.ok(result.json.delegated.blocked.includes('no-worker-for-task'));
  assert.equal(result.json.worker.recommended, null);
  assert.ok(result.json.choice.required.some((c) => c.what === 'worker'));
});

test('blocking configuration problems make the plan not-ready', (t) => {
  const home = makeHome(t, { config: `${DEFAULT_CONFIG}\n[agents]\nenabled = false\n` });
  const soloOnly = plan(['--task', 'implementation', '--home', home.home, '--codex-home', home.codexHome]);
  assert.equal(soloOnly.json.status, 'workflow-only', 'the workflow still works; delegation does not');
  assert.ok(soloOnly.json.unavailable.some((u) => u.code === 'subagents_disabled'), JSON.stringify(soloOnly.json.unavailable));
  assert.ok(soloOnly.json.delegated.blocked.includes('subagents-disabled'));

  const broken = makeHome(t, { config: 'model = "x"\n[agents]\nname = "not-a-table"\n' });
  const notReady = plan(['--task', 'implementation', '--home', broken.home, '--codex-home', broken.codexHome]);
  assert.equal(notReady.json.status, 'not-ready');
  assert.equal(notReady.json.ok, false);
  assert.ok(notReady.json.unavailable.some((u) => u.code === 'agents_absorbed_keys'), JSON.stringify(notReady.json.unavailable));
});

test('planning describes tools and modes without unsupported claims', (t) => {
  const home = makeHome(t);
  const result = plan(['--home', home.home, '--codex-home', home.codexHome]);
  const text = JSON.stringify(result.json);
  assert.doesNotMatch(text, /save\s+\d+\s*%|savings of|quota\s*[:=]\s*\d|allowance\s*[:=]\s*\d|discount/i,
    'no savings, quota, or price claim is made');
  assert.match(text, /No allowance, quota, savings, or price claims/);
  assert.match(text, /qualitative judgement about fit, not a measured ranking/);
  const terminal = result.json.tools.find((tool) => tool.profile === 'terminal');
  assert.equal(terminal.optIn, true);
  assert.match(terminal.note, /not filesystem isolation/);
  assert.equal(result.json.tools.find((tool) => tool.profile === 'files').default, true);
  const external = result.json.modes.find((mode) => mode.id === 'external-lead');
  assert.match(external.requires, /official Claude Code CLI/);
  assert.match(external.requires, /quota is not observable/);
  assert.ok(result.json.unknown.some((entry) => /routing/i.test(entry)));
  assert.ok(result.json.limitations.some((entry) => /not provider access/.test(entry)));
});

test('planning rejects an unsupported task, mode, and minimum context', (t) => {
  const home = makeHome(t);
  const args = ['--home', home.home, '--codex-home', home.codexHome];
  assert.equal(plan(['--task', 'vibes', ...args]).json.error, 'usage');
  assert.equal(plan(['--mode', 'takeover', ...args]).json.error, 'usage');
  assert.equal(plan(['--min-context', '0', ...args]).json.error, 'usage');
});

test('the planning skill ships with valid frontmatter and metadata', () => {
  const dir = path.join(ROOT, 'plugins', 'codex-on-crack', 'skills', 'crack-plan');
  const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  assert.match(text, /^---\nname: crack-plan\n/);
  assert.match(text, /description: .{40,}/);
  const yaml = fs.readFileSync(path.join(dir, 'agents', 'openai.yaml'), 'utf8');
  assert.match(yaml, /display_name: "/);
  assert.match(yaml, /allow_implicit_invocation: true/);
  assert.doesNotMatch(text, /\bAstra\b|\bFlash\b|DeepSeek/);
  assert.match(text, /qualitative judgement about fit/);
});

test('an edited worker file never yields delegated readiness', (t) => {
  const home = configured(t);
  fs.appendFileSync(path.join(home.codexHome, 'agents', 'crack_builder.toml'), '# local edit\n');
  const result = plan(['--task', 'implementation', ...home.args]);
  assert.equal(result.json.delegated.ready, false);
  assert.equal(result.json.status, 'solo-only');
  assert.ok(result.json.delegated.blocked.includes('readiness-not-ready'));
});
