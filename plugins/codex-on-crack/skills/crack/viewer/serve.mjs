#!/usr/bin/env node
// Token-protected localhost viewer for codex-on-crack work.
//
// Sources are explicit and may be mixed in one view:
//   --run <dir>      an external-lead adapter run directory (live or finished)
//   --session <file> a Codex session jsonl (host and/or native worker)
//   --events <file>  a normalized viewer event file
// Nothing scans for sessions. The public payload is allowlisted: labels, models,
// statuses, counters, and generic activity only. Paths, ids, phases, prompts,
// tool arguments, and billing strings are never returned.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { bridgeRuns } from './bridge.mjs';
import { selectEvents } from './src/adapter.mjs';
import { Tail } from './src/tail.mjs';
import { safeModelLabel } from './src/model.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = new Map([
  ['/', 'public/index.html'],
  ['/app.mjs', 'public/app.mjs'],
  ['/style.css', 'public/style.css'],
  ['/model.mjs', 'src/model.mjs'],
]);
const COVERAGE = 'Only the run directories and session files you named are read. Missing workers, undeclared plans, and unrelated sessions are never inferred. Usage reflects recorded counters only; account quota and human judgement are not.';
const STATUS = new Set(['Watching', 'Loading', 'Waiting', 'Unavailable']);
const MODES = new Set(['external-lead', 'solo', 'delegated']);
const TOOL_PROFILES = new Set(['files', 'terminal']);
const FAILURE_KINDS = new Set(['authentication_required', 'model_mismatch', 'incomplete_result', 'process_failed', 'deadline', 'run_failed']);

// Public source descriptor: allowlisted codes only, no paths or free text.
function publicSource(index, source) {
  return {
    label: `Source ${index + 1}`,
    kind: source.kind,
    status: STATUS.has(source.status) ? source.status : 'Watching',
    checkedAt: typeof source.checkedAt === 'string' ? source.checkedAt : null,
    errors: Number.isSafeInteger(source.errors) ? source.errors : 0,
    partialLine: source.partialLine === true,
    state: ['running', 'completed', 'failed'].includes(source.state) ? source.state : null,
    mode: MODES.has(source.mode) ? source.mode : null,
    toolProfile: TOOL_PROFILES.has(source.toolProfile) ? source.toolProfile : null,
    failureKind: FAILURE_KINDS.has(source.failureKind) ? source.failureKind : null,
    model: source.model ? safeModelLabel(source.model) : null,
  };
}

export async function viewerState({ runs = [], sessions = [], events = [], root = null, clock = () => new Date(), details = false, tailsState = null } = {}) {
  if (!runs.length && !sessions.length && !events.length) throw new Error('at least one --run, --session, or --events source is required');
  const collected = [];
  const sources = [];

  if (runs.length) {
    const bridged = bridgeRuns(runs, { clock });
    collected.push(...bridged.events);
    bridged.runs.forEach((run) => sources.push({
      kind: 'run', status: 'Watching', checkedAt: clock().toISOString(), errors: 0, partialLine: false,
      state: run.state, mode: run.mode, toolProfile: run.toolProfile, failureKind: run.failureKind, model: run.model,
    }));
  }

  if (sessions.length || events.length) {
    const tails = tailsState ?? [];
    if (!tailsState) {
      for (const file of sessions) tails.push(new Tail(path.resolve(file), tails.length, details, false));
      for (const file of events) tails.push(new Tail(path.resolve(file), tails.length, details, true));
    }
    await Promise.all(tails.map((tail) => tail.poll()));
    const rootId = root ?? tails[0]?.adapter.id ?? null;
    if (rootId) collected.push(...selectEvents(tails.map((tail) => tail.adapter), rootId, null));
    tails.forEach((tail) => sources.push({
      kind: tail.normalized ? 'events' : 'session', status: tail.status, checkedAt: tail.checkedAt ?? null,
      errors: tail.adapter.errors, partialLine: tail.pending.length > 0, state: null, mode: null, toolProfile: null, failureKind: null, model: null,
    }));
  }

  const seen = new Set();
  const ordered = collected
    .filter((event) => {
      if (seen.has(event.eventId)) return false;
      seen.add(event.eventId);
      return true;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((event, index) => ({ ...event, eventId: `event-${index + 1}` }));

  // Session-sourced agents are re-identified by a stable hash, so a session id
  // never reaches the browser while relationships and totals stay intact.
  const aliases = new Map();
  const alias = (id) => {
    if (typeof id !== 'string' || !id) return id ?? null;
    if (!aliases.has(id)) aliases.set(id, `agent-${createHash('sha256').update(id).digest('hex').slice(0, 8)}`);
    return aliases.get(id);
  };
  const publiclyOrdered = ordered.map((event) => ({
    ...event,
    agentId: alias(event.agentId),
    parentAgentId: event.parentAgentId ? alias(event.parentAgentId) : null,
  }));

  return {
    schemaVersion: 1,
    mode: 'Live',
    events: publiclyOrdered,
    details,
    since: null,
    sources: sources.map((source, index) => publicSource(index, source)),
    coverage: COVERAGE,
  };
}

// A read-only, same-origin, token-gated request handler.
export function authorizeRequest(req, { token, port }) {
  const expected = `127.0.0.1:${port}`;
  if (req.headers.host !== expected) return 403;
  if (req.headers.origin && req.headers.origin !== `http://${expected}`) return 403;
  if (req.method !== 'GET') return 405;
  return 0;
}

export function createHandler({ token, port, runs = [], sessions = [], events = [], root = null, clock = () => new Date(), details = false }) {
  // Keep incremental offsets across polls. Recreating Tail here on every
  // request would never advance past the 8 MB read budget of a large session.
  const tailsState = [];
  for (const file of sessions) tailsState.push(new Tail(path.resolve(file), tailsState.length, details, false));
  for (const file of events) tailsState.push(new Tail(path.resolve(file), tailsState.length, details, true));
  let cached = null;
  let cachedAt = 0;
  let pending = null;
  const state = async () => {
    const now = clock().getTime();
    if (pending) return pending;
    if (cached === null || now - cachedAt > 1000) {
      pending = (async () => {
      try {
        cached = await viewerState({ runs, sessions, events, root, clock, details, tailsState });
      } catch (error) {
        cached = { schemaVersion: 1, mode: 'Unavailable', events: [], sources: [], error: 'source_unreadable', coverage: COVERAGE };
      }
      cachedAt = now;
      return cached;
      })();
      try { return await pending; } finally { pending = null; }
    }
    return cached;
  };
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const denial = authorizeRequest(req, { token, port });
    if (denial) {
      res.writeHead(denial);
      res.end(denial === 405 ? 'Read-only' : 'Forbidden');
      return;
    }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/api/state') {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401);
        res.end('Token required');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(await state()));
      return;
    }
    const asset = ASSETS.get(url.pathname);
    if (!asset) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    try {
      const file = path.resolve(here, asset);
      res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.mjs') ? 'text/javascript' : 'text/html');
      res.end(await fsp.readFile(file));
    } catch {
      res.writeHead(500);
      res.end('Asset unavailable');
    }
  };
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
    options: {
      run: { type: 'string', multiple: true }, session: { type: 'string', multiple: true },
      events: { type: 'string', multiple: true }, root: { type: 'string' },
      details: { type: 'boolean', default: false },
      port: { type: 'string', default: '4318' }, 'print-usage': { type: 'boolean' }, help: { type: 'boolean' },
    },
  });
  const sources = [...(values.run ?? []), ...(values.session ?? []), ...(values.events ?? [])];
  if (values.help || !sources.length) {
    process.stdout.write([
      'Usage: serve.mjs [--run <run-dir>] [--session <session.jsonl>] [--events <normalized.jsonl>] [--root <agent-id>] [--port 4318] [--print-usage]',
      'Reads only the sources you name and serves a token-protected localhost replay. No session scanning.',
      '--run  an external-lead adapter run directory (live or finished)',
      '--session  a Codex session jsonl (host and/or native worker)',
      '--events  a normalized viewer event file',
      '--details  opt in to local plan/assignment text; review it before sharing your screen',
      '',
    ].join('\n'));
    process.exitCode = values.help ? 0 : 2;
  } else {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
    const token = randomBytes(24).toString('hex');
    const options = {
      token, runs: [...new Set(values.run ?? [])], sessions: [...new Set(values.session ?? [])],
      events: [...new Set(values.events ?? [])], root: values.root ?? null, details: values.details,
    };
    if (values['print-usage']) {
      const state = await viewerState(options);
      process.stdout.write(`${JSON.stringify({ sources: state.sources, events: state.events.length }, null, 2)}\n`);
    }
    const server = http.createServer();
    // The handler needs the bound port, so it is created once listening.
    let handler = null;
    server.on('request', (req, res) => {
      if (handler === null) {
        res.writeHead(503);
        res.end('Starting');
        return;
      }
      handler(req, res);
    });
    server.listen(port, '127.0.0.1', () => {
      handler = createHandler({ ...options, port: server.address().port });
      process.stdout.write(`Viewer: http://127.0.0.1:${server.address().port}/#token=${token}\nWatching ${options.runs.length} run(s), ${options.sessions.length} session(s), ${options.events.length} event file(s), read-only. Usage is recorded counters only.\n`);
    });
    server.on('error', (error) => {
      process.stderr.write(`viewer: ${error.message}\n`);
      process.exitCode = 1;
    });
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
  }
}
