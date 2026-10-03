#!/usr/bin/env node
// Project one or more codex-on-crack run directories into the portable viewer
// replay. Sources are explicit: only directories named with --run are read, and
// nothing scans for sessions.
//
// A run may still be in flight. The bridge reads run.json plus the public event
// stream and reports a provisional state; it does not wait for summary.json.
//
// Privacy: every projected string is either an allowlisted code, a sanitised
// model label, or a redacted display label. Paths, invocation ids, request ids,
// session ids, phases, and billing strings never enter the public payload; the
// local usage summary keeps only labels and counters.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { clean } from './src/adapter.mjs';
import { safeModelLabel, safeReplay, validateEvent } from './src/model.mjs';

const USAGE_KEY_MAP = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'];
const MODES = new Set(['external-lead', 'solo', 'delegated']);
const TOOL_PROFILES = new Set(['files', 'terminal']);
const FAILURE_KINDS = new Set(['authentication_required', 'model_mismatch', 'incomplete_result', 'process_failed', 'deadline', 'run_failed']);
const BILLING = new Set(['not-billed-via-api', 'api-billed', 'unknown']);
const SAFE_ID = /[^A-Za-z0-9._:-]/g;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A malformed line is dropped; the run keeps its own raw capture.
    }
  }
  return out;
}

function safeId(value, fallback) {
  if (typeof value !== 'string' || !value) return fallback;
  const cleaned = value.replace(SAFE_ID, '_').slice(0, 64);
  return cleaned || fallback;
}

// Short display label: a directory name, never a path, redacted if it looks
// like anything sensitive.
const GENERIC_DIR = /^(?:runs?|builds?|\.local|cache|plugins|tmp|dist|home)$/;
function runLabel(runDir) {
  const candidates = [
    path.basename(path.dirname(runDir)),
    path.basename(path.dirname(path.dirname(runDir))),
    path.basename(runDir),
  ];
  for (const candidate of candidates) {
    const label = clean(candidate);
    if (label && label !== '[local path]' && !GENERIC_DIR.test(label)) return label;
  }
  const fallback = clean(path.basename(runDir));
  return fallback && fallback !== '[local path]' ? fallback : '';
}

function toolNameOf(event) {
  const name = event?.data?.toolName ?? event?.data?.name;
  return typeof name === 'string' && name ? clean(name) || 'Tool' : 'Tool';
}

function projectEvent(event, run) {
  const common = { schemaVersion: 1, eventId: event.eventId, agentId: run.agentId, parentAgentId: run.parentAgentId, at: event.at, data: {} };
  switch (event.type) {
    case 'agent.created':
      return { ...common, type: 'agent.created', data: { title: run.title } };
    case 'agent.started':
      return { ...common, type: 'agent.started', data: {} };
    case 'model.observed': {
      const model = safeModelLabel(event.observedModel ?? event.data?.model);
      if (model !== 'Unknown') run.model = model;
      return { ...common, type: 'model.observed', data: { model } };
    }
    case 'tool.started': {
      const name = toolNameOf(event);
      run.tools[name] = (run.tools[name] ?? 0) + 1;
      return { ...common, type: 'tool.started', data: { text: `${name} started` } };
    }
    case 'tool.finished': {
      const name = toolNameOf(event);
      const failed = event.data?.isError === true;
      if (failed) run.toolErrors += 1;
      return { ...common, type: 'tool.finished', data: { text: `${name} ${failed ? 'failed' : 'finished'}` } };
    }
    case 'permission.denied':
      return { ...common, type: 'activity.reported', data: { text: `Permission denied: ${toolNameOf(event)}` } };
    case 'profile.transition':
      return { ...common, type: 'activity.reported', data: { text: 'Tool profile widened with host authorization' } };
    case 'agent.returned':
      return { ...common, type: 'agent.returned', data: {} };
    case 'agent.cancelled':
      return { ...common, type: 'agent.cancelled', data: {} };
    case 'agent.failed':
      return { ...common, type: 'agent.failed', data: {} };
    default:
      return null;
  }
}

// One session-scope record per model per run, from the authoritative cumulative
// totals. Successive runs of the same Claude session are never summed; a
// different session is a different agent (see the session token in agentId).
function usageEvent(run, model, usage, at, eventId, completeness, counterKind) {
  const projected = {};
  for (const field of USAGE_KEY_MAP) {
    const value = usage?.[field];
    if (value === undefined || value === null) continue;
    if (!Number.isSafeInteger(value) || value < 0) return null;
    projected[field] = value;
  }
  if (!Number.isSafeInteger(projected.inputTokens) || !Number.isSafeInteger(projected.outputTokens)) return null;
  return validateEvent({
    schemaVersion: 1,
    eventId,
    agentId: run.agentId,
    parentAgentId: run.parentAgentId,
    at,
    type: 'usage.recorded',
    data: { scope: 'session', counterKind, completeness, model: safeModelLabel(model), usage: projected },
  });
}

function usageLine(usage) {
  if (!usage) return 'usage not recorded for this invocation';
  const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
  const parts = [`${total.toLocaleString('en-US')} tokens recorded`];
  if (typeof usage.billedUsd === 'number') parts.push(`billed $${usage.billedUsd.toFixed(2)}`);
  else if (typeof usage.equivalentUsd === 'number') parts.push(`list-price equivalent $${usage.equivalentUsd.toFixed(2)} (not a charge)`);
  else parts.push('cost unavailable');
  return parts.join(' · ');
}

// Map one run directory. Works before the run finishes: run.json plus the event
// stream are enough for a provisional state.
export function bridgeRun(runDir, index, { clock = () => new Date() } = {}) {
  const dir = path.resolve(runDir);
  const summary = readJson(path.join(dir, 'summary.json'));
  const profile = readJson(path.join(dir, 'run.json'));
  const resumeDelta = readJson(path.join(dir, 'resume-delta.json'));
  if (summary === null && profile === null) throw new Error(`--run ${runDir} has no readable run.json or summary.json`);
  // Prefer the already-redacted public stream when it exists.
  const publicStream = readJsonl(path.join(dir, 'events.public.jsonl'));
  const raw = publicStream.length ? publicStream : readJsonl(path.join(dir, 'events.jsonl'));

  const streamedSession = raw.find((event) => event.type === 'agent.created' && typeof event.data?.sessionId === 'string')?.data.sessionId;
  const sessionId = summary?.sessionId || streamedSession || null;
  const sessionToken = sessionId === null ? 'nosession' : crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 8);
  const baseId = safeId(summary?.agentId ?? profile?.identity?.agentId, `run-${index + 1}`);
  const mode = MODES.has(summary?.mode) ? summary.mode : MODES.has(profile?.mode) ? profile.mode : 'unknown';
  const toolProfile = TOOL_PROFILES.has(summary?.toolProfile) ? summary.toolProfile : TOOL_PROFILES.has(profile?.toolProfile) ? profile.toolProfile : 'unknown';
  const role = mode === 'solo' ? 'Project lead · solo' : mode === 'external-lead' ? 'Project lead' : 'Agent';
  const label = runLabel(dir);
  const run = {
    label,
    agentId: `${baseId}~${sessionToken}`,
    parentAgentId: safeId(summary?.parentAgentId ?? profile?.identity?.parentAgentId, null),
    title: label ? `${role} · ${label}` : role,
    mode,
    toolProfile,
    state: summary === null ? 'running' : summary.ok === true ? 'completed' : 'failed',
    failureKind: FAILURE_KINDS.has(summary?.failureKind) ? summary.failureKind : null,
    model: null,
    tools: {},
    toolErrors: 0,
    startedAt: typeof summary?.startedAt === 'string' ? summary.startedAt : typeof profile?.startedAt === 'string' ? profile.startedAt : null,
    endedAt: typeof summary?.endedAt === 'string' ? summary.endedAt : null,
    wallDurationMs: Number.isSafeInteger(summary?.wallDurationMs) ? summary.wallDurationMs : null,
  };

  const events = [];
  let seq = 0;
  let provisionalSession = null;
  for (const source of raw) {
    if (!source || typeof source.type !== 'string') continue;
    const at = typeof source.at === 'string' && Number.isFinite(Date.parse(source.at)) ? source.at : (run.startedAt ?? clock().toISOString());
    if (source.type === 'usage.recorded') {
      // Session totals are emitted once, below, from the authoritative source.
      if (source.data?.usageScope === 'session') provisionalSession = { ...source, at };
      continue;
    }
    const projected = projectEvent({ ...source, eventId: `run-${index + 1}-${seq}` }, run);
    if (projected) {
      projected.at = at;
      events.push(projected);
    }
    seq += 1;
  }

  const deltaModels = resumeDelta?.delta?.models ?? resumeDelta?.models ?? null;
  const deltaCounterKind = resumeDelta?.delta?.counterKind ?? resumeDelta?.counterKind ?? null;
  const usage = {
    label,
    agentId: run.agentId,
    mode: run.mode,
    toolProfile: run.toolProfile,
    state: run.state,
    models: {},
    delta: deltaModels === null ? null : { counterKind: deltaCounterKind, models: deltaModels, note: 'This invocation only. Never add it to the cumulative totals.' },
    note: 'Authoritative cumulative session totals per model. Never add successive runs together.',
  };
  const reported = summary?.modelUsage;
  if (reported && typeof reported === 'object' && Object.keys(reported).length) {
    const at = run.endedAt ?? run.startedAt ?? clock().toISOString();
    for (const [model, entry] of Object.entries(reported)) {
      const event = usageEvent(run, model, entry, at, `run-${index + 1}-usage-${Object.keys(usage.models).length}`, 'final', 'authoritative-total');
      if (event === null) continue;
      events.push(event);
      usage.models[model] = {
        ...Object.fromEntries(USAGE_KEY_MAP.map((field) => [field, Number.isSafeInteger(entry[field]) ? entry[field] : null])),
        equivalentUsd: typeof entry.costUSD === 'number' && Number.isFinite(entry.costUSD) ? entry.costUSD : (typeof summary.usage?.equivalentUsd === 'number' ? summary.usage.equivalentUsd : null),
        billedUsd: typeof summary.usage?.billedUsd === 'number' ? summary.usage.billedUsd : null,
        billing: BILLING.has(summary.usage?.billing) ? summary.usage.billing : null,
        note: 'List-price equivalent from the CLI, not an actual charge.',
      };
    }
  } else if (provisionalSession?.usage || provisionalSession?.data?.usage) {
    // A live run may have streamed a session counter before finishing.
    for (const [model, entry] of Object.entries(provisionalSession.usage ?? provisionalSession.data.usage)) {
      const event = usageEvent(run, model, entry, provisionalSession.at, `run-${index + 1}-usage-${Object.keys(usage.models).length}`, 'provisional', 'cumulative-snapshot');
      if (event === null) continue;
      events.push(event);
      usage.models[model] = {
        ...Object.fromEntries(USAGE_KEY_MAP.map((field) => [field, Number.isSafeInteger(entry?.[field]) ? entry[field] : null])),
        equivalentUsd: null,
        billedUsd: null,
        billing: null,
        note: 'Running session counter; not final.',
      };
    }
    usage.note = 'Running session counter while the run is still active.';
  } else {
    usage.note = 'No usage counter was recorded for this run yet; nothing is inferred.';
  }

  // A final, meaningful "latest activity": the tool mix plus visible usage.
  const toolNames = Object.entries(run.tools).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const totalCalls = toolNames.reduce((sum, [, count]) => sum + count, 0);
  const mix = toolNames.slice(0, 4).map(([name, count]) => `${name} ${count}`).join(', ');
  const firstModel = Object.keys(usage.models)[0] ?? null;
  const stateWord = run.state === 'completed' ? 'Completed' : run.state === 'failed' ? `Failed${run.failureKind ? ` (${run.failureKind})` : ''}` : 'Running';
  const activity = totalCalls === 0
    ? `${stateWord} · no tool calls recorded · ${usageLine(firstModel === null ? null : usage.models[firstModel])}`
    : `${stateWord} · ${totalCalls} tool call${totalCalls === 1 ? '' : 's'}${mix ? ` (${mix})` : ''} · ${usageLine(firstModel === null ? null : usage.models[firstModel])}`;
  events.push(validateEvent({
    schemaVersion: 1,
    eventId: `run-${index + 1}-activity`,
    agentId: run.agentId,
    parentAgentId: run.parentAgentId,
    at: events.reduce((latest, event) => Date.parse(event.at) > Date.parse(latest) ? event.at : latest,
      run.endedAt ?? run.startedAt ?? clock().toISOString()),
    type: 'activity.reported',
    data: { text: activity },
  }));

  return { run, events, usage };
}

export function bridgeRuns(runDirs, options = {}) {
  const runs = [];
  const events = [];
  const usageRuns = [];
  runDirs.forEach((dir, index) => {
    const result = bridgeRun(dir, index, options);
    runs.push(result.run);
    events.push(...result.events);
    usageRuns.push({
      label: result.run.label, agentId: result.run.agentId, mode: result.run.mode,
      toolProfile: result.run.toolProfile, state: result.run.state, usage: result.usage,
    });
  });
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const seen = new Set();
  const minted = events.map((event, index) => {
    let id = `event-${index + 1}`;
    while (seen.has(id)) id += 'x';
    seen.add(id);
    return { ...event, eventId: id };
  });
  return {
    events: minted,
    runs,
    usage: {
      schemaVersion: 1,
      runs: usageRuns,
      note: 'Per-run cumulative totals. Account quota, subscription value, and human quality are not inferred.',
      generatedAt: (options.clock ?? (() => new Date()))().toISOString(),
    },
  };
}

export async function writeReplay(outDir, result, { bundle = true } = {}) {
  const dir = path.resolve(outDir);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const replay = safeReplay(result.events, 'Recorded');
  const jsonl = `${replay.events.map((e) => JSON.stringify(e)).join('\n')}${replay.events.length ? '\n' : ''}`;
  await fsp.writeFile(path.join(dir, 'replay.jsonl'), jsonl, { mode: 0o600 });
  if (bundle) {
    await fsp.writeFile(path.join(dir, 'replay.json'), `${JSON.stringify(replay, null, 2)}\n`, { mode: 0o600 });
  }
  await fsp.writeFile(path.join(dir, 'usage-summary.json'), `${JSON.stringify(result.usage, null, 2)}\n`, { mode: 0o600 });
  return { dir, files: ['replay.jsonl', ...(bundle ? ['replay.json'] : []), 'usage-summary.json'] };
}

function isEntrypoint(argv = process.argv, moduleUrl = import.meta.url) {
  const target = argv[1];
  if (typeof target !== 'string' || target === '' || target === '-') return false;
  try {
    return fs.realpathSync(target) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const { values } = parseArgs({
    strict: true,
    options: { run: { type: 'string', multiple: true }, out: { type: 'string' }, 'no-bundle': { type: 'boolean' }, help: { type: 'boolean' } },
  });
  if (values.help || !values.run?.length || !values.out) {
    process.stdout.write('Usage: bridge.mjs --run <run-dir> [--run <dir>] --out <output-dir>\nProjects named codex-on-crack run directories into a portable viewer replay. A run may still be in flight. Only explicit --run sources are read.\n');
    process.exitCode = values.help ? 0 : 2;
  } else {
    try {
      const result = bridgeRuns(values.run);
      const written = await writeReplay(values.out, result, { bundle: !values['no-bundle'] });
      process.stdout.write(`${JSON.stringify({
        ok: true,
        events: result.events.length,
        runs: result.runs.map((run) => ({
          label: run.label, agentId: run.agentId, title: run.title, mode: run.mode,
          toolProfile: run.toolProfile, state: run.state, failureKind: run.failureKind, tools: run.tools,
        })),
        models: [...new Set(result.usage.runs.flatMap((entry) => Object.keys(entry.usage.models ?? {})))].sort(),
        out: written.dir,
        files: written.files,
      }, null, 2)}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: 'bridge_failed', message: error.message }, null, 2)}\n`);
      process.exitCode = 2;
    }
  }
}
