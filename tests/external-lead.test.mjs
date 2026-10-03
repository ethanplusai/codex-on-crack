// Deterministic tests for the optional external lead adapter. Every "claude"
// process here is a local mock; no test contacts a model, a provider, or the
// network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, SCRIPTS } from './helpers.mjs';
import {
  EXTERNAL_LEAD_MODEL, LEAD_FILE_TOOLS, RUN_MARKER,
  buildLeadArgs, buildLeadEnv, cancelRun, canonicalInside, canonicalPathSync, leadDoctor, runExternalLead, validateLeadConfig,
} from '../plugins/codex-on-crack/skills/crack/scripts/lib/external-lead.mjs';
import {
  hostActionEnvelope, isInsideRoot, normalizePath, toPublicEvent, usageDelta, usageProvenance,
  validateLeadRequest, validateLeadResult, validateWorkerResult,
} from '../plugins/codex-on-crack/skills/crack/scripts/lib/lead-protocol.mjs';

const LEAD = path.join(SCRIPTS, 'lead.mjs');
const PROMPT_BODY = 'Implement the approved bundle.\n';
// A fake value with no credential shape: the tests assert that credential-keyed
// environment variables are scrubbed, which does not depend on the value.
const SECRET = 'fake-test-value-not-a-credential-0123456789';
const WORKER_MODEL = 'deepseek/deepseek-v4.1-flash';

// One mock CLI covering the scenarios these tests need. It writes to stdout
// only; the runner decides what is true from that stream.
const FAKE_CLI = `#!/usr/bin/env node
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
const env = process.env;
const scenario = env.FAKE_SCENARIO || 'ok';
const mult = Number(env.FAKE_MULT || '1');
const list = (value) => (value ? value.split(',').map((s) => s.trim()).filter(Boolean) : []);
if (env.FAKE_COUNT_FILE) process.getBuiltinModule('node:fs').appendFileSync(env.FAKE_COUNT_FILE, 'x\\n');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'probe', args, prompt, resume, env: {
    apiKey: env.ANTHROPIC_API_KEY ?? null,
    authToken: env.ANTHROPIC_AUTH_TOKEN ?? null,
    baseUrl: env.ANTHROPIC_BASE_URL ?? null,
    oauth: env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
    deepseek: env.DEEPSEEK_KEY_FILE ?? null,
    maxOutput: env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? null,
    smallModel: env.ANTHROPIC_SMALL_FAST_MODEL ?? null,
  } });
  const scenarioModel = scenario === 'wrong-model' ? 'claude-sonnet-4-5' : scenario === 'not-logged-in' ? '<synthetic>' : model;
  const toolsArg = args[args.indexOf('--tools') + 1];
  const tools = [...(toolsArg ? toolsArg.split(',') : ['Read', 'Write', 'Edit', 'Glob', 'Grep']), ...list(env.FAKE_EXPOSE)];
  const apiKeySource = scenario === 'api-key' ? 'ANTHROPIC_API_KEY' : 'none';
  const cwd = scenario === 'cwd-mismatch' ? '/' : process.cwd();
  out({ type: 'system', subtype: 'init', cwd, session_id: 'sess-1', model: scenarioModel, tools, permissionMode: 'default', apiKeySource, claude_code_version: '9.9.9', uuid: 'u-init' });
  if (scenario === 'hang') { setInterval(() => {}, 1000); return; }
  if (scenario === 'not-logged-in') {
    out({ type: 'assistant', uuid: 'u-synth', timestamp: '2026-09-29T00:00:01Z', message: { id: 'msg_synth', model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in \\u00b7 Please run /login' }], usage: { input_tokens: 0, output_tokens: 0 } } });
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Not logged in \\u00b7 Please run /login', session_id: 'sess-1', duration_ms: 5, num_turns: 1, permission_denials: [] });
    process.exit(0);
  }
  if (scenario === 'login-prose') {
    out({ type: 'assistant', uuid: 'u-prose', timestamp: '2026-09-29T00:00:01Z', message: { id: 'msg_prose', model, content: [{ type: 'text', text: 'Note for the report: a new user is not logged in until they run /login in the official client.' }], usage: { input_tokens: 1, output_tokens: 1 } } });
    out({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', duration_ms: 5, num_turns: 1, total_cost_usd: 0.1, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { [model]: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.1 } }, permission_denials: [] });
    process.exit(0);
  }
  if (scenario === 'wrong-model-auth') {
    out({ type: 'assistant', uuid: 'u-mix', timestamp: '2026-09-29T00:00:01Z', message: { id: 'msg_mix', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'Not logged in \u00b7 Please run /login' }], usage: { input_tokens: 1, output_tokens: 1 } } });
    out({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-1', duration_ms: 5, num_turns: 1, total_cost_usd: 0.1, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { 'claude-sonnet-4-5': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.1 } }, permission_denials: [] });
    process.exit(0);
  }
  const usage = { input_tokens: 3 * mult, output_tokens: 2 * mult, cache_read_input_tokens: 100 * mult, cache_creation_input_tokens: 50 * mult };
  const calls = list(env.FAKE_CALLS);
  if (env.FAKE_ESCAPE === '1') calls.push('Read');
  const content = [{ type: 'text', text: 'PRIVATE_TRANSCRIPT_BODY' }];
  calls.forEach((name, index) => {
    const input = name === 'Bash'
      ? { command: 'cd .. && ls ../outside && grep -n needle ../../etc/hosts' }
      : (name === 'Read' && env.FAKE_ESCAPE === '1') ? { file_path: '/etc/passwd' } : { path: 'notes.txt' };
    content.push({ type: 'tool_use', id: 'tu_' + (index + 1), name, input });
  });
  const stamp = env.FAKE_NO_TIMESTAMP === '1' ? {} : { timestamp: '2026-09-29T00:00:01Z' };
  const assistant = { type: 'assistant', uuid: 'u-a1', ...stamp, message: { id: 'msg_1', model: scenarioModel, content, usage } };
  out(assistant);
  if (scenario === 'duplicate') out({ ...assistant, uuid: 'u-a1-duplicate' });
  if (scenario === 'duplicate-record') out(assistant);
  calls.forEach((name, index) => {
    out({ type: 'user', uuid: 'u-u' + (index + 1), ...stamp, message: { content: [{ type: 'tool_result', tool_use_id: 'tu_' + (index + 1), is_error: env.FAKE_TOOL_ERROR === '1', content: 'private tool output' }] } });
  });
  if (scenario === 'no-result') process.exit(0);
  const deniedTool = env.FAKE_DENY || (scenario === 'denied' ? 'Write' : null);
  out({ type: 'result', subtype: scenario === 'error' ? 'error_during_execution' : 'success', is_error: scenario === 'error', duration_ms: 1200, duration_api_ms: 900, num_turns: 2, session_id: 'sess-1', total_cost_usd: 0.12, usage: { input_tokens: 3 * mult, output_tokens: 40 * mult }, modelUsage: { [scenarioModel]: { inputTokens: 3 * mult, outputTokens: 40 * mult, cacheReadInputTokens: 100 * mult, cacheCreationInputTokens: 50 * mult, costUSD: 0.12 } }, permission_denials: deniedTool ? [{ tool_name: deniedTool, tool_use_id: 'tu_9' }] : [] });
  process.exit(scenario === 'error' ? 1 : 0);
});
`;

async function fixture(t, { scenario = 'ok', mult = 1, env = {}, requestOverrides = {} } = {}) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'external-lead-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'work');
  await fsp.mkdir(workspace);
  const claudeBin = path.join(root, 'fake-claude');
  await fsp.writeFile(claudeBin, FAKE_CLI, { mode: 0o755 });
  const prompt = path.join(root, 'prompt.txt');
  await fsp.writeFile(prompt, PROMPT_BODY);
  const requestFile = path.join(root, 'request.json');
  await fsp.writeFile(requestFile, `${JSON.stringify(request(requestOverrides, workspace), null, 2)}\n`);
  const baseEnv = {
    ...process.env,
    FAKE_SCENARIO: scenario,
    FAKE_MULT: String(mult),
    FAKE_SECRET: SECRET,
    ANTHROPIC_API_KEY: SECRET,
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999',
    ANTHROPIC_AUTH_TOKEN: SECRET,
    CLAUDE_CODE_OAUTH_TOKEN: SECRET,
    DEEPSEEK_KEY_FILE: '/tmp/deepseek.key',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '4096',
    ...env,
  };
  return { root, workspace, claudeBin, prompt, requestFile, baseEnv };
}

function request(overrides = {}, workspace = '/tmp/workspace') {
  return {
    schemaVersion: 1,
    requestId: 'req-1',
    runId: 'run-1',
    phase: 'phase-1',
    kind: 'worker_assignment',
    agentId: 'lead-1',
    parentAgentId: 'host-1',
    objective: 'Implement the approved external lead adapter bundle end to end.',
    workspace,
    acceptanceChecks: ['npm test passes', 'release check passes'],
    role: 'builder',
    budget: { authorized: true, usd: 30 },
    lead: { id: 'lead-1', model: EXTERNAL_LEAD_MODEL, route: 'subscription' },
    assignment: { role: 'builder', brief: 'Own implementation and verification for the bounded bundle.' },
    ...overrides,
  };
}

function cli(args, { cwd = ROOT, env = {} } = {}) {
  const result = spawnSync(process.execPath, [LEAD, ...args], { encoding: 'utf8', cwd, env: { ...process.env, ...env } });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
}

const run = (fx, out, extra = {}) => runExternalLead({
  workspace: fx.workspace,
  promptFile: fx.prompt,
  outDir: out,
  claudeBin: fx.claudeBin,
  baseEnv: fx.baseEnv,
  run: { runId: 'run-1', agentId: 'lead-1', parentAgentId: 'host-1', requestId: 'req-1', phase: 'phase-1' },
  ...extra,
});

const readEvents = (out, name = 'events.jsonl') => fs.readFileSync(path.join(out, name), 'utf8')
  .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

test('lead args fix the model and tool profile, and refuse anything else', () => {
  const args = buildLeadArgs({ model: EXTERNAL_LEAD_MODEL });
  assert.ok(args.includes('--safe-mode'));
  assert.equal(args[args.indexOf('--model') + 1], EXTERNAL_LEAD_MODEL);
  assert.equal(args[args.indexOf('--tools') + 1], LEAD_FILE_TOOLS.join(','));
  assert.equal(args[args.indexOf('--allowedTools') + 1], LEAD_FILE_TOOLS.join(','));
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.ok(args.includes('--strict-mcp-config'));
  for (const forbidden of ['--bare', '--dangerously-skip-permissions', '--permission-mode', '--add-dir', '--settings']) {
    assert.ok(!args.includes(forbidden), `${forbidden} must never be passed`);
  }
  assert.throws(() => buildLeadArgs({ model: 'claude-sonnet-4-5' }), /exactly claude-opus-5-5/);
  assert.throws(() => buildLeadArgs({ model: EXTERNAL_LEAD_MODEL, resume: '../escape' }), /--resume must be a session id/);
  assert.throws(() => buildLeadArgs({ model: EXTERNAL_LEAD_MODEL, mcpConfig: 'relative.json', mcpAllowedTools: ['mcp__browser'] }), /absolute path/);
  assert.throws(() => buildLeadArgs({ model: EXTERNAL_LEAD_MODEL, mcpConfig: '/tmp/m.json', mcpAllowedTools: ['Read'] }), /MCP tool names/);
  const withMcp = buildLeadArgs({ model: EXTERNAL_LEAD_MODEL, mcpConfig: '/tmp/m.json', mcpAllowedTools: ['mcp__browser'] });
  assert.ok(!withMcp.includes('--safe-mode'), 'an explicit MCP config keeps the reviewed server enabled');
  assert.equal(withMcp[withMcp.indexOf('--allowedTools') + 1], `${LEAD_FILE_TOOLS.join(',')},mcp__browser`);
});

test('lead env scrubs credential overrides and copies no secret value', () => {
  const env = buildLeadEnv({
    baseEnv: {
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      ANTHROPIC_API_KEY: SECRET,
      ANTHROPIC_AUTH_TOKEN: SECRET,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9999',
      CLAUDE_CODE_OAUTH_TOKEN: SECRET,
      CLAUDE_CODE_USE_BEDROCK: '1',
      DEEPSEEK_KEY_FILE: '/tmp/deepseek.key',
      OPENAI_API_KEY: SECRET,
    },
    model: EXTERNAL_LEAD_MODEL,
  });
  assert.ok(!JSON.stringify(env).includes(SECRET), 'no credential value may be carried into the child environment');
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'DEEPSEEK_KEY_FILE', 'OPENAI_API_KEY']) {
    assert.ok(!(key in env), `${key} must be removed`);
  }
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, EXTERNAL_LEAD_MODEL);
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, EXTERNAL_LEAD_MODEL);
  assert.throws(() => buildLeadEnv({ baseEnv: {}, model: 'claude-sonnet-4-5' }), /unsupported model/);
});

test('doctor reports missing dependencies as unavailable and never as verified', async (t) => {
  const missing = leadDoctor({ baseEnv: { PATH: '' } });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.runtime_verified, false);
  assert.equal(missing.model_calls_made, false);
  assert.equal(missing.ready, false);
  assert.ok(missing.problems.some((p) => p.code === 'claude_unavailable'));

  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'external-lead-path-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  const found = leadDoctor({ baseEnv: { PATH: root } });
  assert.equal(found.status, 'unknown');
  assert.equal(found.ready, false);
  assert.equal(found.runtime_verified, false);
  assert.ok(found.dependencies.find((d) => d.name === 'claude').status === 'available-unverified');
  assert.ok(found.capabilities.every((c) => c.status === 'unknown'));
});

test('config validation is non-spending and rejects an off-profile lead', () => {
  const good = validateLeadConfig({
    schemaVersion: 1,
    mode: 'external-lead',
    lead: { model: EXTERNAL_LEAD_MODEL },
    workspace: '/tmp/work',
    budget: { authorized: true, usd: 30 },
  });
  assert.equal(good.ok, true, good.problems.join('; '));
  assert.equal(good.model_calls_made, false);
  assert.equal(good.runtime_verified, false);
  assert.equal(good.resolved.args[good.resolved.args.indexOf('--model') + 1], EXTERNAL_LEAD_MODEL);
  assert.ok(!good.resolved.args.includes('--bare'));

  const wrongModel = validateLeadConfig({ schemaVersion: 1, lead: { model: 'gpt-6-astra' }, workspace: '/tmp/work', budget: { authorized: true, usd: 1 } });
  assert.equal(wrongModel.ok, false);
  const badMode = validateLeadConfig({ schemaVersion: 1, mode: 'takeover', lead: { model: EXTERNAL_LEAD_MODEL }, workspace: '/tmp/work', budget: { authorized: true, usd: 1 } });
  assert.equal(badMode.ok, false);
  const noBudget = validateLeadConfig({ schemaVersion: 1, lead: { model: EXTERNAL_LEAD_MODEL }, workspace: '/tmp/work' });
  assert.equal(noBudget.ok, false);
  assert.ok(noBudget.problems.some((p) => /budget/.test(p)));
  const extraTool = validateLeadConfig({ schemaVersion: 1, lead: { model: EXTERNAL_LEAD_MODEL }, workspace: '/tmp/work', budget: { authorized: true, usd: 1 }, tools: ['Read', 'Bash'] });
  assert.equal(extraTool.ok, false);
  assert.ok(extraTool.problems.some((p) => /allowlist/.test(p)));
});

test('path normalisation rejects traversal and relative roots', () => {
  assert.equal(normalizePath('/approved/../outside'), '/outside');
  assert.equal(normalizePath('/approved/./sub//x'), '/approved/sub/x');
  assert.equal(normalizePath('/approved/../../etc'), null, 'climbing above the root is rejected');
  assert.equal(normalizePath('relative/path'), null);
  assert.equal(isInsideRoot('/approved', '/approved'), true);
  assert.equal(isInsideRoot('/approved', '/approved/sub'), true);
  assert.equal(isInsideRoot('/approved', '/approved/../outside'), false);
  assert.equal(isInsideRoot('/approved', '/approvedness'), false, 'prefix siblings are not inside');
  assert.equal(isInsideRoot('/', '/anything'), true);

  const workspace = '/approved';
  for (const [label, doc] of [
    ['workspace traversal', request({ workspace: '/approved/../outside' }, workspace)],
    ['workspace above root', request({ workspace: '/approved/../../etc' }, workspace)],
    ['path traversal', request({ paths: ['/approved/../outside/secret'] }, workspace)],
    ['relative workspace', request({ workspace: 'approved' }, workspace)],
  ]) {
    const result = validateLeadRequest(doc, { workspace });
    assert.equal(result.ok, false, `${label} must be rejected`);
  }
  const dotted = validateLeadRequest(request({ workspace: '/approved/./sub' }, workspace), { workspace });
  assert.equal(dotted.ok, true, dotted.problems.join('; '));
  assert.equal(dotted.request.workspace, '/approved/sub');
});

test('CLI canonicalises symlink ancestors for the workspace scope', async (t) => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'external-lead-scope-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = path.join(root, 'scope');
  const outside = path.join(root, 'outside');
  await fsp.mkdir(scope);
  await fsp.mkdir(outside);
  fs.symlinkSync(outside, path.join(scope, 'link'));
  assert.equal(canonicalPathSync(path.join(scope, 'link')), await fsp.realpath(outside));
  assert.equal(canonicalInside(scope, path.join(scope, 'link')), false, 'a symlink out of scope is not inside it');
  assert.equal(canonicalInside(scope, path.join(scope, 'not-created-yet')), true, 'a nonexistent leaf inside scope stays inside');

  const escaping = path.join(root, 'escape.json');
  await fsp.writeFile(escaping, JSON.stringify(request({ workspace: path.join(scope, 'link') }, path.join(scope, 'link'))));
  const rejected = cli(['request', '--file', escaping, '--workspace', scope]);
  assert.equal(rejected.status, 2);
  assert.equal(rejected.json.status, 'rejected');
  assert.ok(rejected.json.problems.some((p) => /outside the permitted workspace/.test(p)), JSON.stringify(rejected.json.problems));

  const nested = path.join(root, 'nested.json');
  await fsp.writeFile(nested, JSON.stringify(request({ workspace: path.join(scope, 'later', 'dir') }, path.join(scope, 'later', 'dir'))));
  const accepted = cli(['request', '--file', nested, '--workspace', scope]);
  assert.equal(accepted.status, 0, accepted.stdout);
  assert.equal(accepted.json.ok, true);
});

test('request validation rejects malformed, unauthorised, and out-of-scope documents', () => {
  const workspace = '/tmp/permitted';
  const valid = validateLeadRequest(request({}, workspace), { workspace });
  assert.equal(valid.ok, true, valid.problems.join('; '));
  assert.equal(hostActionEnvelope(valid.request).executed, false);

  const cases = [
    ['wrong kind', request({ kind: 'takeover' }, workspace), /kind must be one of/],
    ['missing budget', request({ budget: undefined }, workspace), /budget is required/],
    ['budget not authorised', request({ budget: { authorized: false, usd: 5 } }, workspace), /authorized must be true/],
    ['wrong model', request({ lead: { id: 'lead-1', model: 'gpt-6-astra' } }, workspace), /exactly claude-opus-5-5/],
    ['outside workspace', request({ workspace: '/tmp/elsewhere' }, workspace), /outside the permitted workspace/],
    ['path escape', request({ paths: ['/etc/passwd'] }, workspace), /outside the permitted workspace/],
    ['no acceptance', request({ acceptanceChecks: [] }, workspace), /acceptanceChecks/],
    ['smuggled command', { ...request({}, workspace), command: 'rm -rf /' }, /may not carry executable actions/],
    ['unknown key', { ...request({}, workspace), shell: 'true' }, /may not carry executable actions/],
    ['missing ids', request({ requestId: 'not a valid id!' }, workspace), /requestId must be an identifier/],
  ];
  for (const [label, doc, pattern] of cases) {
    const result = validateLeadRequest(doc, { workspace });
    assert.equal(result.ok, false, `${label} must be rejected`);
    assert.ok(result.problems.some((p) => pattern.test(p)), `${label}: expected ${pattern} in ${JSON.stringify(result.problems)}`);
  }

  const solo = validateLeadRequest(request({}, workspace), { workspace, mode: 'solo' });
  assert.equal(solo.ok, false);
  assert.ok(solo.problems.some((p) => /solo mode/.test(p)));
  const soloClarify = validateLeadRequest(request({
    kind: 'clarification', question: 'Is the scope right?', assignment: undefined,
  }, workspace), { workspace, mode: 'solo' });
  assert.equal(soloClarify.ok, true, soloClarify.problems.join('; '));
  assert.match(hostActionEnvelope(soloClarify.request, { mode: 'solo' }).instructions, /external lead performs the implementation/);
  const noRoleClarify = validateLeadRequest(request({
    kind: 'clarification', question: 'Is the scope right?', assignment: undefined, role: undefined,
  }, workspace), { workspace });
  assert.equal(noRoleClarify.ok, true, noRoleClarify.problems.join('; '));
  const missingRoleAssignment = validateLeadRequest(request({ role: undefined }, workspace), { workspace });
  assert.equal(missingRoleAssignment.ok, false, 'a worker assignment still needs a role');
});

test('the request command validates and never executes lead-authored actions', async (t) => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'external-lead-cli-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, 'executed.txt');
  const file = path.join(root, 'request.json');
  await fsp.writeFile(file, JSON.stringify({ ...request({}, root), command: `touch ${marker}` }));
  const rejected = cli(['request', '--file', file, '--workspace', root]);
  assert.equal(rejected.status, 2);
  assert.equal(rejected.json.status, 'rejected');
  assert.equal(rejected.json.executed, false);
  assert.equal(fs.existsSync(marker), false, 'a request document must never cause shell execution');

  await fsp.writeFile(file, JSON.stringify(request({}, root)));
  const validated = cli(['request', '--file', file, '--workspace', root, '--events', path.join(root, 'events.jsonl')]);
  assert.equal(validated.status, 0, validated.stdout);
  assert.equal(validated.json.ok, true);
  assert.equal(validated.json.executed, false);
  assert.equal(validated.json.requires_host_action, true);
  assert.equal(validated.json.executor, 'codex-host');
  const events = fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'request.validated');
  assert.equal(events[0].status, 'pending');
  assert.ok(!fs.readFileSync(path.join(root, 'events.public.jsonl'), 'utf8').includes('Implement the approved'));
});

test('run refuses an unauthorised or solo-invalid request before spawning', async (t) => {
  const fx = await fixture(t);
  const countFile = path.join(fx.root, 'count.txt');
  fx.baseEnv.FAKE_COUNT_FILE = countFile;
  const unauthorised = path.join(fx.root, 'unauthorised.json');
  await fsp.writeFile(unauthorised, JSON.stringify(request({ budget: { authorized: false, usd: 0 } }, fx.workspace)));
  const out = path.join(fx.root, 'run-rejected');
  const result = cli(['run', '--request', unauthorised, '--prompt', fx.prompt, '--out', out, '--claude-bin', fx.claudeBin], { env: fx.baseEnv });
  assert.equal(result.status, 2);
  assert.equal(result.json.status, 'rejected');
  assert.equal(fs.existsSync(out), false, 'a rejected request must not create a run directory');
  assert.equal(fs.existsSync(countFile), false, 'the lead client must never be spawned for a rejected request');

  const solo = cli(['run', '--request', fx.requestFile, '--prompt', fx.prompt, '--out', path.join(fx.root, 'run-solo'), '--mode', 'solo', '--claude-bin', fx.claudeBin], { env: fx.baseEnv });
  assert.equal(solo.status, 2);
  assert.ok(solo.json.problems.some((p) => /solo mode/.test(p)), JSON.stringify(solo.json.problems));
});

test('a successful run writes private captures and a uniform public replay', async (t) => {
  const fx = await fixture(t, { env: { FAKE_CALLS: 'Read' } });
  const out = path.join(fx.root, 'run1');
  const summary = await run(fx, out);
  assert.equal(summary.ok, true, summary.errors.join('; '));
  assert.equal(summary.route, 'subscription');
  assert.equal(summary.fallbackUsed, false);
  assert.equal(summary.observedModels.init, EXTERNAL_LEAD_MODEL);
  assert.equal(summary.usage.billing, 'not-billed-via-api');
  assert.equal(summary.usage.billedUsd, null);
  assert.equal(summary.usage.equivalentUsd, 0.12);
  assert.equal(summary.usage.accountQuota, null);

  for (const file of ['stdout.jsonl', 'stderr.log', 'summary.json', 'pid.json', 'run.json', 'events.jsonl']) {
    const mode = fs.statSync(path.join(out, file)).mode & 0o777;
    assert.equal(mode, 0o600, `${file} must be private (0600), saw ${mode.toString(8)}`);
  }
  const raw = fs.readFileSync(path.join(out, 'stdout.jsonl'), 'utf8');
  assert.ok(raw.includes('PRIVATE_TRANSCRIPT_BODY'), 'the raw capture keeps the private transcript');
  const publicText = fs.readFileSync(path.join(out, 'events.public.jsonl'), 'utf8');
  assert.ok(!publicText.includes('PRIVATE_TRANSCRIPT_BODY'), 'the public replay must omit transcript bodies');
  assert.ok(!publicText.includes('private tool output'), 'tool results stay out of the public replay');
  assert.ok(!publicText.includes(SECRET), 'a credential value never reaches the shareable trail');

  const events = readEvents(out);
  for (const event of events) {
    for (const field of ['runId', 'agentId', 'type', 'requestId', 'phase', 'route', 'invocationId']) assert.ok(field in event, `event needs ${field}`);
    assert.ok(typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)), `event ${event.type} needs a real timestamp`);
    assert.ok(['stream', 'receive-time'].includes(event.atSource), `event ${event.type} needs timestamp provenance`);
    assert.ok(typeof event.eventId === 'string' && event.eventId.length > 8);
  }
  const finished = events.filter((e) => e.type === 'tool.finished');
  assert.equal(finished.length, 1, 'a successful tool call still gets a terminal event');
  assert.equal(finished[0].status, 'completed');
  assert.equal(finished[0].data.isError, false);
  const usageEvents = events.filter((e) => e.type === 'usage.recorded');
  assert.deepEqual(usageEvents.map((e) => e.data.usageScope).sort(), ['message', 'session']);
  const session = usageEvents.find((e) => e.data.usageScope === 'session');
  assert.equal(session.data.cumulative, true);
  assert.equal(session.data.countsAreCumulative, true);
  assert.equal(session.data.delta, null, 'a first run has no resume delta');

  const probe = JSON.parse(raw.split('\n')[0]);
  assert.equal(probe.prompt, PROMPT_BODY);
  assert.equal(probe.resume, null);
  for (const key of ['apiKey', 'authToken', 'baseUrl', 'oauth', 'deepseek']) assert.equal(probe.env[key], null, `${key} must be scrubbed`);
  assert.equal(probe.env.smallModel, EXTERNAL_LEAD_MODEL);
});

test('events are appended while the run is still in flight', async (t) => {
  const fx = await fixture(t, { scenario: 'hang' });
  const out = path.join(fx.root, 'run-live');
  const child = spawn(process.execPath, [
    LEAD, 'run', '--request', fx.requestFile, '--prompt', fx.prompt, '--out', out, '--claude-bin', fx.claudeBin,
  ], { env: fx.baseEnv, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  await waitFor(() => fs.existsSync(path.join(out, 'pid.json')));
  await waitFor(() => fs.existsSync(path.join(out, 'events.jsonl')) && readEvents(out).length >= 2);
  const inFlight = readEvents(out);
  assert.ok(inFlight.some((e) => e.type === 'agent.started'), 'lifecycle events exist before completion');
  assert.equal(fs.existsSync(path.join(out, 'summary.json')), false, 'the run is still in flight');
  const stopped = await cancelRun({ runDir: out });
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  await waitFor(() => fs.existsSync(path.join(out, 'summary.json')));
});

test('identity mismatch, unexpected route, denied tools, and extras all fail closed', async (t) => {
  const cases = [
    ['wrong-model', {}, /observed model\(s\) other than/],
    ['api-key', {}, /expected the subscription login/],
    ['denied', {}, /required tool permission\(s\) denied/],
    ['ok', { FAKE_EXPOSE: 'Bash' }, /unexpected tools exposed/],
    ['ok', { FAKE_ESCAPE: '1' }, /outside the workspace/],
    ['cwd-mismatch', {}, /cwd differs from the requested workspace/],
    ['error', {}, /result reported error_during_execution/],
    ['no-result', {}, /no result record/],
  ];
  let index = 0;
  for (const [scenario, env, pattern] of cases) {
    index += 1;
    const fx = await fixture(t, { scenario, env });
    const summary = await run(fx, path.join(fx.root, `run-case-${index}`));
    assert.equal(summary.ok, false, `${scenario} must not report success`);
    assert.ok(summary.errors.some((e) => pattern.test(e)), `${scenario}: expected ${pattern} in ${JSON.stringify(summary.errors)}`);
  }
});

test('MCP tools are compared against the explicit configured allowlist', async (t) => {
  const mcpFile = async (fx) => {
    const file = path.join(fx.root, 'mcp.json');
    await fsp.writeFile(file, JSON.stringify({ mcpServers: { browser: { command: 'true' } } }));
    return file;
  };

  const exposed = await fixture(t, { env: { FAKE_EXPOSE: 'mcp__browser' } });
  const exposedSummary = await run(exposed, path.join(exposed.root, 'run-exposed'), { mcpConfig: await mcpFile(exposed), mcpAllowedTools: [] });
  assert.equal(exposedSummary.ok, false);
  assert.ok(exposedSummary.errors.some((e) => /MCP tool\(s\) exposed outside the configured allowlist/.test(e)), exposedSummary.errors.join('; '));

  const called = await fixture(t, { env: { FAKE_CALLS: 'mcp__evil' } });
  const calledSummary = await run(called, path.join(called.root, 'run-called'), { mcpConfig: await mcpFile(called), mcpAllowedTools: ['mcp__browser'] });
  assert.equal(calledSummary.ok, false);
  assert.ok(calledSummary.errors.some((e) => /MCP tool\(s\) called outside the configured allowlist/.test(e)), calledSummary.errors.join('; '));

  const missing = await fixture(t);
  const missingSummary = await run(missing, path.join(missing.root, 'run-missing'), { mcpConfig: await mcpFile(missing), mcpAllowedTools: ['mcp__browser'] });
  assert.equal(missingSummary.ok, false);
  assert.ok(missingSummary.errors.some((e) => /required MCP tool\(s\) were not exposed/.test(e)), missingSummary.errors.join('; '));

  const allowed = await fixture(t, { env: { FAKE_EXPOSE: 'mcp__browser', FAKE_CALLS: 'mcp__browser' } });
  const allowedSummary = await run(allowed, path.join(allowed.root, 'run-allowed'), { mcpConfig: await mcpFile(allowed), mcpAllowedTools: ['mcp__browser'] });
  assert.equal(allowedSummary.ok, true, allowedSummary.errors.join('; '));
  assert.deepEqual(allowedSummary.configuredMcpTools, ['mcp__browser']);
  const runProfile = JSON.parse(fs.readFileSync(path.join(allowed.root, 'run-allowed', 'run.json'), 'utf8'));
  assert.deepEqual(runProfile.requiredMcpTools, ['mcp__browser']);
  assert.deepEqual(runProfile.mcpAllowedTools, ['mcp__browser']);
});

test('duplicate stream records are ignored instead of double-counted', async (t) => {
  const fx = await fixture(t, { scenario: 'duplicate' });
  const summary = await run(fx, path.join(fx.root, 'run-duplicate'));
  assert.equal(summary.ok, true, summary.errors.join('; '));
  assert.equal(summary.stream.duplicateAssistantRecords, 1);
  assert.equal(summary.stream.duplicateRecords, 0);
  assert.equal(summary.stream.assistantMessages, 1);
  assert.equal(summary.provisionalMessageUsage.messages, 1);

  const repeated = await fixture(t, { scenario: 'duplicate-record' });
  const repeatedSummary = await run(repeated, path.join(repeated.root, 'run-duplicate-record'));
  assert.equal(repeatedSummary.ok, true, repeatedSummary.errors.join('; '));
  assert.equal(repeatedSummary.stream.duplicateRecords, 1);
  assert.equal(repeatedSummary.stream.assistantMessages, 1);
});

test('receive-time fallback timestamps are labelled instead of left null', async (t) => {
  const fx = await fixture(t, { env: { FAKE_NO_TIMESTAMP: '1', FAKE_CALLS: 'Read' } });
  const out = path.join(fx.root, 'run-no-timestamps');
  const summary = await run(fx, out);
  assert.equal(summary.ok, true, summary.errors.join('; '));
  const events = readEvents(out);
  assert.equal(events.filter((e) => e.atSource === 'stream').length, 0, 'the mock sent no stream timestamps');
  for (const event of events) {
    assert.ok(typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)), `${event.type} needs a fallback timestamp`);
    assert.equal(event.atSource, 'receive-time');
  }
});

test('event ids are unique per invocation of the same run and agent', async (t) => {
  const fx = await fixture(t);
  const first = path.join(fx.root, 'run-id-1');
  const second = path.join(fx.root, 'run-id-2');
  await run(fx, first);
  await run(fx, second);
  const ids = (out) => readEvents(out).map((e) => e.eventId);
  const a = ids(first);
  const b = ids(second);
  assert.equal(new Set(a).size, a.length, 'ids are unique inside one invocation');
  assert.equal(new Set(b).size, b.length);
  assert.deepEqual([...new Set(a)].filter((id) => b.includes(id)), [], 'a resumed invocation must not reuse the previous invocation event ids');
});

test('the terminal tool profile is opt-in and adds only Bash', () => {
  const files = buildLeadArgs({ model: EXTERNAL_LEAD_MODEL });
  assert.equal(files[files.indexOf('--tools') + 1], LEAD_FILE_TOOLS.join(','), 'the default profile is unchanged');
  assert.ok(!files.includes('Bash'));

  const terminal = buildLeadArgs({ model: EXTERNAL_LEAD_MODEL, toolProfile: 'terminal' });
  const expected = [...LEAD_FILE_TOOLS, 'Bash'].join(',');
  assert.equal(terminal[terminal.indexOf('--tools') + 1], expected);
  assert.equal(terminal[terminal.indexOf('--allowedTools') + 1], expected);
  assert.ok(terminal.includes('--restricted'));
  assert.equal(terminal[terminal.indexOf('--setting-sources') + 1], '');
  for (const forbidden of ['--bare', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode', '--add-dir', '--settings']) {
    assert.ok(!terminal.includes(forbidden), `${forbidden} must never be passed, even with Bash`);
  }
  assert.throws(() => buildLeadArgs({ model: EXTERNAL_LEAD_MODEL, toolProfile: 'unleashed' }), /--tool-profile must be one of/);

  const both = buildLeadArgs({ model: EXTERNAL_LEAD_MODEL, toolProfile: 'terminal', mcpConfig: '/tmp/m.json', mcpAllowedTools: ['mcp__browser'] });
  assert.equal(both[both.indexOf('--allowedTools') + 1], `${expected},mcp__browser`);
  assert.ok(!both.includes('--safe-mode'), 'an explicit MCP config still disables safe mode only for the reviewed server');
});

test('a files-only run stays files-only and a terminal run records its profile', async (t) => {
  const files = await fixture(t, { env: { FAKE_CALLS: 'Read' } });
  const filesOut = path.join(files.root, 'run-files');
  const filesSummary = await run(files, filesOut);
  assert.equal(filesSummary.ok, true, filesSummary.errors.join('; '));
  assert.equal(filesSummary.toolProfile, 'files');
  assert.deepEqual(filesSummary.tools, [...LEAD_FILE_TOOLS]);
  assert.equal(filesSummary.terminalToolUses, 0);
  const filesProfile = JSON.parse(fs.readFileSync(path.join(filesOut, 'run.json'), 'utf8'));
  assert.equal(filesProfile.toolProfile, 'files');
  assert.ok(!JSON.stringify(filesProfile).includes('Bash'));
  assert.ok(!readEvents(filesOut).some((e) => e.data.toolName === 'Bash'));

  const terminal = await fixture(t, { env: { FAKE_CALLS: 'Bash' } });
  const terminalOut = path.join(terminal.root, 'run-terminal');
  const summary = await run(terminal, terminalOut, { toolProfile: 'terminal' });
  assert.equal(summary.ok, true, summary.errors.join('; '));
  assert.equal(summary.toolProfile, 'terminal');
  assert.deepEqual(summary.tools, [...LEAD_FILE_TOOLS, 'Bash']);
  assert.deepEqual(summary.requiredTools, [...LEAD_FILE_TOOLS, 'Bash']);
  assert.equal(summary.toolUses.Bash, 1, 'Bash is a known, counted tool');
  assert.equal(summary.terminalToolUses, 1);
  assert.equal(summary.terminalCommands, 1);
  assert.deepEqual(summary.unexpectedTools, []);
  assert.deepEqual(summary.outsideWorkspaceToolUses, [],
    'a relative terminal command is never misread as a file path violation');
  assert.ok(summary.warnings.some((w) => /terminal tool call/.test(w)));

  const profile = JSON.parse(fs.readFileSync(path.join(terminalOut, 'run.json'), 'utf8'));
  assert.equal(profile.toolProfile, 'terminal');
  assert.deepEqual(profile.tools, [...LEAD_FILE_TOOLS, 'Bash']);
  const pid = JSON.parse(fs.readFileSync(path.join(terminalOut, 'pid.json'), 'utf8'));
  assert.equal(pid.toolProfile, 'terminal');
  const events = readEvents(terminalOut);
  assert.ok(events.every((e) => e.toolProfile === 'terminal'), 'the replay carries the tool profile');
  assert.ok(events.some((e) => e.type === 'tool.started' && e.data.toolName === 'Bash'));
  assert.ok(events.some((e) => e.type === 'tool.finished' && e.data.toolName === 'Bash' && e.data.isError === false));
});

test('the terminal profile preserves model, route, and denial invariants', async (t) => {
  const cases = [
    ['wrong-model', {}, /observed model\(s\) other than/],
    ['api-key', {}, /expected the subscription login/],
    ['ok', { FAKE_DENY: 'Bash' }, /required tool permission\(s\) denied/],
    ['ok', { FAKE_ESCAPE: '1' }, /outside the workspace/],
  ];
  let index = 0;
  for (const [scenario, env, pattern] of cases) {
    index += 1;
    const fx = await fixture(t, { scenario, env });
    const summary = await run(fx, path.join(fx.root, `run-terminal-invariant-${index}`), { toolProfile: 'terminal' });
    assert.equal(summary.ok, false, `${scenario} must not report success with Bash enabled`);
    assert.ok(summary.errors.some((e) => pattern.test(e)), `${scenario}: ${JSON.stringify(summary.errors)}`);
    assert.equal(summary.fallbackUsed, false);
    assert.deepEqual(summary.unexpectedModels, scenario === 'wrong-model' ? ['claude-sonnet-4-5'] : []);
  }
});

test('a not-logged-in client reports authentication_required, not a model mismatch', async (t) => {
  const fx = await fixture(t, { scenario: 'not-logged-in' });
  const countFile = path.join(fx.root, 'count.txt');
  fx.baseEnv.FAKE_COUNT_FILE = countFile;
  const out = path.join(fx.root, 'run-auth');
  const summary = await run(fx, out);
  assert.equal(summary.ok, false);
  assert.equal(summary.failureKind, 'authentication_required');
  assert.equal(summary.authenticationRequired, true);
  assert.ok(summary.syntheticRecords >= 1, 'the synthetic record is counted separately');
  assert.equal(summary.observedModels.init, '<synthetic>', 'the raw evidence is kept, but classified');
  assert.deepEqual(summary.unexpectedModels, [], 'the synthetic record is not a served model');
  assert.ok(summary.errors.some((e) => /^authentication_required:/.test(e)), summary.errors.join('; '));
  assert.ok(!summary.errors.some((e) => /observed model\(s\) other than/.test(e)),
    'a login problem must not be reported as a model mismatch');
  assert.equal(summary.fallbackUsed, false);
  assert.equal(fs.readFileSync(countFile, 'utf8').trim().split('\n').length, 1, 'no retry after a login failure');
  const failed = readEvents(out).find((e) => e.type === 'agent.failed');
  assert.equal(failed.data.failureKind, 'authentication_required');
  assert.ok(!JSON.stringify(readEvents(out, 'events.public.jsonl')).includes('Please run /login'),
    'the login notice is never copied into the shareable replay');
});

test('the run command surfaces authentication_required with a remediation hint', async (t) => {
  const fx = await fixture(t, { scenario: 'not-logged-in' });
  const out = path.join(fx.root, 'run-auth-cli');
  const result = cli(['run', '--request', fx.requestFile, '--prompt', fx.prompt, '--out', out, '--claude-bin', fx.claudeBin], { env: fx.baseEnv });
  assert.equal(result.status, 2, result.stdout);
  assert.equal(result.json.failureKind, 'authentication_required');
  assert.match(result.json.remediation, /not logged in/i);
  assert.ok(!JSON.stringify(result.json).includes('Please run /login'), 'the raw notice is not echoed');
});

test('prose that merely mentions a login does not fail a successful run', async (t) => {
  const fx = await fixture(t, { scenario: 'login-prose' });
  const out = path.join(fx.root, 'run-prose');
  const summary = await run(fx, out);
  assert.equal(summary.ok, true, summary.errors.join('; '));
  assert.equal(summary.authenticationRequired, false);
  assert.equal(summary.failureKind, null);
  assert.equal(summary.observedModels.init, EXTERNAL_LEAD_MODEL);
});

test('a served-model mismatch outranks a login notice in the same run', async (t) => {
  const fx = await fixture(t, { scenario: 'wrong-model-auth' });
  const out = path.join(fx.root, 'run-mixed');
  const summary = await run(fx, out);
  assert.equal(summary.ok, false);
  assert.equal(summary.failureKind, 'model_mismatch', 'the real mismatch takes precedence');
  assert.deepEqual(summary.unexpectedModels, ['claude-sonnet-4-5']);
  assert.ok(summary.errors.some((e) => /observed model\(s\) other than/.test(e)));
  assert.ok(!summary.errors.some((e) => /^authentication_required:/.test(e)), 'no misleading login error when a model was served');
});

test('a genuinely different served model still fails as a mismatch', async (t) => {
  const fx = await fixture(t, { scenario: 'wrong-model' });
  const out = path.join(fx.root, 'run-mismatch');
  const summary = await run(fx, out);
  assert.equal(summary.ok, false);
  assert.equal(summary.failureKind, 'model_mismatch');
  assert.equal(summary.authenticationRequired, false);
  assert.deepEqual(summary.unexpectedModels, ['claude-sonnet-4-5']);
  assert.ok(summary.errors.some((e) => /observed model\(s\) other than/.test(e)));
});

test('a failed run is not retried on another model or provider', async (t) => {
  const fx = await fixture(t, { scenario: 'error' });
  const countFile = path.join(fx.root, 'count.txt');
  fx.baseEnv.FAKE_COUNT_FILE = countFile;
  const summary = await run(fx, path.join(fx.root, 'run-no-fallback'));
  assert.equal(summary.ok, false);
  assert.equal(summary.fallbackUsed, false);
  assert.equal(fs.readFileSync(countFile, 'utf8').trim().split('\n').length, 1, 'exactly one attempt');
  const raw = fs.readFileSync(path.join(fx.root, 'run-no-fallback', 'stdout.jsonl'), 'utf8');
  const attemptedModels = raw.split('\n').filter(Boolean)
    .flatMap((line) => {
      const record = JSON.parse(line);
      return [record.model, record.message?.model, ...Object.keys(record.modelUsage ?? {})].filter(Boolean);
    });
  assert.ok(attemptedModels.length > 0);
  assert.deepEqual([...new Set(attemptedModels)], [EXTERNAL_LEAD_MODEL], 'the single attempt is the configured model only');
  const args = JSON.parse(raw.split('\n')[0]).args;
  assert.equal(args.filter((a) => a === '--model').length, 1);
  assert.equal(args[args.indexOf('--model') + 1], EXTERNAL_LEAD_MODEL);
});

test('resume reuses the stored profile and reports a cumulative/delta pair', async (t) => {
  const first = await fixture(t);
  const mcpFile = path.join(first.root, 'mcp.json');
  await fsp.writeFile(mcpFile, JSON.stringify({ mcpServers: { browser: { command: 'true' } } }));
  const firstOut = path.join(first.root, 'run1');
  const firstSummary = await run(first, firstOut, {
    mcpConfig: mcpFile,
    mcpAllowedTools: ['mcp__browser'],
    requiredMcpTools: [],
    budget: { authorized: true, usd: 30, note: 'pilot' },
  });
  assert.equal(firstSummary.ok, true, firstSummary.errors.join('; '));

  const second = await fixture(t, { mult: 3 });
  const secondOut = path.join(second.root, 'run2');
  const resumed = cli(['resume', '--run', firstOut, '--prompt', second.prompt, '--out', secondOut, '--claude-bin', second.claudeBin], { env: second.baseEnv });
  assert.equal(resumed.status, 0, resumed.stdout);

  const delta = JSON.parse(await fsp.readFile(path.join(secondOut, 'resume-delta.json'), 'utf8'));
  assert.equal(delta.counterKind, 'delta-this-invocation');
  assert.equal(delta.profile.mode, 'external-lead');
  assert.deepEqual(delta.profile.mcpAllowedTools, ['mcp__browser']);
  assert.equal(delta.profile.mcpConfig, mcpFile, 'the resume reuses the exact authorized MCP config');
  assert.deepEqual(delta.delta.models[EXTERNAL_LEAD_MODEL], {
    complete: true, inputTokens: 6, outputTokens: 80, cacheReadInputTokens: 200, cacheCreationInputTokens: 100,
  });
  assert.equal(delta.delta.cumulative[EXTERNAL_LEAD_MODEL].inputTokens, 9, 'cumulative totals stay separate from the delta');

  const profile = JSON.parse(await fsp.readFile(path.join(secondOut, 'run.json'), 'utf8'));
  assert.equal(profile.mode, 'external-lead');
  assert.deepEqual(profile.mcpAllowedTools, ['mcp__browser']);
  assert.equal(profile.mcpConfig, mcpFile);
  assert.equal(profile.budget.usd, 30, 'the resume reuses the authorized budget reference');
  assert.equal(profile.resume, 'sess-1');
  assert.equal(profile.identity.parentAgentId, 'host-1', 'resume preserves the host parent rather than making the lead its own parent');

  const events = readEvents(secondOut);
  const session = events.find((e) => e.type === 'usage.recorded' && e.data.usageScope === 'session');
  assert.equal(session.data.resumed, true);
  assert.equal(session.data.includesPriorTurns, true);
  assert.equal(session.data.cumulative, true);
  assert.equal(session.data.counterKind, 'authoritative-total-with-delta');
  assert.equal(session.data.delta.models[EXTERNAL_LEAD_MODEL].inputTokens, 6);
  assert.deepEqual(session.usage[EXTERNAL_LEAD_MODEL], { inputTokens: 9, outputTokens: 120, cacheReadInputTokens: 300, cacheCreationInputTokens: 150, costUSD: 0.12 });
});

test('resume keeps the stored profile unless a transition is explicitly authorized', async (t) => {
  const first = await fixture(t, { env: { FAKE_CALLS: 'Read' } });
  const firstOut = path.join(first.root, 'run1');
  const firstSummary = await run(first, firstOut);
  assert.equal(firstSummary.toolProfile, 'files');
  const before = await treeHash(firstOut);

  const second = await fixture(t);
  const plainOut = path.join(second.root, 'run-plain');
  const plain = cli(['resume', '--run', firstOut, '--prompt', second.prompt, '--out', plainOut, '--claude-bin', second.claudeBin], { env: second.baseEnv });
  assert.equal(plain.status, 0, plain.stdout);
  assert.equal(plain.json.toolProfile, 'files', 'a plain resume never widens the profile');

  const unauthorisedOut = path.join(second.root, 'run-unauthorised');
  const unauthorised = cli([
    'resume', '--run', firstOut, '--prompt', second.prompt, '--out', unauthorisedOut,
    '--tool-profile', 'terminal', '--claude-bin', second.claudeBin,
  ], { env: second.baseEnv });
  assert.equal(unauthorised.status, 2);
  assert.equal(unauthorised.json.error, 'profile_transition_required');
  assert.equal(fs.existsSync(unauthorisedOut), false, 'an unauthorised widening never launches');

  const transitionOut = path.join(second.root, 'run-transition');
  const transitioned = cli([
    'resume', '--run', firstOut, '--prompt', second.prompt, '--out', transitionOut,
    '--tool-profile', 'terminal', '--authorize-profile-transition',
    '--reason', 'host authorized terminal execution for this phase',
    '--claude-bin', second.claudeBin,
  ], { env: second.baseEnv });
  assert.equal(transitioned.status, 0, transitioned.stdout);
  assert.equal(transitioned.json.toolProfile, 'terminal');
  assert.equal(transitioned.json.resumedFrom, firstSummary.sessionId, 'the same Claude session is retained');
  assert.equal(transitioned.json.profileTransition.from, 'files');
  assert.equal(transitioned.json.profileTransition.to, 'terminal');
  assert.equal(transitioned.json.profileTransition.reason, 'host authorized terminal execution for this phase');
  assert.equal(transitioned.json.profileTransition.previousRun, firstOut);
  assert.equal(transitioned.json.profileTransition.previousSessionId, firstSummary.sessionId);

  const audit = JSON.parse(fs.readFileSync(path.join(transitionOut, 'profile-transition.json'), 'utf8'));
  assert.equal(audit.from, 'files');
  assert.equal(audit.to, 'terminal');
  assert.equal(audit.authorized, true);
  assert.equal(audit.previousRun, firstOut);
  assert.equal(audit.previousInvocationId, firstSummary.invocationId);
  const transitionProfile = JSON.parse(fs.readFileSync(path.join(transitionOut, 'run.json'), 'utf8'));
  assert.equal(transitionProfile.toolProfile, 'terminal');
  assert.equal(transitionProfile.profileTransition.from, 'files');
  const transitionEvents = readEvents(transitionOut);
  assert.equal(transitionEvents.filter((e) => e.type === 'profile.transition').length, 1, 'the transition is in the replay');
  assert.equal(transitionEvents.find((e) => e.type === 'profile.transition').data.to, 'terminal');

  const delta = JSON.parse(fs.readFileSync(path.join(transitionOut, 'resume-delta.json'), 'utf8'));
  assert.equal(delta.profile.toolProfile, 'terminal');
  assert.equal(delta.profileTransition.from, 'files');
  assert.equal(delta.resumedFrom, firstSummary.sessionId);
  const cumulative = delta.delta.cumulative[EXTERNAL_LEAD_MODEL];
  assert.equal(cumulative.counterKind, 'cumulative-session-total');
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'costUSD']) {
    assert.equal(cumulative[field], firstSummary.modelUsage[EXTERNAL_LEAD_MODEL][field],
      `the cumulative baseline follows the previous session totals (${field})`);
  }

  assert.equal(await treeHash(firstOut), before, 'the previous run metadata is never rewritten');

  const downgradeOut = path.join(second.root, 'run-downgrade');
  const downgrade = cli([
    'resume', '--run', transitionOut, '--prompt', second.prompt, '--out', downgradeOut,
    '--tool-profile', 'files', '--authorize-profile-transition', '--claude-bin', second.claudeBin,
  ], { env: second.baseEnv });
  assert.equal(downgrade.status, 2);
  assert.equal(downgrade.json.error, 'profile_transition_unsupported');
});

test('a stored profile without a tool profile resumes as files-only', async (t) => {
  const fx = await fixture(t);
  const out = path.join(fx.root, 'legacy-profile');
  const summary = await run(fx, out);
  assert.equal(summary.ok, true, summary.errors.join('; '));
  const profilePath = path.join(out, 'run.json');
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  delete profile.toolProfile;
  delete profile.tools;
  fs.writeFileSync(profilePath, JSON.stringify(profile));

  const target = path.join(fx.root, 'legacy-resume');
  const resumed = cli(['resume', '--run', out, '--prompt', fx.prompt, '--out', target, '--claude-bin', fx.claudeBin], { env: fx.baseEnv });
  assert.equal(resumed.status, 0, resumed.stdout);
  assert.equal(resumed.json.toolProfile, 'files', 'a pre-phase profile is never silently widened');
  const resumedProfile = JSON.parse(fs.readFileSync(path.join(target, 'run.json'), 'utf8'));
  assert.equal(resumedProfile.toolProfile, 'files');
});

test('an unusable resume is refused instead of silently starting fresh', async (t) => {
  const fx = await fixture(t);
  const missing = cli(['resume', '--run', path.join(fx.root, 'never-ran'), '--prompt', fx.prompt, '--out', path.join(fx.root, 'out')]);
  assert.equal(missing.status, 2);
  assert.equal(missing.json.error, 'unusable_resume');

  const failed = await fixture(t, { scenario: 'error' });
  const failedOut = path.join(failed.root, 'run-failed');
  await run(failed, failedOut);
  const refused = cli(['resume', '--run', failedOut, '--prompt', failed.prompt, '--out', path.join(failed.root, 'out2')]);
  assert.equal(refused.status, 2);
  assert.equal(refused.json.error, 'unusable_resume');

  const legacy = path.join(fx.root, 'legacy');
  await fsp.mkdir(legacy);
  await fsp.writeFile(path.join(legacy, 'summary.json'), JSON.stringify({ ok: true, sessionId: 'sess-legacy', workspace: fx.workspace }));
  const noProfile = cli(['resume', '--run', legacy, '--prompt', fx.prompt, '--out', path.join(fx.root, 'out3')]);
  assert.equal(noProfile.status, 2);
  assert.equal(noProfile.json.error, 'unusable_resume');
});

test('cancel fails closed for completed runs, spoofed markers, and stale pids', async (t) => {
  const fx = await fixture(t);
  assert.equal((await cancelRun({ runDir: path.join(fx.root, 'nothing-here') })).status, 'no-live-runner');

  const completedOut = path.join(fx.root, 'run-done');
  await run(fx, completedOut);
  const completed = await cancelRun({ runDir: completedOut });
  assert.equal(completed.ok, false);
  assert.equal(completed.status, 'completed');

  const unrelated = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
  unrelated.unref();
  t.after(() => { try { process.kill(-unrelated.pid, 'SIGKILL'); } catch { try { unrelated.kill('SIGKILL'); } catch { /* gone */ } } });
  const forged = path.join(fx.root, 'forged');
  await fsp.mkdir(forged);
  await fsp.writeFile(path.join(forged, 'pid.json'), JSON.stringify({
    runner: RUN_MARKER, runnerVersion: 2, pid: unrelated.pid, processGroup: unrelated.pid,
    control: { heartbeat: 'control.heartbeat', request: 'control.request.json', reply: 'control.reply.json' }, controlToken: 'f'.repeat(48),
  }));
  const spoofed = await cancelRun({ runDir: forged, timeoutMs: 500 });
  assert.equal(spoofed.ok, false);
  assert.ok(['no-live-runner', 'refused'].includes(spoofed.status), JSON.stringify(spoofed));
  assert.equal(isAlive(unrelated.pid), true, 'an unrelated process must survive a forged pid file');

  const stale = path.join(fx.root, 'stale');
  await fsp.mkdir(stale);
  await fsp.writeFile(path.join(stale, 'pid.json'), JSON.stringify({
    runner: RUN_MARKER, runnerVersion: 2, pid: 999999, processGroup: 999999,
    control: { heartbeat: 'control.heartbeat', request: 'control.request.json', reply: 'control.reply.json' }, controlToken: 'f'.repeat(48),
  }));
  const staleResult = await cancelRun({ runDir: stale, timeoutMs: 500 });
  assert.equal(staleResult.ok, false);
  assert.equal(staleResult.status, 'no-live-runner');

  const foreign = path.join(fx.root, 'foreign');
  await fsp.mkdir(foreign);
  await fsp.writeFile(path.join(foreign, 'pid.json'), JSON.stringify({ pid: process.pid, processGroup: process.pid }));
  const foreignResult = await cancelRun({ runDir: foreign, timeoutMs: 500 });
  assert.equal(foreignResult.status, 'refused');
});

test('cancel stops a live run through its authenticated control endpoint', async (t) => {
  const fx = await fixture(t, { scenario: 'hang' });
  const out = path.join(fx.root, 'run-hang');
  const child = spawn(process.execPath, [
    LEAD, 'run', '--request', fx.requestFile, '--prompt', fx.prompt, '--out', out, '--claude-bin', fx.claudeBin,
  ], { env: fx.baseEnv, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  await waitFor(() => fs.existsSync(path.join(out, 'pid.json')));
  const record = JSON.parse(fs.readFileSync(path.join(out, 'pid.json'), 'utf8'));
  assert.equal(record.runner, RUN_MARKER);
  assert.deepEqual(Object.keys(record.control).sort(), ['heartbeat', 'reply', 'request']);
  assert.equal(typeof record.controlToken, 'string');
  assert.ok(fs.existsSync(path.join(out, record.control.heartbeat)), 'the runner publishes a heartbeat for cancel');
  const leadPid = record.pid;
  assert.equal(isAlive(leadPid), true);

  const forged = { ...record, controlToken: 'a'.repeat(48) };
  fs.writeFileSync(path.join(out, 'pid.json'), JSON.stringify(forged));
  const refused = await cancelRun({ runDir: out, timeoutMs: 1500 });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 'refused');
  assert.equal(isAlive(leadPid), true, 'a forged token must not stop the run');

  fs.writeFileSync(path.join(out, 'pid.json'), JSON.stringify(record));
  const stopped = await cancelRun({ runDir: out, waitMs: 5000 });
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  assert.equal(stopped.status, 'stopped');
  assert.match(stopped.via, /control channel/);
  await waitFor(() => fs.existsSync(path.join(out, 'summary.json')), 10_000);
  await waitFor(() => !isAlive(leadPid), 10_000);
  const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.ok, false);
});

test('a signal on the CLI reaps the child group instead of orphaning it', async (t) => {
  const fx = await fixture(t, { scenario: 'hang' });
  const out = path.join(fx.root, 'run-sigint');
  const child = spawn(process.execPath, [
    LEAD, 'run', '--request', fx.requestFile, '--prompt', fx.prompt, '--out', out, '--claude-bin', fx.claudeBin,
  ], { env: fx.baseEnv, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  await waitFor(() => fs.existsSync(path.join(out, 'pid.json')));
  const record = JSON.parse(fs.readFileSync(path.join(out, 'pid.json'), 'utf8'));
  assert.equal(isAlive(record.pid), true);
  child.kill('SIGINT');
  await waitFor(() => fs.existsSync(path.join(out, 'summary.json')), 15_000);
  const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.ok, false);
  assert.equal(summary.process.cancelled, true);
  assert.equal(summary.process.stopReason, 'cancelled');
  assert.ok(summary.errors.some((e) => /cancelled by the host/.test(e)), summary.errors.join('; '));
  await waitFor(() => !isAlive(record.pid), 10_000);
});

test('record requires attributable ids and keeps worker usage provenance', async (t) => {
  const fx = await fixture(t);
  const events = path.join(fx.root, 'recorded', 'events.jsonl');
  const host = path.join(fx.root, 'host.json');
  await fsp.writeFile(host, JSON.stringify({
    summary: 'Worker bundle dispatched to the configured role.',
    status: 'dispatched',
    usage: { inputTokens: 12, outputTokens: 34, billing: 'api-billed', billedUsd: 0.21, route: 'router', costSource: 'router-usage.jsonl' },
    executorRoute: 'router',
    toolOwner: 'native-worker',
  }));
  const noIds = cli(['record', '--run', fx.root, '--type', 'host.action', '--file', host, '--events', events]);
  assert.equal(noIds.status, 2);
  assert.equal(noIds.json.error, 'missing_ids');
  assert.equal(fs.existsSync(events), false, 'an unattributable event is not recorded');

  const hostRecord = cli([
    'record', '--run', fx.root, '--type', 'host.action', '--file', host, '--events', events,
    '--run-id', 'run-1', '--agent-id', 'host-1', '--phase', 'phase-1',
  ]);
  assert.equal(hostRecord.status, 0, hostRecord.stdout);
  assert.equal(hostRecord.json.recorded, true);
  assert.deepEqual(hostRecord.json.ids, { runId: 'run-1', agentId: 'host-1', requestId: null, phase: 'phase-1' });

  const worker = path.join(fx.root, 'worker.json');
  await fsp.writeFile(worker, JSON.stringify({
    schemaVersion: 1,
    runId: 'run-1',
    agentId: 'worker-1',
    requestId: 'req-1',
    status: 'completed',
    outcome: 'Implemented and verified the bounded bundle.',
    executor: 'native-worker',
    executorRoute: 'router',
    observedModel: WORKER_MODEL,
    evidence: ['npm test: 158 pass'],
    usage: { inputTokens: 900, outputTokens: 4200, billing: 'api-billed', billedUsd: 1.35, route: 'router', costSource: 'router-usage.jsonl' },
    at: '2026-09-29T00:00:00.000Z',
  }));
  const workerRecord = cli(['record', '--run', fx.root, '--type', 'worker.result', '--file', worker, '--request', fx.requestFile, '--events', events]);
  assert.equal(workerRecord.status, 0, workerRecord.stdout);

  const lines = fs.readFileSync(events, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((e) => e.type), ['host.action', 'worker.result']);
  assert.equal(lines[0].requestedModel, null, 'a host event must not default to the Opus lead model');
  assert.equal(lines[0].usage.billedUsd, 0.21, 'recorded usage is kept, not discarded');
  assert.equal(lines[0].executorRoute, 'router');
  assert.equal(lines[1].observedModel, WORKER_MODEL, 'a slash-qualified worker id is accepted');
  assert.equal(lines[1].usage.billing, 'api-billed');
  assert.equal(lines[1].requestId, 'req-1');
  assert.equal(lines[1].agentId, 'worker-1');
  const publicLines = fs.readFileSync(path.join(path.dirname(events), 'events.public.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(publicLines.length, 2);
});

test('lead results keep the exact model identity and worker results do not', async (t) => {
  const fx = await fixture(t);
  const requestDoc = JSON.parse(fs.readFileSync(fx.requestFile, 'utf8'));
  const base = {
    schemaVersion: 1, requestId: 'req-1', runId: 'run-1', agentId: 'lead-1', status: 'completed',
    outcome: 'Accepted after review.', executor: 'claude-code-subscription',
    evidence: ['npm test: 158 pass'],
    usage: { inputTokens: 10, outputTokens: 20, billing: 'not-billed-via-api', billedUsd: null, equivalentUsd: 0.4 },
    at: '2026-09-29T00:00:00.000Z',
  };
  const leadOk = validateLeadResult({ ...base, observedModel: EXTERNAL_LEAD_MODEL }, { request: requestDoc });
  assert.equal(leadOk.ok, true, leadOk.problems.join('; '));
  const leadWrong = validateLeadResult({ ...base, observedModel: WORKER_MODEL }, { request: requestDoc });
  assert.equal(leadWrong.ok, false, 'a lead result cannot claim a worker model');
  const leadBill = validateLeadResult({ ...base, observedModel: EXTERNAL_LEAD_MODEL, usage: { ...base.usage, billedUsd: 0.4 } }, { request: requestDoc });
  assert.equal(leadBill.ok, false, 'a subscription lead result must not report an API bill');

  const worker = validateWorkerResult({
    schemaVersion: 1, runId: 'run-1', agentId: 'worker-1', requestId: 'req-1', status: 'completed',
    outcome: 'done', executor: 'native-worker', executorRoute: 'router', observedModel: WORKER_MODEL,
    evidence: ['check'],
    usage: { inputTokens: 1, outputTokens: 2, billing: 'api-billed', billedUsd: 0.5, route: 'router', costSource: 'router-usage.jsonl' },
    at: '2026-09-29T00:00:00.000Z',
  }, { request: requestDoc });
  assert.equal(worker.ok, true, worker.problems.join('; '));
  const workerNoIds = validateWorkerResult({
    schemaVersion: 1, status: 'completed', outcome: 'done', executor: 'native-worker',
    observedModel: WORKER_MODEL, evidence: ['check'], usage: {}, at: '2026-09-29T00:00:00.000Z',
  });
  assert.equal(workerNoIds.ok, false);
  assert.ok(workerNoIds.problems.some((p) => /runId is required/.test(p)));

  const result = path.join(fx.root, 'lead-result.json');
  await fsp.writeFile(result, JSON.stringify({ ...base, observedModel: WORKER_MODEL }));
  const recorded = cli(['record', '--run', fx.root, '--type', 'lead.result', '--file', result, '--request', fx.requestFile]);
  assert.equal(recorded.status, 2);
  assert.equal(recorded.json.recorded, false);
});

test('public events withhold the fields that carry private content', () => {
  const event = {
    schemaVersion: 1, eventId: 'ev-1', runId: 'run-1', agentId: 'lead-1', type: 'tool.started', at: null,
    data: { prompt: 'secret', transcript: 'secret', content: 'secret', toolName: 'Read' },
  };
  const publicEvent = toPublicEvent(event);
  assert.equal(publicEvent.data.prompt, '[withheld]');
  assert.equal(publicEvent.data.transcript, '[withheld]');
  assert.equal(publicEvent.data.content, '[withheld]');
  assert.equal(publicEvent.data.toolName, 'Read');
  assert.ok(!JSON.stringify(publicEvent).includes('secret'));
});

test('usage provenance and delta keep subscription equivalents separate from bills', () => {
  const subscription = usageProvenance({ route: 'subscription', reportedCostUsd: 1.5 });
  assert.equal(subscription.billing, 'not-billed-via-api');
  assert.equal(subscription.billedUsd, null);
  assert.equal(subscription.equivalentUsd, 1.5);
  assert.equal(subscription.accountQuota, null);
  const unknown = usageProvenance({ route: 'subscription' });
  assert.equal(unknown.equivalentUsd, null);
  assert.equal(unknown.billedUsd, null);

  const delta = usageDelta(
    { modelUsage: { m: { inputTokens: 1, outputTokens: 2 } } },
    { modelUsage: { m: { inputTokens: 4, outputTokens: 6 } } },
  );
  assert.equal(delta.available, false, 'missing fields are incomplete, not zero');
  assert.equal(delta.counterKind, 'delta-this-invocation');
  assert.equal(delta.models.m.inputTokens, 3);
  assert.equal(delta.models.m.cacheReadInputTokens, null);
  assert.equal(delta.cumulative.m.inputTokens, 4, 'the cumulative total is reported separately from the delta');
  const reset = usageDelta(
    { modelUsage: { m: { inputTokens: 9, outputTokens: 9 } } },
    { modelUsage: { m: { inputTokens: 1, outputTokens: 2 } } },
  );
  assert.equal(reset.models.m.inputTokens, null, 'a counter that goes backwards is unknown, never negative');
});

test('a copied runtime works outside the source repo with no benchmark or absolute paths', async (t) => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'external-lead-copy-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const copy = path.join(root, 'scripts');
  await fsp.cp(SCRIPTS, copy, { recursive: true });
  for (const file of await listFiles(copy)) {
    const text = await fsp.readFile(file, 'utf8');
    assert.ok(!text.includes(ROOT), `${path.relative(copy, file)} must not embed the source repo path`);
    assert.ok(!/from\s+['"][^'"]*(?:benchmarks|experiments)\//.test(text), `${path.relative(copy, file)} must not import a research harness`);
  }
  const workspace = path.join(root, 'work');
  await fsp.mkdir(workspace);
  const claudeBin = path.join(root, 'fake-claude');
  await fsp.writeFile(claudeBin, FAKE_CLI, { mode: 0o755 });
  const prompt = path.join(root, 'prompt.txt');
  await fsp.writeFile(prompt, PROMPT_BODY);
  const requestFile = path.join(root, 'request.json');
  await fsp.writeFile(requestFile, JSON.stringify(request({}, workspace)));

  const copiedCli = (args, env) => spawnSync(process.execPath, [path.join(copy, 'lead.mjs'), ...args], {
    encoding: 'utf8', cwd: root, env: { ...process.env, HOME: root, ...env },
  });
  const doctor = copiedCli(['doctor'], { PATH: '' });
  assert.equal(doctor.status, 2, 'a missing CLI is reported, not guessed');
  assert.equal(JSON.parse(doctor.stdout).status, 'unavailable');

  const out = path.join(root, 'run');
  const result = copiedCli(['run', '--request', requestFile, '--prompt', prompt, '--out', out, '--claude-bin', claudeBin], { FAKE_SCENARIO: 'ok' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(await fsp.readFile(path.join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.ok, true, summary.errors.join('; '));
  assert.equal(summary.observedModels.init, EXTERNAL_LEAD_MODEL);
  assert.ok(!JSON.stringify(summary).includes(ROOT));
});

async function listFiles(dir) {
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(full));
    else out.push(full);
  }
  return out;
}

// Content hash of a whole run directory, for "the old run was not rewritten".
async function treeHash(dir) {
  const crypto = await import('node:crypto');
  const hash = crypto.createHash('sha256');
  for (const file of (await listFiles(dir)).sort()) {
    hash.update(path.relative(dir, file));
    hash.update('\u0000');
    hash.update(await fsp.readFile(file));
    hash.update('\u0000');
  }
  return hash.digest('hex');
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for the expected state');
}
