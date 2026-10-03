// Replay integration: the package's bridge and viewer entry point, driven by
// event shapes copied from real adapter runs and real Codex session records.
// No sockets are required; binding is covered by the vendored server test,
// which skips where listen() is blocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './helpers.mjs';
import { bridgeRun, bridgeRuns, writeReplay } from '../plugins/codex-on-crack/skills/crack/viewer/bridge.mjs';
import { authorizeRequest, createHandler, viewerState } from '../plugins/codex-on-crack/skills/crack/viewer/serve.mjs';
import { reduceEvents, validateEvent } from '../plugins/codex-on-crack/skills/crack/viewer/src/model.mjs';

const SECRET = 'fake-replay-value-not-a-credential-0123456789';

// The real adapter event envelope, as written by lead.mjs.
function runEvent(type, at, extra = {}) {
  return {
    schemaVersion: 1,
    eventId: `${type}-${at}`,
    runId: 'run-1',
    phase: 'phase-1',
    parentAgentId: 'host-thread-1',
    requestId: 'req-1',
    agentId: 'solo-lead',
    invocationId: 'inv-1',
    mode: 'solo',
    toolProfile: 'terminal',
    type,
    at,
    atSource: 'stream',
    status: 'recorded',
    requestedModel: 'claude-opus-5-5',
    observedModel: null,
    route: 'subscription',
    toolOwner: 'external-claude',
    usage: null,
    data: {},
    ...extra,
  };
}

function realRunEvents() {
  return [
    runEvent('agent.created', '2026-09-29T10:00:00Z', { data: { sessionId: 'session-a' } }),
    runEvent('agent.started', '2026-09-29T10:00:01Z', { observedModel: 'claude-opus-5-5', data: { sessionId: 'session-a', tools: ['Read', 'Bash'], permissionMode: 'default', cliVersion: '2.1.285', toolOwner: 'external-claude' } }),
    runEvent('model.observed', '2026-09-29T10:00:01Z', { observedModel: 'claude-opus-5-5', data: { via: 'system.init' } }),
    runEvent('tool.started', '2026-09-29T10:00:02Z', { data: { toolName: 'Bash', toolUseId: 'tu_1', toolOwner: 'external-claude' } }),
    runEvent('tool.finished', '2026-09-29T10:00:03Z', { status: 'completed', data: { toolName: 'Bash', toolUseId: 'tu_1', isError: false, toolOwner: 'external-claude' } }),
    runEvent('tool.started', '2026-09-29T10:00:04Z', { data: { toolName: 'Read', toolUseId: 'tu_2', toolOwner: 'external-claude' } }),
    runEvent('tool.finished', '2026-09-29T10:00:05Z', { status: 'error', data: { toolName: 'Read', toolUseId: 'tu_2', isError: true, toolOwner: 'external-claude' } }),
    runEvent('usage.recorded', '2026-09-29T10:00:06Z', { status: 'final', data: { usageScope: 'session', counterKind: 'authoritative-total', completeness: 'final', cumulative: true } }),
    runEvent('agent.returned', '2026-09-29T10:00:06Z', { status: 'completed', data: { reason: null, subtype: 'success', numTurns: 3 } }),
    runEvent('profile.transition', '2026-09-29T10:00:07Z', { status: 'authorized', executorRoute: 'host', toolOwner: 'codex-host', data: { from: 'files', to: 'terminal', previousRun: '/private/tmp/old', reason: 'host authorized' } }),
  ];
}

function runFixture(root, name, { events, summary = null, run = null, resumeDelta = null, publicEvents = null }) {
  const arm = path.dirname(path.join(root, name));
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  if (publicEvents) fs.writeFileSync(path.join(dir, 'events.public.jsonl'), `${publicEvents.map((e) => JSON.stringify(e)).join('\n')}\n`);
  if (summary) fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  if (run) fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run, null, 2));
  if (resumeDelta) fs.writeFileSync(path.join(dir, 'resume-delta.json'), JSON.stringify(resumeDelta, null, 2));
  assert.ok(arm, 'fixture path exists');
  return dir;
}

function summaryFor({ agentId = 'solo-lead', sessionId = 'session-a', mode = 'solo', toolProfile = 'terminal', usage = null, ok = true } = {}) {
  return {
    schemaVersion: 1, ok, agentId, parentAgentId: 'host-thread-1', runId: 'run-1', invocationId: 'inv-1',
    phase: 'phase-1', mode, toolProfile, startedAt: '2026-09-29T10:00:00Z', endedAt: '2026-09-29T10:00:06Z', wallDurationMs: 6000,
    sessionId, failureKind: null, resumedFrom: null,
    modelUsage: usage, usage: usage ? { billing: 'not-billed-via-api', billedUsd: null, equivalentUsd: 0.5 } : null,
  };
}

async function fixture(t) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'crack-replay-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a real-shaped run projects tool activity, labels and a visible usage line', async (t) => {
  const root = await fixture(t);
  const arm = path.join(root, 'opus-solo');
  const dir = runFixture(arm, 'runs/lead-3', {
    events: realRunEvents(),
    summary: summaryFor({ usage: { 'claude-opus-5-5': { inputTokens: 60, outputTokens: 86525, cacheReadInputTokens: 2613387, cacheCreationInputTokens: 143783, costUSD: 3.4 } } }),
    run: { mode: 'solo', toolProfile: 'terminal', identity: { agentId: 'solo-lead', phase: 'phase-1' } },
  });
  const result = bridgeRun(dir, 0);
  for (const event of result.events) validateEvent(event);

  assert.equal(result.run.title, 'Project lead · solo · opus-solo', 'labelled from mode, not parent existence');
  assert.deepEqual(result.run.tools, { Bash: 1, Read: 1 });
  assert.equal(result.run.toolErrors, 1);
  const activity = result.events.at(-1);
  assert.equal(activity.type, 'activity.reported');
  assert.match(activity.data.text, /Completed · 2 tool calls \(Bash 1, Read 1\)/);
  assert.match(activity.data.text, /2,843,755 tokens recorded/);
  assert.match(activity.data.text, /list-price equivalent \$3\.40 \(not a charge\)/);
  assert.ok(result.events.some((e) => e.data.text === 'Bash started'));
  assert.ok(result.events.some((e) => e.data.text === 'Read failed'));

  const json = JSON.stringify(result.events);
  assert.ok(!json.includes('/private/tmp/old'), 'a transition path is not replayed');
  assert.ok(!json.includes('session-a'), 'the session id is not replayed');
  assert.ok(!json.includes('inv-1') && !json.includes('req-1') && !json.includes('phase-1'), 'ids and phases are not replayed');
  assert.equal(result.usage.models['claude-opus-5-5'].equivalentUsd, 3.4);
  assert.equal(result.usage.models['claude-opus-5-5'].billedUsd, null);
  assert.ok(!JSON.stringify(result.usage).includes('/private/'), 'the local summary keeps labels, not paths');
});

test('a run that is still in flight yields a provisional state instead of failing', async (t) => {
  const root = await fixture(t);
  const dir = runFixture(path.join(root, 'opus-flash'), 'runs/lead-4', {
    events: realRunEvents().slice(0, 7),
    publicEvents: realRunEvents().slice(0, 7),
    run: { mode: 'external-lead', toolProfile: 'files', identity: { agentId: 'flash-lead', phase: 'phase-1' }, startedAt: '2026-09-29T10:00:00Z' },
  });
  assert.equal(fs.existsSync(path.join(dir, 'summary.json')), false, 'no summary yet');
  const result = bridgeRun(dir, 0);
  assert.equal(result.run.state, 'running');
  assert.equal(result.run.title, 'Project lead · opus-flash');
  assert.match(result.events.at(-1).data.text, /Running · 2 tool calls/);
  assert.match(result.events.at(-1).data.text, /usage not recorded/);
  assert.match(result.usage.note, /nothing is inferred/);

  const state = await viewerState({ runs: [dir], clock: () => new Date('2026-09-29T10:01:00Z') });
  assert.equal(state.mode, 'Live');
  assert.equal(state.sources[0].state, 'running');
});

test('resume deltas are read from both the nested and top-level shapes', async (t) => {
  const root = await fixture(t);
  const base = {
    events: realRunEvents(),
    summary: summaryFor({ usage: { 'claude-opus-5-5': { inputTokens: 15, outputTokens: 35, cacheReadInputTokens: 60, cacheCreationInputTokens: 50 } } }),
    run: { mode: 'solo' },
  };
  const nested = runFixture(path.join(root, 'arm-a'), 'runs/lead-2', {
    ...base,
    resumeDelta: { schemaVersion: 1, resumedFrom: 's', counterKind: 'delta-this-invocation', delta: { counterKind: 'delta-this-invocation', models: { 'claude-opus-5-5': { complete: true, inputTokens: 5, outputTokens: 15, cacheReadInputTokens: 30, cacheCreationInputTokens: 10 } } } },
  });
  const top = runFixture(path.join(root, 'arm-b'), 'runs/lead-2', {
    ...base,
    resumeDelta: { schemaVersion: 1, resumedFrom: 's', counterKind: 'delta-this-invocation', models: { 'claude-opus-5-5': { complete: true, inputTokens: 4, outputTokens: 14, cacheReadInputTokens: 20, cacheCreationInputTokens: 9 } } },
  });
  assert.equal(bridgeRun(nested, 0).usage.delta.models['claude-opus-5-5'].inputTokens, 5);
  assert.equal(bridgeRun(top, 0).usage.delta.models['claude-opus-5-5'].inputTokens, 4, 'top-level models are read too');
  assert.equal(bridgeRun(top, 0).usage.delta.counterKind, 'delta-this-invocation');
});

test('a resumed chain keeps one agent; a different session is a different agent', async (t) => {
  const root = await fixture(t);
  const arm = path.join(root, 'opus-solo');
  const first = runFixture(arm, 'runs/lead-2', {
    events: realRunEvents(),
    summary: summaryFor({ sessionId: 'session-a', usage: { 'claude-opus-5-5': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 } } }),
    run: { mode: 'solo' },
  });
  const sameSession = runFixture(arm, 'runs/lead-3', {
    events: realRunEvents(),
    summary: summaryFor({ sessionId: 'session-a', usage: { 'claude-opus-5-5': { inputTokens: 15, outputTokens: 35, cacheReadInputTokens: 60, cacheCreationInputTokens: 50 } } }),
    run: { mode: 'solo' },
  });
  const chained = bridgeRuns([first, sameSession]);
  const chainedAgents = reduceEvents(chained.events);
  assert.equal(chainedAgents.length, 1, 'the same session stays one agent');
  assert.deepEqual(chainedAgents[0].usage.usage, { inputTokens: 15, outputTokens: 35, cacheReadInputTokens: 60, cacheCreationInputTokens: 50 },
    'the latest cumulative total wins, never a sum');

  const otherSession = runFixture(arm, 'runs/lead-4', {
    events: realRunEvents(),
    summary: summaryFor({ sessionId: 'session-b', usage: { 'claude-opus-5-5': { inputTokens: 900, outputTokens: 900, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }),
    run: { mode: 'solo' },
  });
  const mixed = reduceEvents(bridgeRuns([first, otherSession]).events);
  assert.equal(mixed.length, 2, 'a different Claude session is a separate agent');
  const totals = mixed.map((agent) => agent.usage.usage.outputTokens).sort((a, b) => a - b);
  assert.deepEqual(totals, [20, 900], 'one session never overwrites the other');
});

test('missing usage stays missing and an API bill is never reported as an equivalent', async (t) => {
  const root = await fixture(t);
  const noUsage = runFixture(path.join(root, 'arm-a'), 'runs/lead-1', {
    events: realRunEvents().slice(0, 8),
    summary: summaryFor({ usage: null, ok: false }),
    run: { mode: 'solo' },
  });
  const result = bridgeRun(noUsage, 0);
  assert.equal(result.events.some((e) => e.type === 'usage.recorded'), false, 'no counter is invented');
  assert.match(result.events.at(-1).data.text, /usage not recorded/);

  const billed = runFixture(path.join(root, 'arm-b'), 'runs/lead-1', {
    events: realRunEvents(),
    summary: {
      ...summaryFor({ agentId: 'worker-1', usage: { 'deepseek/deepseek-v4.1-flash': { inputTokens: 1, outputTokens: 2 } } }),
      parentAgentId: 'solo-lead', mode: 'delegated', toolProfile: 'files',
      usage: { billing: 'api-billed', billedUsd: 1.25, equivalentUsd: null },
    },
    run: { mode: 'delegated', toolProfile: 'files' },
  });
  const worker = bridgeRun(billed, 1);
  assert.equal(worker.usage.models['deepseek/deepseek-v4.1-flash'].billedUsd, 1.25);
  assert.equal(worker.usage.models['deepseek/deepseek-v4.1-flash'].cacheReadInputTokens, null, 'an unreported counter stays null');
  assert.match(worker.events.at(-1).data.text, /billed \$1\.25/);
});

test('a tool name that looks like a path or credential is redacted', async (t) => {
  const root = await fixture(t);
  const dir = runFixture(path.join(root, 'arm'), 'runs/lead-1', {
    events: [runEvent('tool.started', '2026-09-29T10:00:01Z', { data: { toolName: `/Users/example/secret/${SECRET}` } })],
    summary: summaryFor({ usage: null }),
    run: { mode: 'solo' },
  });
  const json = JSON.stringify(bridgeRun(dir, 0).events);
  assert.ok(!json.includes('fake-replay-value'), 'a credential-shaped tool name is not replayed');
  assert.ok(!json.includes('/Users/'), 'a path-shaped tool name is not replayed');
  assert.match(json, /started/);
});

test('one view can mix a host session, a worker session, and an adapter run', async (t) => {
  const root = await fixture(t);
  const hostSession = path.join(root, 'host.jsonl');
  const workerSession = path.join(root, 'worker.jsonl');
  const record = (type, payload, timestamp) => JSON.stringify({ type, payload, timestamp });
  fs.writeFileSync(hostSession, [
    record('session_meta', { id: 'host-1', source: 'cli' }, '2026-09-29T09:00:00Z'),
    record('turn_context', { model: 'gpt-6-astra' }, '2026-09-29T09:00:01Z'),
    record('event_msg', { type: 'task_started' }, '2026-09-29T09:00:02Z'),
    record('response_item', { type: 'function_call', name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: 'Define acceptance', status: 'completed' }, { step: 'Delegate', status: 'in_progress' }] }) }, '2026-09-29T09:00:03Z'),
    record('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 40 } } }, '2026-09-29T09:00:04Z'),
    record('event_msg', { type: 'task_complete' }, '2026-09-29T09:00:05Z'),
  ].join('\n') + '\n');
  fs.writeFileSync(workerSession, [
    record('session_meta', { id: 'worker-1', source: { subagent: { thread_spawn: { parent_thread_id: 'host-1' } } } }, '2026-09-29T09:01:00Z'),
    record('turn_context', { model: 'deepseek/deepseek-v4.1-flash' }, '2026-09-29T09:01:01Z'),
    record('event_msg', { type: 'task_started' }, '2026-09-29T09:01:02Z'),
    record('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 900, cached_input_tokens: 100, output_tokens: 500 } } }, '2026-09-29T09:01:03Z'),
    record('event_msg', { type: 'task_complete' }, '2026-09-29T09:01:04Z'),
  ].join('\n') + '\n');
  const runDir = runFixture(path.join(root, 'opus-solo'), 'runs/lead-1', {
    events: realRunEvents(),
    summary: summaryFor({ usage: { 'claude-opus-5-5': { inputTokens: 5, outputTokens: 6, cacheReadInputTokens: 7, cacheCreationInputTokens: 8 } } }),
    run: { mode: 'solo' },
  });

  const state = await viewerState({ runs: [runDir], sessions: [hostSession, workerSession], root: 'host-1', clock: () => new Date('2026-09-29T09:05:00Z') });
  assert.equal(state.sources.length, 3);
  const agents = reduceEvents(state.events);
  assert.equal(agents.length, 3, 'host, native worker, and external lead all appear');
  const host = agents.find((a) => a.model === 'gpt-6-astra');
  const worker = agents.find((a) => a.model === 'deepseek/deepseek-v4.1-flash');
  const lead = agents.find((a) => a.model === 'claude-opus-5-5');
  assert.ok(host && worker && lead, JSON.stringify(agents.map((a) => a.model)));
  assert.equal(worker.parent, host.id, 'the worker keeps its real parent');
  assert.equal(host.steps.length, 2, 'the host plan is shown');
  assert.equal(host.steps[0].step, 'Plan step 1', 'plan text stays generic');
  assert.ok(host.usage.usage.outputTokens >= 40, 'host tokens are segmented');
  assert.ok(worker.usage.usage.outputTokens >= 500, 'worker tokens are segmented');
  const json = JSON.stringify(state);
  assert.ok(!json.includes('Define acceptance'), 'plan text never leaves the session');
  assert.ok(!json.includes('/Users/') && !json.includes(root), 'no paths in the public payload');
  assert.ok(!json.includes('host-1'), 'session ids are not exposed');
  const detailed = await viewerState({ sessions: [hostSession, workerSession], runs: [runDir], details: true });
  assert.ok(JSON.stringify(detailed).includes('Define acceptance'), 'explicit local details show the plan');
});

test('the public state exposes only allowlisted source fields', async (t) => {
  const root = await fixture(t);
  const dir = runFixture(path.join(root, 'opus-solo'), 'runs/lead-3', {
    events: realRunEvents(),
    summary: summaryFor({ usage: { 'claude-opus-5-5': { inputTokens: 5, outputTokens: 6, cacheReadInputTokens: 7, cacheCreationInputTokens: 8 } } }),
    run: { mode: 'solo' },
  });
  const state = await viewerState({ runs: [dir] });
  const source = state.sources[0];
  assert.deepEqual(Object.keys(source).sort(), ['checkedAt', 'errors', 'failureKind', 'kind', 'label', 'mode', 'model', 'partialLine', 'state', 'status', 'toolProfile'].sort());
  assert.equal(source.mode, 'solo');
  assert.equal(source.toolProfile, 'terminal');
  assert.equal(source.label, 'Source 1');
  assert.equal(state.usage, undefined, 'the raw usage block is not part of the public state');
  assert.equal(state.details, false);
  assert.match(state.coverage, /Only the run directories and session files you named are read/);
  const json = JSON.stringify(state);
  assert.ok(!json.includes(root) && !json.includes('inv-1') && !json.includes('phase-1'));
});

test('writeReplay writes a portable bundle from explicit sources only', async (t) => {
  const root = await fixture(t);
  const dir = runFixture(path.join(root, 'arm'), 'runs/lead-1', {
    events: realRunEvents(),
    summary: summaryFor({ usage: { 'claude-opus-5-5': { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }),
    run: { mode: 'solo' },
  });
  const out = path.join(root, 'out');
  const written = await writeReplay(out, bridgeRuns([dir]));
  assert.deepEqual(written.files, ['replay.jsonl', 'replay.json', 'usage-summary.json']);
  const bundle = JSON.parse(fs.readFileSync(path.join(out, 'replay.json'), 'utf8'));
  assert.equal(bundle.redacted, true);
  assert.ok(!JSON.stringify(bundle).includes('solo-lead'), 'portable export anonymizes agent identifiers');
  assert.ok(bundle.events.length >= 3);
  const usage = JSON.parse(fs.readFileSync(path.join(out, 'usage-summary.json'), 'utf8'));
  assert.equal(usage.runs.length, 1);
  assert.equal(usage.runs[0].label, 'arm');
  assert.ok(!JSON.stringify(usage).includes(root));
  assert.equal(fs.readFileSync(path.join(out, 'replay.jsonl'), 'utf8').trim().split('\n').length, bundle.events.length);
});

test('the viewer refuses to start without an explicit source', async (t) => {
  await assert.rejects(() => viewerState({ runs: [] }), /at least one --run, --session, or --events source is required/);
  const root = await fixture(t);
  const dir = runFixture(path.join(root, 'arm'), 'runs/lead-1', {
    events: realRunEvents().slice(0, 2),
    run: { mode: 'solo' },
  });
  const state = await viewerState({ runs: [dir] });
  assert.equal(state.mode, 'Live');
  assert.ok(state.events.length >= 2);
});

test('the request handler enforces host, origin, method, and token', async (t) => {
  const root = await fixture(t);
  const dir = runFixture(path.join(root, 'arm'), 'runs/lead-1', {
    events: realRunEvents().slice(0, 2),
    run: { mode: 'solo' },
  });
  const token = 'test-token-0123456789';
  const handler = createHandler({ token, port: 4318, runs: [dir] });

  const call = async (overrides = {}) => {
    const res = {
      statusCode: null, headers: {}, body: '',
      setHeader(key, value) { this.headers[key] = value; },
      writeHead(code) { this.statusCode = code; },
      end(body = '') { this.body = body; return this; },
    };
    const req = { method: 'GET', url: '/api/state', headers: { host: '127.0.0.1:4318' }, ...overrides };
    await handler(req, res);
    return res;
  };

  assert.equal((await call()).statusCode, 401, 'no token');
  assert.equal((await call({ headers: { host: 'evil.example' } })).statusCode, 403, 'wrong host');
  assert.equal((await call({ headers: { host: '127.0.0.1:4318', origin: 'https://evil.example' } })).statusCode, 403, 'cross-origin');
  assert.equal((await call({ method: 'POST' })).statusCode, 405, 'read-only');
  const ok = await call({ headers: { host: '127.0.0.1:4318', authorization: `Bearer ${token}` } });
  assert.equal(ok.statusCode, null);
  const state = JSON.parse(ok.body);
  assert.equal(state.mode, 'Live');
  assert.ok(state.events.length >= 2);
  assert.ok(ok.headers['Content-Security-Policy'].includes("default-src 'self'"));
  const page = await call({ url: '/', headers: { host: '127.0.0.1:4318' } });
  assert.match(String(page.body), /Agent activity/);
  const css = await call({ url: '/style.css', headers: { host: '127.0.0.1:4318' } });
  assert.ok(String(css.body).length > 100, 'the stylesheet is served');
  assert.equal((await call({ url: '/nope', headers: { host: '127.0.0.1:4318' } })).statusCode, 404);
  assert.equal(authorizeRequest({ method: 'GET', headers: { host: '127.0.0.1:4318' } }, { token, port: 4318 }), 0);
});

test('the vendored viewer assets ship with the package', () => {
  for (const file of ['viewer/src/model.mjs', 'viewer/src/adapter.mjs', 'viewer/src/tail.mjs', 'viewer/src/server.mjs', 'viewer/public/index.html', 'viewer/public/app.mjs', 'viewer/public/style.css', 'viewer/fixtures/sample.json']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'plugins/codex-on-crack/skills/crack', file)), `${file} must ship`);
  }
});

test('live session identity and top-level usage survive completion', async (t) => {
  const root = await fixture(t);
  const counters = { inputTokens: 11, outputTokens: 7, cacheReadInputTokens: 3, cacheCreationInputTokens: 0 };
  const dir = runFixture(root, 'live', {
    events: [...realRunEvents().slice(0, 4), runEvent('usage.recorded', '2026-09-29T10:00:05Z', {
      usage: { 'claude-opus-5-5': counters }, data: { usageScope: 'session' },
    })],
    run: { mode: 'solo', identity: { agentId: 'solo-lead', parentAgentId: 'host-thread-1' } },
  });
  const live = bridgeRun(dir, 0);
  assert.equal(live.usage.models['claude-opus-5-5'].outputTokens, 7);
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summaryFor({ usage: { 'claude-opus-5-5': counters } })));
  const finished = bridgeRun(dir, 0);
  assert.equal(live.run.agentId, finished.run.agentId, 'finishing must not create a second agent');
});

test('HTTP polling advances beyond the native-session read budget', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'long.jsonl');
  const stamp = '2026-09-29T10:00:00Z';
  const record = (type, payload) => JSON.stringify({ type, payload, timestamp: stamp }) + '\n';
  fs.writeFileSync(file, record('session_meta', { id: 'large-session' }));
  // Bounded ignored records exceed one Tail poll, without creating UI events.
  const padding = record('ignored_fixture', { padding: 'x'.repeat(65536) });
  fs.appendFileSync(file, padding.repeat(130));
  fs.appendFileSync(file, record('turn_context', { model: 'gpt-6-sol' }));
  let time = Date.parse(stamp);
  const handler = createHandler({ token: 'test', port: 4318, sessions: [file], clock: () => new Date(time) });
  const request = async () => {
    let body;
    await handler({ method: 'GET', url: '/api/state', headers: { host: '127.0.0.1:4318', authorization: 'Bearer test' } }, {
      setHeader() {}, writeHead() {}, end(value) { body = value; },
    });
    return JSON.parse(body);
  };
  assert.equal((await request()).sources[0].status, 'Loading');
  time += 2000;
  const after = await request();
  assert.equal(after.sources[0].status, 'Watching');
  assert.ok(after.events.some((e) => e.type === 'model.observed' && e.data.model === 'gpt-6-sol'));
});


test('final usage activity remains visible after trailing adapter events', async (t) => {
  const root = await fixture(t);
  const dir = runFixture(root, 'run', {
    events: realRunEvents(),
    summary: summaryFor({ usage: { 'claude-opus-5-5': { inputTokens: 5, outputTokens: 6, costUSD: 0.5 } } }),
  });
  const agents = reduceEvents(bridgeRuns([dir]).events);
  assert.match(agents[0].activity, /list-price equivalent/);
  assert.match(agents[0].activity, /tool calls/);
});
