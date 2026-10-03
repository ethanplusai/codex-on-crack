// Structured request/result protocol for the optional external project lead.
//
// This module is pure: it validates documents the host already received and
// describes the host action a request implies. It never spawns anything, never
// reads a request file from disk, and never executes model- or lead-authored
// content. A lead request is data; the Codex host decides whether to act on it.
import { CrackError } from './io.mjs';
import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const EXTERNAL_LEAD_MODEL = 'claude-opus-5-5';
export const LEAD_ROUTE = 'subscription';
export const MAX_ID_CHARS = 128;

export const LEAD_MODES = Object.freeze(['external-lead', 'solo']);
// Where a recorded executor actually ran. Keeps accounting honest: a
// subscription lead, a Router worker, a host action, and a billed API call are
// different things.
export const EXECUTOR_ROUTES = Object.freeze(['subscription', 'router', 'api', 'host', 'unknown']);
export const REQUEST_KINDS = Object.freeze(['worker_assignment', 'host_validation', 'clarification', 'final_acceptance']);
export const REQUEST_STATUSES = Object.freeze(['pending', 'dispatched', 'completed', 'blocked', 'rejected', 'cancelled']);
export const TERMINAL_STATUSES = Object.freeze(['completed', 'blocked', 'rejected', 'cancelled']);

// Kinds the host may carry out. Nothing on this list is performed by a request
// file; it names the human-reviewed host action that a request asks for.
export const HOST_ACTIONS = Object.freeze({
  worker_assignment: { action: 'native_worker_dispatch', executor: 'codex-host' },
  host_validation: { action: 'host_validation', executor: 'codex-host' },
  clarification: { action: 'ask_user', executor: 'codex-host' },
  final_acceptance: { action: 'lead_acceptance', executor: 'codex-host' },
});

const ID_RE = new RegExp(`^[A-Za-z0-9._:-]{1,${MAX_ID_CHARS}}$`);
// Slash-qualified worker ids such as deepseek/deepseek-v4.1-flash are valid;
// a led result check only pins the model when the request names the lead.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
// A request that names one of these keys is trying to smuggle an executable
// action past the host. Reject the whole document instead of ignoring the key.
const FORBIDDEN_KEYS = /^(command|cmd|argv|args|shell|exec|execute|script|run|spawn|env|envvars|environment)$/i;
const REQUEST_KEYS = new Set([
  'schemaVersion', 'requestId', 'runId', 'phase', 'kind', 'agentId', 'parentAgentId',
  'lead', 'objective', 'workspace', 'acceptanceChecks', 'role', 'evidence', 'budget',
  'assignment', 'checks', 'question', 'resultRef', 'paths', 'notes',
]);
const LEAD_KEYS = new Set(['id', 'model', 'route']);
const BUDGET_KEYS = new Set(['authorized', 'usd', 'note']);
const ASSIGNMENT_KEYS = new Set(['role', 'brief', 'workspace', 'acceptanceChecks', 'evidenceRequirements']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Lexical, traversal-safe normalisation of an absolute path. `/approved/../x`
// collapses to `/x` (and is therefore not inside `/approved`); a path that
// climbs above the root is rejected rather than silently clamped.
export function normalizePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return null;
  const parts = [];
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `/${parts.join('/')}`;
}

export function isInsideRoot(root, candidate) {
  const base = normalizePath(root);
  const target = normalizePath(candidate);
  if (base === null || target === null) return false;
  return target === base || target.startsWith(base === '/' ? '/' : `${base}/`);
}

function checkId(value, label, { nullable = false } = {}) {
  if (nullable && (value === undefined || value === null)) return null;
  if (typeof value !== 'string' || !ID_RE.test(value)) return `${label} must be an identifier matching ${ID_RE}.`;
  return null;
}

function checkString(value, label, { max = 4000 } = {}) {
  if (typeof value !== 'string' || !value.trim()) return `${label} must be a non-empty string.`;
  if (value.length > max) return `${label} must be at most ${max} characters.`;
  return null;
}

function rejectUnknownKeys(doc, allowed, label) {
  const problems = [];
  for (const key of Object.keys(doc)) {
    if (FORBIDDEN_KEYS.test(key)) {
      problems.push(`${label}.${key} is not accepted: an external request may not carry executable actions.`);
    } else if (!allowed.has(key)) {
      problems.push(`${label}.${key} is not a recognised field.`);
    }
  }
  return problems;
}

// Validate a lead-authored request. Returns every problem it finds so the host
// can report the whole document at once instead of failing on the first key.
//
// `canonicalize` resolves symlinks and normalises `..` for scope checks. The
// default is lexical only; callers with filesystem access pass a real resolver
// so a symlink ancestor cannot widen an approved scope.
export function validateLeadRequest(input, { workspace = null, mode = 'external-lead', canonicalize = normalizePath } = {}) {
  const problems = [];
  if (!LEAD_MODES.includes(mode)) return { ok: false, problems: [`Unsupported mode ${JSON.stringify(mode)}.`], request: null };
  if (!isPlainObject(input)) return { ok: false, problems: ['Request must be a JSON object.'], request: null };
  problems.push(...rejectUnknownKeys(input, REQUEST_KEYS, 'request'));
  const resolve = (value) => {
    const lexical = normalizePath(value);
    if (lexical === null) return null;
    return canonicalize(value) ?? lexical;
  };

  if (input.schemaVersion !== SCHEMA_VERSION) problems.push(`request.schemaVersion must be ${SCHEMA_VERSION}.`);
  for (const [field, label] of [['requestId', 'request.requestId'], ['runId', 'request.runId'], ['phase', 'request.phase'], ['agentId', 'request.agentId']]) {
    const problem = checkId(input[field], label);
    if (problem) problems.push(problem);
  }
  const parent = checkId(input.parentAgentId, 'request.parentAgentId', { nullable: true });
  if (parent) problems.push(parent);
  if (!REQUEST_KINDS.includes(input.kind)) problems.push(`request.kind must be one of: ${REQUEST_KINDS.join(', ')}.`);
  if (mode === 'solo' && input.kind === 'worker_assignment') {
    problems.push('request.kind worker_assignment is rejected in solo mode: solo work does not dispatch a worker.');
  }
  const objective = checkString(input.objective, 'request.objective', { max: 8000 });
  if (objective) problems.push(objective);

  // The lead may only touch the workspace the host already approved.
  const permitted = workspace === null ? null : resolve(workspace);
  if (workspace !== null && permitted === null) {
    problems.push(`the permitted workspace ${JSON.stringify(workspace)} is not a usable absolute path.`);
  }
  const workspaceProblem = checkString(input.workspace, 'request.workspace');
  if (workspaceProblem) problems.push(workspaceProblem);
  else if (resolve(input.workspace) === null) problems.push('request.workspace must be an absolute path without traversal above the root.');
  else if (permitted !== null && !isInsideRoot(permitted, resolve(input.workspace))) {
    problems.push(`request.workspace ${input.workspace} is outside the permitted workspace ${workspace}.`);
  }
  if (Array.isArray(input.paths)) {
    for (const [index, entry] of input.paths.entries()) {
      const pathProblem = checkString(entry, `request.paths[${index}]`);
      if (pathProblem) problems.push(pathProblem);
      else if (resolve(entry) === null) problems.push(`request.paths[${index}] must be an absolute path without traversal above the root.`);
      else if (permitted !== null && !isInsideRoot(permitted, resolve(entry))) {
        problems.push(`request.paths[${index}] ${entry} is outside the permitted workspace ${permitted}.`);
      }
    }
  } else if (input.paths !== undefined) {
    problems.push('request.paths must be an array of absolute paths.');
  }

  if (!Array.isArray(input.acceptanceChecks) || input.acceptanceChecks.length === 0
    || input.acceptanceChecks.some((check) => checkString(check, 'request.acceptanceChecks[]'))) {
    problems.push('request.acceptanceChecks must be a non-empty array of strings.');
  }
  // A requested native role only makes sense when the host will dispatch one.
  if (input.kind === 'worker_assignment' || input.role !== undefined) {
    const role = checkString(input.role, 'request.role', { max: 200 });
    if (role) problems.push(role);
  }

  if (!isPlainObject(input.budget)) {
    problems.push('request.budget is required: a lead request must carry explicit spending authorization.');
  } else {
    problems.push(...rejectUnknownKeys(input.budget, BUDGET_KEYS, 'request.budget'));
    if (input.budget.authorized !== true) problems.push('request.budget.authorized must be true; the host never infers budget authorization.');
    if (!isFiniteNumber(input.budget.usd) || input.budget.usd < 0) problems.push('request.budget.usd must be a non-negative number.');
  }

  if (!isPlainObject(input.lead)) problems.push('request.lead is required.');
  else {
    problems.push(...rejectUnknownKeys(input.lead, LEAD_KEYS, 'request.lead'));
    const leadId = checkId(input.lead.id, 'request.lead.id');
    if (leadId) problems.push(leadId);
    if (input.lead.model !== EXTERNAL_LEAD_MODEL) {
      problems.push(`request.lead.model must be exactly ${EXTERNAL_LEAD_MODEL}; other routes need separate authorization.`);
    }
    if (input.lead.route !== undefined && input.lead.route !== LEAD_ROUTE) {
      problems.push(`request.lead.route must be ${LEAD_ROUTE} for the subscription adapter.`);
    }
  }

  if (input.kind === 'worker_assignment') {
    if (!isPlainObject(input.assignment)) problems.push('request.assignment is required for worker_assignment.');
    else {
      problems.push(...rejectUnknownKeys(input.assignment, ASSIGNMENT_KEYS, 'request.assignment'));
      const brief = checkString(input.assignment.brief, 'request.assignment.brief', { max: 20000 });
      if (brief) problems.push(brief);
      const assignmentRole = checkString(input.assignment.role, 'request.assignment.role', { max: 200 });
      if (assignmentRole) problems.push(assignmentRole);
      if (input.assignment.workspace !== undefined && input.assignment.workspace !== input.workspace) {
        problems.push('request.assignment.workspace must match request.workspace.');
      }
    }
  }
  if (input.kind === 'host_validation') {
    if (!Array.isArray(input.checks) || input.checks.length === 0 || input.checks.some((c) => checkString(c, 'request.checks[]'))) {
      problems.push('request.checks must be a non-empty array of strings for host_validation.');
    }
  }
  if (input.kind === 'clarification') {
    const question = checkString(input.question, 'request.question', { max: 4000 });
    if (question) problems.push(question);
  }
  if (input.kind === 'final_acceptance') {
    const resultRef = checkString(input.resultRef, 'request.resultRef', { max: 500 });
    if (resultRef) problems.push(resultRef);
  }
  if (input.notes !== undefined) {
    const notes = checkString(input.notes, 'request.notes', { max: 4000 });
    if (notes) problems.push(notes);
  }

  return {
    ok: problems.length === 0,
    problems,
    request: problems.length === 0
      ? normalizeRequest(input, { workspace: resolve(input.workspace), permittedWorkspace: permitted })
      : null,
  };
}

function normalizeRequest(input, { workspace, permittedWorkspace }) {
  const canonicalWorkspace = workspace ?? normalizePath(input.workspace);
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId: input.requestId,
    runId: input.runId,
    phase: input.phase,
    kind: input.kind,
    agentId: input.agentId,
    parentAgentId: input.parentAgentId ?? null,
    objective: input.objective.trim(),
    workspace: canonicalWorkspace,
    declaredWorkspace: input.workspace,
    acceptanceChecks: [...input.acceptanceChecks],
    role: input.role,
    evidence: input.evidence ?? null,
    budget: { authorized: true, usd: input.budget.usd, note: input.budget.note ?? null },
    paths: Array.isArray(input.paths) ? [...input.paths] : [],
    notes: input.notes ?? null,
    lead: { id: input.lead.id, model: input.lead.model, route: input.lead.route ?? LEAD_ROUTE },
    permittedWorkspace: permittedWorkspace ?? canonicalWorkspace,
    ...(input.assignment === undefined ? {} : { assignment: { ...input.assignment } }),
    ...(input.checks === undefined ? {} : { checks: [...input.checks] }),
    ...(input.question === undefined ? {} : { question: input.question }),
    ...(input.resultRef === undefined ? {} : { resultRef: input.resultRef }),
  };
}

// The host-owned description of what a validated request asks a person to run.
// The `executed` flag is always false here: this module cannot execute anything.
export function hostActionEnvelope(request, { mode = 'external-lead' } = {}) {
  const mapping = HOST_ACTIONS[request.kind];
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId: request.requestId,
    runId: request.runId,
    phase: request.phase,
    agentId: request.agentId,
    parentAgentId: request.parentAgentId,
    kind: request.kind,
    action: mapping.action,
    executor: mapping.executor,
    lead: request.lead,
    mode,
    workspace: request.permittedWorkspace,
    executed: false,
    requires_host_action: true,
    automatic_execution: false,
    instructions: mode === 'solo'
      ? 'Solo mode: the external lead performs the implementation itself inside the permitted workspace. The Codex host only performs explicitly scoped tool mediation (for example browser or desktop actions) and records the outcome. No worker is dispatched.'
      : 'The Codex host validates scope, permissions, and budget, then performs this action with its own tools and records the result.',
  };
}

// A lead result may only claim the requested lead model when the executor is
// the subscription route. Worker results use validateWorkerResult instead and
// may carry any slash-qualified model id.
export function validateLeadResult(input, { request = null, role = 'lead' } = {}) {
  const problems = [];
  if (!isPlainObject(input)) return { ok: false, problems: ['Result must be a JSON object.'], result: null };
  for (const key of ['schemaVersion', 'requestId', 'runId', 'status', 'outcome', 'executor', 'observedModel', 'usage', 'evidence', 'at']) {
    if (input[key] === undefined || input[key] === null) problems.push(`result.${key} is required.`);
  }
  if (input.schemaVersion !== undefined && input.schemaVersion !== SCHEMA_VERSION) problems.push(`result.schemaVersion must be ${SCHEMA_VERSION}.`);
  if (checkId(input.requestId, 'result.requestId')) problems.push(checkId(input.requestId, 'result.requestId'));
  if (checkId(input.runId, 'result.runId')) problems.push(checkId(input.runId, 'result.runId'));
  if (!REQUEST_STATUSES.includes(input.status)) problems.push(`result.status must be one of: ${REQUEST_STATUSES.join(', ')}.`);
  if (input.status !== undefined && !TERMINAL_STATUSES.includes(input.status)) {
    problems.push('result.status must be a terminal status; an open request stays recorded as pending.');
  }
  const outcome = checkString(input.outcome, 'result.outcome', { max: 8000 });
  if (outcome) problems.push(outcome);
  const executor = checkString(input.executor, 'result.executor', { max: 200 });
  if (executor) problems.push(executor);
  if (typeof input.observedModel !== 'string' || !MODEL_RE.test(input.observedModel)) {
    problems.push('result.observedModel must be an exact model id; slash-qualified worker ids are allowed.');
  }
  if (input.executorRoute !== undefined && !EXECUTOR_ROUTES.includes(input.executorRoute)) {
    problems.push(`result.executorRoute must be one of: ${EXECUTOR_ROUTES.join(', ')}.`);
  }
  if (!Array.isArray(input.evidence) || input.evidence.some((item) => checkString(item, 'result.evidence[]', { max: 2000 }))) {
    problems.push('result.evidence must be an array of strings.');
  } else if (input.evidence.length === 0 && input.status === 'completed') {
    problems.push('result.evidence must not be empty for a completed result; the host records what it actually observed.');
  }
  checkUsage(input.usage, problems);
  if (input.at !== null && typeof input.at !== 'string') problems.push('result.at must be an ISO timestamp string.');
  if (request) {
    if (request.requestId !== input.requestId) problems.push(`result.requestId ${input.requestId} does not match request ${request.requestId}.`);
    if (request.runId !== input.runId) problems.push(`result.runId ${input.runId} does not match request ${request.runId}.`);
  }
  const executorRoute = input.executorRoute ?? (role === 'lead' ? LEAD_ROUTE : null);
  if (role === 'lead' && request?.lead?.model && executorRoute === LEAD_ROUTE && input.observedModel !== request.lead.model) {
    problems.push(`result.observedModel ${input.observedModel} is not the requested lead model ${request.lead.model}.`);
    problems.push('a lead result on the subscription route must report the exact requested model; use a worker result for another model.');
  }
  return { ok: problems.length === 0, problems, result: problems.length === 0 ? { ...input } : null };
}

// Host- or worker-authored results carry any exact model id (including a
// slash-qualified Router id) and their own usage provenance. They are not held
// to the external lead's model identity.
export function validateWorkerResult(input, { request = null } = {}) {
  const problems = [];
  if (!isPlainObject(input)) return { ok: false, problems: ['Result must be a JSON object.'], result: null };
  for (const key of ['schemaVersion', 'runId', 'agentId', 'status', 'outcome', 'executor', 'observedModel', 'usage', 'at']) {
    if (input[key] === undefined || input[key] === null) problems.push(`result.${key} is required.`);
  }
  if (input.schemaVersion !== undefined && input.schemaVersion !== SCHEMA_VERSION) problems.push(`result.schemaVersion must be ${SCHEMA_VERSION}.`);
  const runProblem = checkId(input.runId, 'result.runId');
  if (runProblem) problems.push(runProblem);
  const agentProblem = checkId(input.agentId, 'result.agentId');
  if (agentProblem) problems.push(agentProblem);
  if (input.requestId !== undefined && input.requestId !== null) {
    const requestProblem = checkId(input.requestId, 'result.requestId');
    if (requestProblem) problems.push(requestProblem);
  }
  if (!REQUEST_STATUSES.includes(input.status)) problems.push(`result.status must be one of: ${REQUEST_STATUSES.join(', ')}.`);
  if (input.status !== undefined && !TERMINAL_STATUSES.includes(input.status)) {
    problems.push('result.status must be a terminal status; an open request stays recorded as pending.');
  }
  const outcome = checkString(input.outcome, 'result.outcome', { max: 8000 });
  if (outcome) problems.push(outcome);
  const executorProblem = checkString(input.executor, 'result.executor', { max: 200 });
  if (executorProblem) problems.push(executorProblem);
  if (typeof input.observedModel !== 'string' || !MODEL_RE.test(input.observedModel)) {
    problems.push('result.observedModel must be an exact model id; slash-qualified worker ids are allowed.');
  }
  if (input.executorRoute !== undefined && !EXECUTOR_ROUTES.includes(input.executorRoute)) {
    problems.push(`result.executorRoute must be one of: ${EXECUTOR_ROUTES.join(', ')}.`);
  }
  if (!Array.isArray(input.evidence) || input.evidence.some((item) => checkString(item, 'result.evidence[]', { max: 2000 }))) {
    problems.push('result.evidence must be an array of strings.');
  } else if (input.evidence.length === 0 && input.status === 'completed') {
    problems.push('result.evidence must not be empty for a completed result.');
  }
  checkUsage(input.usage, problems);
  if (typeof input.at !== 'string') problems.push('result.at must be an ISO timestamp string.');
  if (request) {
    if (request.requestId && input.requestId && request.requestId !== input.requestId) {
      problems.push(`result.requestId ${input.requestId} does not match request ${request.requestId}.`);
    }
  }
  return { ok: problems.length === 0, problems, result: problems.length === 0 ? { ...input } : null };
}

function checkUsage(usage, problems) {
  if (!isPlainObject(usage)) {
    problems.push('result.usage must be an object.');
    return;
  }
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens']) {
    const value = usage[field];
    if (value === undefined || value === null) continue;
    if (!Number.isSafeInteger(value) || value < 0) problems.push(`result.usage.${field} must be a non-negative integer or null.`);
  }
  if (usage.billing !== undefined && !['not-billed-via-api', 'api-billed', 'unknown'].includes(usage.billing)) {
    problems.push('result.usage.billing must be not-billed-via-api, api-billed, or unknown.');
  }
  for (const field of ['billedUsd', 'equivalentUsd', 'accountQuota']) {
    const value = usage[field];
    if (value === undefined || value === null) continue;
    if (!isFiniteNumber(value) || value < 0) problems.push(`result.usage.${field} must be a non-negative number or null; unknown stays null.`);
  }
  if (usage.costSource !== undefined && (typeof usage.costSource !== 'string' || !usage.costSource.trim())) {
    problems.push('result.usage.costSource must be a non-empty string naming where the numbers came from.');
  }
  if (usage.route !== undefined && !EXECUTOR_ROUTES.includes(usage.route)) {
    problems.push(`result.usage.route must be one of: ${EXECUTOR_ROUTES.join(', ')}.`);
  }
  if (usage.billing === 'api-billed' && usage.billedUsd === null) {
    problems.push('result.usage.billedUsd stays null only when the billing basis is unknown; api-billed needs the amount.');
  }
  if (usage.billing === 'not-billed-via-api' && usage.billedUsd !== null && usage.billedUsd !== undefined) {
    problems.push('result.usage.billedUsd must stay null for a subscription route; use equivalentUsd for the list-price equivalent.');
  }
}

// Subscription usage has a list-price equivalent reported by the CLI and no
// API bill. Keep those separate; never present one as the other.
export function usageProvenance({ route = LEAD_ROUTE, reportedCostUsd = null } = {}) {
  const known = isFiniteNumber(reportedCostUsd) && reportedCostUsd >= 0;
  if (route === LEAD_ROUTE) {
    return {
      route,
      billing: 'not-billed-via-api',
      billedUsd: null,
      equivalentUsd: known ? reportedCostUsd : null,
      accountQuota: null,
      note: 'Claude subscription usage; the CLI cost field is a list-price equivalent, not an actual charge. Account quota is not observable here.',
    };
  }
  return {
    route,
    billing: route === 'api' ? 'api-billed' : 'unknown',
    billedUsd: route === 'api' && known ? reportedCostUsd : null,
    equivalentUsd: null,
    accountQuota: null,
    note: 'Non-subscription route; provider cost fields stay null unless a billing source supplies them.',
  };
}

const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'];

// Session totals from the CLI are cumulative. A resume must report its own
// increment so a replay never adds the same earlier turns twice.
export function usageDelta(previous, current) {
  if (!isPlainObject(previous?.modelUsage) || !isPlainObject(current?.modelUsage)) {
    return {
      available: false,
      counterKind: 'delta-this-invocation',
      models: {},
      cumulative: null,
      note: 'A resume delta needs both summaries to carry modelUsage.',
    };
  }
  const models = {};
  const cumulative = {};
  let available = true;
  for (const [model, entry] of Object.entries(current.modelUsage)) {
    cumulative[model] = { ...entry, counterKind: 'cumulative-session-total' };
    const prior = previous.modelUsage[model];
    if (!isPlainObject(prior)) {
      models[model] = { complete: false, note: 'No prior total for this model; the current total is not a delta.' };
      available = false;
      continue;
    }
    const fields = {};
    let complete = true;
    for (const field of USAGE_FIELDS) {
      const before = prior[field];
      const after = entry[field];
      if (before === undefined || after === undefined) {
        fields[field] = null;
        complete = false;
        continue;
      }
      const delta = after - before;
      if (delta < 0) {
        fields[field] = null;
        complete = false;
      } else {
        fields[field] = delta;
      }
    }
    models[model] = { complete, ...fields };
    if (!complete) available = false;
  }
  return {
    available,
    models,
    cumulative,
    counterKind: 'delta-this-invocation',
    note: 'Deltas are computed from cumulative CLI session totals; never add them to the cumulative total.',
  };
}

// Stable within one invocation and unique across invocations of the same run
// and agent: the digest covers the invocation id, and the sequence number is
// kept as a visible suffix so truncation can never collide.
export function safeEventId(runId, agentId, type, index, invocationId = null) {
  const seed = `${invocationId ?? ''}\u0000${runId ?? ''}\u0000${agentId ?? ''}\u0000${type}\u0000${index}`;
  const digest = createHash('sha256').update(seed).digest('hex').slice(0, 24);
  return `ev_${digest}_${index}`;
}

// A shareable projection of a private event: identifiers, status, and counters
// only. Transcript bodies, prompts, tool arguments, and secrets are dropped.
const PRIVATE_DATA_KEYS = /^(transcript|prompt|prompts|content|text|thinking|reasoning|toolInput|input|stderr|stdout|secrets?)$/i;

export function toPublicEvent(event) {
  const data = {};
  for (const [key, value] of Object.entries(event.data ?? {})) {
    if (PRIVATE_DATA_KEYS.test(key)) {
      data[key] = '[withheld]';
      continue;
    }
    if (typeof value === 'string' && value.length > 300) {
      data[key] = `${value.slice(0, 300)}[truncated]`;
      continue;
    }
    data[key] = value;
  }
  return { ...event, data };
}

export function protocolError(code, message, hint = null) {
  return new CrackError(code, message, hint);
}
