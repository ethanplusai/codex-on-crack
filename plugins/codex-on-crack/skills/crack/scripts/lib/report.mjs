// Run reports: plan state, plus real usage from codex-router logs when present.
// Nothing here estimates cost; numbers come only from records.
import { CrackError } from './io.mjs';

const TIMING = /^\[codex-router\] timing at=(\S+) model=(\S+) provider=(\S+) status=(\d+) .*?\bout_tokens=(\d+) cached_tokens=(\d+)/;

export function summarizePlan(plan) {
  const tasks = (Array.isArray(plan?.tasks) ? plan.tasks : []).map((task) => ({
    id: task.id,
    role: task.role,
    rung: task.rung ?? 'primary',
    state: task.state,
    review_cycles: task.review_cycles ?? 0,
  }));
  const count = (predicate) => tasks.filter(predicate).length;
  return {
    tasks,
    rung_count_semantics: 'Final task rungs, not the number of escalation events.',
    totals: {
      tasks: tasks.length,
      accepted: count((task) => task.state === 'accepted'),
      blocked: count((task) => task.state === 'blocked'),
      escalated_to_fallback: count((task) => task.rung === 'fallback'),
      taken_over_by_orchestrator: count((task) => task.rung === 'orchestrator'),
      review_cycles: tasks.reduce((sum, task) => sum + task.review_cycles, 0),
    },
  };
}

export function routerUsage(text, since = null) {
  const floor = since === null ? null : Date.parse(since);
  if (Number.isNaN(floor)) {
    throw new CrackError('usage', '--since must be an ISO 8601 time.', 'For example: 2026-09-21T10:00:00Z');
  }
  const byModel = {};
  for (const line of text.split('\n')) {
    const match = TIMING.exec(line);
    if (!match) continue;
    const [, at, model, provider, status, out, cached] = match;
    if (floor !== null && Date.parse(at) < floor) continue;
    byModel[model] ??= { provider, requests: 0, errors: 0, out_tokens: 0, cached_tokens: 0 };
    const row = byModel[model];
    row.requests += 1;
    if (status !== '200') row.errors += 1;
    row.out_tokens += Number(out);
    row.cached_tokens += Number(cached);
  }
  return byModel;
}

// Whole fresh sessions, identified by native metadata, not time windows.
const USAGE_FIELDS = ['input_tokens', 'cached_input_tokens', 'output_tokens'];
const zero = () => Object.fromEntries(USAGE_FIELDS.map((key) => [key, 0]));
function invalidUsage() {
  return new CrackError('invalid_usage', 'Usage is incomplete, contradictory, non-monotonic, or inconsistent.',
    'Do not publish totals until complete source accounting is reconciled.');
}
function counters(value) {
  if (!value || USAGE_FIELDS.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 0)
      || value.cached_input_tokens > value.input_tokens
      || (value.reasoning_output_tokens !== undefined && (!Number.isSafeInteger(value.reasoning_output_tokens)
        || value.reasoning_output_tokens < 0 || value.reasoning_output_tokens > value.output_tokens))
      || !Number.isSafeInteger(value.input_tokens + value.output_tokens)
      || (value.total_tokens !== undefined && value.total_tokens !== value.input_tokens + value.output_tokens)) throw invalidUsage();
  return Object.fromEntries(USAGE_FIELDS.map((key) => [key, value[key]]));
}
function add(a, b) {
  for (const key of USAGE_FIELDS) {
    a[key] += b[key];
    if (!Number.isSafeInteger(a[key])) throw invalidUsage();
  }
  if (!Number.isSafeInteger(a.input_tokens + a.output_tokens)) throw invalidUsage();
  return a;
}
const equal = (a, b) => USAGE_FIELDS.every((key) => a[key] === b[key]);
const signature = (value) => JSON.stringify(USAGE_FIELDS.map((key) => value[key]));
function sessionAccounting(session, responseOwners) {
  let model = 'unknown'; let provider = session.provider;
  let legacyPrevious = zero(); let threadPrevious = zero();
  let observedLegacy = false;
  const legacyGroups = new Map(); const responses = new Map(); const snapshots = [];
  const group = (groups, usage, label, route) => {
    const key = JSON.stringify([label, route]);
    if (!groups.has(key)) groups.set(key, { model: label, provider: route, ...zero() });
    add(groups.get(key), usage);
  };
  for (const record of session.records) {
    if (record.type === 'turn_context') {
      model = typeof record.payload?.model === 'string' ? record.payload.model : 'unknown';
      provider = typeof record.payload?.model_provider === 'string' ? record.payload.model_provider : session.provider;
    }
    const payload = record.type === 'event_msg' ? record.payload : record.type === 'token_usage_record' ? { ...record.payload, type: record.type } : null;
    if (payload?.type === 'token_count') {
      const raw = payload.info?.total_token_usage;
      if (raw === undefined || raw === null) continue; // heartbeat without accounting
      const total = counters(raw);
      if (USAGE_FIELDS.some((key) => total[key] < legacyPrevious[key])) throw invalidUsage();
      const delta = Object.fromEntries(USAGE_FIELDS.map((key) => [key, total[key] - legacyPrevious[key]]));
      if (delta.cached_input_tokens > delta.input_tokens) throw invalidUsage();
      group(legacyGroups, delta, model, provider);
      snapshots.push(total); legacyPrevious = total; observedLegacy = true;
    } else if (payload?.type === 'token_usage_record') {
      if (typeof payload.response_id !== 'string' || !payload.response_id) throw invalidUsage();
      const usage = counters(payload.usage);
      const rawThread = payload.thread_token_usage;
      const thread = rawThread === undefined || rawThread === null ? null : counters(rawThread.total_token_usage ?? rawThread);
      const label = typeof payload.model === 'string' ? payload.model : model;
      const route = typeof payload.model_provider === 'string' ? payload.model_provider : provider;
      const prior = responses.get(payload.response_id);
      if (responseOwners.has(payload.response_id) && responseOwners.get(payload.response_id) !== session.id) throw invalidUsage();
      responseOwners.set(payload.response_id, session.id);
      if (prior) {
        if (!equal(prior.usage, usage) || prior.model !== label || prior.provider !== route
            || (prior.thread && thread && !equal(prior.thread, thread))
            || (prior.reasoning !== undefined && payload.usage.reasoning_output_tokens !== undefined && prior.reasoning !== payload.usage.reasoning_output_tokens)) throw invalidUsage();
        if (thread) { prior.thread ??= thread; snapshots.push(thread); }
        continue;
      }
      if (thread) {
        if (USAGE_FIELDS.some((key) => thread[key] < threadPrevious[key])) throw invalidUsage();
        threadPrevious = thread; snapshots.push(thread);
      }
      responses.set(payload.response_id, { usage, model: label, provider: route, thread, reasoning: payload.usage.reasoning_output_tokens });
    }
  }
  let total = legacyPrevious; let groups = legacyGroups;
  if (responses.size) {
    total = zero(); groups = new Map(); const prefixes = new Set([signature(total)]);
    for (const response of responses.values()) {
      add(total, response.usage); prefixes.add(signature(total));
      group(groups, response.usage, response.model, response.provider);
      // A thread checkpoint must account for exactly this response and its predecessors.
      if (response.thread && !equal(response.thread, total)) throw invalidUsage();
    }
    // Legacy snapshots can appear before or after the corresponding response
    // records. Match known response prefixes, never add both accounting streams.
    if (snapshots.some((snapshot) => !prefixes.has(signature(snapshot)))) throw invalidUsage();
  }
  const observed = observedLegacy || responses.size > 0;
  return { session_id: session.id, parent_session_id: session.parent,
    usage: observed ? { ...total, uncached_input_tokens: total.input_tokens - total.cached_input_tokens } : null,
    by_model: [...groups.values()], accounting: responses.size ? 'deduplicated-responses' : observedLegacy ? 'cumulative-snapshots' : 'unknown',
    response_count: responses.size || null };
}
export function sessionUsage(logs, rootId) {
  if (typeof rootId !== 'string' || !rootId) throw new CrackError('usage', '--root-session is required with --session-log.', 'Use the ID of a fresh trial root session.');
  const sessions = new Map();
  for (const text of logs) {
    let records;
    try { records = text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
      if (records.some((record) => record === null || typeof record !== 'object' || Array.isArray(record))) throw new Error();
    } catch { throw new CrackError('invalid_session_log', 'A session log is not valid JSONL.', 'Use complete exported session logs.'); }
    const metadata = records.filter((record) => record.type === 'session_meta');
    const meta = metadata[0]?.payload;
    if (typeof meta?.id !== 'string' || !meta.id) throw new CrackError('missing_session_id', 'A log has no native session ID.', 'Export the complete session, including its metadata.');
    if (metadata.length !== 1) throw new CrackError('duplicate_session', 'An export must contain exactly one session metadata record.', 'Supply one complete export per session.');
    if (sessions.has(meta.id)) {
      if (sessions.get(meta.id).raw === text) continue;
      throw new CrackError('duplicate_session', 'Different exports claim the same session ID.', 'Supply one complete export per session.');
    }
    sessions.set(meta.id, { raw: text, records, id: meta.id,
      provider: typeof meta.model_provider === 'string' ? meta.model_provider : 'unknown',
      parent: meta.source?.subagent?.thread_spawn?.parent_thread_id ?? meta.source?.subagent?.spawn?.parent_thread_id ?? meta.parent_session_id ?? null });
  }
  if (!sessions.has(rootId)) throw new CrackError('root_missing', 'The root session is not in these exports.', 'Include its complete log.');
  const belongs = (id, seen = new Set()) => {
    if (id === rootId) return true;
    if (!sessions.has(id) || seen.has(id)) return false;
    seen.add(id); return belongs(sessions.get(id).parent, seen);
  };
  const rows = []; const responseOwners = new Map();
  for (const session of sessions.values()) if (belongs(session.id)) rows.push(sessionAccounting(session, responseOwners));
  const complete = rows.every((row) => row.usage !== null);
  const total = complete ? rows.reduce((sum, row) => add(sum, row.usage), zero()) : null;
  if (total) total.uncached_input_tokens = total.input_tokens - total.cached_input_tokens;
  return { source: 'Codex session JSONL', root_session_id: rootId, sessions: rows, totals: total,
    excluded_unrelated_sessions: sessions.size - rows.length, supplied_logs_have_usage: complete,
    coverage: 'Only the supplied root and linked descendants are counted. Complete fresh-session exports are required; the caller must verify that all descendants were exported.',
    billing: null, serving_identity_verified: false,
    note: 'Whole fresh-session client usage, not account quota or billed cost. Cached input is a subset of input. Reasoning output is not added a second time. Client model labels are not service identity proof.' };
}
