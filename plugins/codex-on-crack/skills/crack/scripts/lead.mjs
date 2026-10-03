#!/usr/bin/env node
// Optional external project lead: non-spending readiness, request validation,
// an explicit host launch/resume/cancel, and evidence recording.
//
// Nothing here executes model- or lead-authored content. `request` validates a
// lead document and prints the host action it asks a person to run; `run` and
// `resume` launch only after the host has supplied an approved request.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CrackError, readInput, run, sha256 } from './lib/io.mjs';
import {
  EXECUTOR_ROUTES, EXTERNAL_LEAD_MODEL, LEAD_MODES, SCHEMA_VERSION, hostActionEnvelope, safeEventId, toPublicEvent,
  usageDelta, validateLeadRequest, validateLeadResult, validateWorkerResult, protocolError,
} from './lib/lead-protocol.mjs';
import {
  DEFAULT_DEADLINE_SECONDS, DEFAULT_TOOL_PROFILE, LEAD_ROUTE, TOOL_PROFILES, cancelRun, canonicalPathSync,
  leadDoctor, leadRunFiles, runExternalLead, toolsForProfile, validateLeadConfig,
} from './lib/external-lead.mjs';

const USAGE = [
  'Usage:',
  '  lead.mjs doctor [--home dir]',
  '  lead.mjs config --file lead.json',
  '  lead.mjs request --file request.json [--workspace dir] [--mode external-lead|solo] [--events FILE]',
  '  lead.mjs run --request request.json --prompt prompt.txt --out runs/lead-1 [--mode external-lead|solo] [--workspace dir] [--deadline-seconds N] [--mcp-config FILE --mcp-allowed-tools LIST] [--claude-bin FILE]',
  `  lead.mjs run ... [--tool-profile ${Object.keys(TOOL_PROFILES).join('|')}]`,
  '  lead.mjs resume --run runs/lead-1 --prompt prompt.txt --out runs/lead-2 [--deadline-seconds N] [--claude-bin FILE]',
  '  lead.mjs resume ... [--tool-profile files|terminal] [--authorize-profile-transition] [--reason TEXT]',
  '  lead.mjs cancel --run runs/lead-1 [--wait-ms N]',
  '  lead.mjs record --run runs/lead-1 --type TYPE --file payload.json [--request request.json | --run-id ID --agent-id ID [--phase P] [--request-id ID]]',
].join('\n');

const RECORD_TYPES = ['host.action', 'host.validation', 'worker.result', 'lead.result'];

function readJsonInput(file, label) {
  const data = readInput(file);
  if (data === null) throw new CrackError('missing_file', `No ${label} at ${file}.`, 'Write the document first, then retry.');
  try {
    return JSON.parse(data.toString('utf8'));
  } catch {
    throw new CrackError('invalid_json', `${label} at ${file} is not valid JSON.`, 'Fix the document, then retry.');
  }
}

function parse(argv, options) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: false, strict: true }).values;
  } catch (error) {
    throw new CrackError('usage', error.message, USAGE);
  }
}

function requireMode(value) {
  const mode = value ?? 'external-lead';
  if (!LEAD_MODES.includes(mode)) throw new CrackError('usage', `--mode must be one of: ${LEAD_MODES.join(', ')}.`, USAGE);
  return mode;
}

function eventsFor(request, mode) {
  return {
    runId: request.runId,
    agentId: request.agentId,
    parentAgentId: request.parentAgentId,
    requestId: request.requestId,
    phase: request.phase,
    mode,
  };
}

function publicEventsPath(file) {
  const resolved = path.resolve(file);
  return resolved.endsWith('.jsonl')
    ? path.join(path.dirname(resolved), `${path.basename(resolved, '.jsonl')}.public.jsonl`)
    : `${resolved}.public.jsonl`;
}

async function appendEvent(file, event) {
  const resolved = path.resolve(file);
  const publicFile = publicEventsPath(resolved);
  let occurrence = 0;
  try {
    occurrence = fs.readFileSync(resolved, 'utf8').split('\n').filter((line) => line.trim()).length;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Deterministic id: the same run/agent/type/occurrence always hashes the same,
  // so a replay can drop a duplicated record instead of double-counting it.
  event.eventId = safeEventId(event.runId, event.agentId, event.type, occurrence);
  const line = `${JSON.stringify(event)}\n`;
  const publicLine = `${JSON.stringify(toPublicEvent(event))}\n`;
  await fsp.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  await fsp.appendFile(resolved, line, { mode: 0o600 });
  await fsp.appendFile(publicFile, publicLine, { mode: 0o600 });
}

function baseEvent(ids, type, status, data, extra = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: null,
    runId: ids.runId,
    phase: ids.phase ?? null,
    parentAgentId: ids.parentAgentId ?? null,
    requestId: ids.requestId ?? null,
    agentId: ids.agentId,
    mode: ids.mode ?? 'external-lead',
    type,
    at: new Date().toISOString(),
    status,
    requestedModel: extra.requestedModel ?? null,
    observedModel: extra.observedModel ?? null,
    executorRoute: extra.executorRoute ?? 'host',
    route: extra.route ?? LEAD_ROUTE,
    toolOwner: extra.toolOwner ?? 'codex-host',
    usage: extra.usage ?? null,
    data,
  };
}

function doctorCommand(argv) {
  const values = parse(argv, { home: { type: 'string' } });
  const result = leadDoctor({ home: values.home ?? null });
  return {
    ...result,
    commands: {
      validate_config: 'node scripts/lead.mjs config --file lead.json',
      validate_request: 'node scripts/lead.mjs request --file request.json --workspace "$PWD"',
      launch: 'node scripts/lead.mjs run --request request.json --prompt prompt.txt --out runs/lead-1',
      launch_with_terminal: 'node scripts/lead.mjs run --request request.json --prompt prompt.txt --out runs/lead-1 --tool-profile terminal',
      resume: 'node scripts/lead.mjs resume --run runs/lead-1 --prompt prompt.txt --out runs/lead-2',
      resume_with_authorized_terminal: 'node scripts/lead.mjs resume --run runs/lead-1 --prompt prompt.txt --out runs/lead-2 --tool-profile terminal --authorize-profile-transition --reason "host authorized terminal execution"',
      record: 'node scripts/lead.mjs record --run runs/lead-1 --type host.action --file payload.json --request request.json',
      cancel: 'node scripts/lead.mjs cancel --run runs/lead-1',
    },
  };
}

function configCommand(argv) {
  const values = parse(argv, { file: { type: 'string' } });
  if (!values.file) throw new CrackError('usage', '--file is required.', USAGE);
  const doc = readJsonInput(values.file, 'lead configuration');
  const result = validateLeadConfig(doc);
  return { ...result, file: path.resolve(values.file), fileSha256: sha256(fs.readFileSync(path.resolve(values.file))) };
}

function requestCommand(argv) {
  const values = parse(argv, {
    file: { type: 'string' }, workspace: { type: 'string' }, mode: { type: 'string' }, events: { type: 'string' },
  });
  if (!values.file) throw new CrackError('usage', '--file is required.', USAGE);
  const mode = requireMode(values.mode);
  const doc = readJsonInput(values.file, 'lead request');
  const validation = validateLeadRequest(doc, {
    workspace: values.workspace ?? null, mode, canonicalize: canonicalPathSync,
  });
  if (!validation.ok) {
    return { ok: false, status: 'rejected', mode, problems: validation.problems, executed: false, automatic_execution: false };
  }
  const envelope = hostActionEnvelope(validation.request, { mode });
  if (values.events) {
    const event = baseEvent(eventsFor(validation.request, mode), 'request.validated', 'pending', {
      kind: validation.request.kind,
      action: envelope.action,
      executor: envelope.executor,
      objectiveSha256: sha256(validation.request.objective),
      acceptanceChecks: validation.request.acceptanceChecks.length,
      budgetUsd: validation.request.budget.usd,
    });
    return appendEvent(values.events, event).then(() => ({ ...envelope, ok: true, status: 'validated', eventsFile: path.resolve(values.events) }));
  }
  return { ...envelope, ok: true, status: 'validated' };
}

function parseDeadline(value) {
  if (value === undefined) return DEFAULT_DEADLINE_SECONDS;
  if (!/^[1-9][0-9]*$/.test(value)) throw new CrackError('usage', '--deadline-seconds must be a positive integer.', USAGE);
  return Number(value);
}

function splitTools(value) {
  if (value === undefined) return [];
  return value.split(',').map((t) => t.trim()).filter(Boolean);
}

// The tool profile is explicit. A missing value falls back to the caller's
// default (the stored profile on resume, files on a new run).
function requireToolProfile(value, fallback = DEFAULT_TOOL_PROFILE) {
  const profile = value ?? fallback;
  try {
    toolsForProfile(profile);
  } catch (error) {
    throw new CrackError('usage', error.message, USAGE);
  }
  return profile;
}

// Turn a launch failure into a reportable error instead of an opaque
// "internal_error". Every message here is one of our own; no file content is
// echoed.
function launch(promise) {
  return promise.catch((error) => {
    if (error instanceof CrackError) throw error;
    throw new CrackError('launch_failed', `The lead run could not start or finish: ${error.message}`,
      'Check the workspace, prompt path, output path, budget, and the official CLI, then retry.');
  });
}

// A Ctrl-C on the CLI must stop the child process group this run owns, not
// orphan it. The first signal aborts the run; a second one exits immediately.
function withSignals(start) {
  const controller = new AbortController();
  let seen = false;
  const onSignal = () => {
    if (seen) {
      process.exitCode = 130;
      process.exit();
    }
    seen = true;
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return start(controller.signal).finally(() => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  });
}

function runCommand(argv) {
  const values = parse(argv, {
    request: { type: 'string' }, prompt: { type: 'string' }, out: { type: 'string' },
    workspace: { type: 'string' }, model: { type: 'string' }, mode: { type: 'string' },
    'deadline-seconds': { type: 'string' }, 'mcp-config': { type: 'string' }, 'mcp-allowed-tools': { type: 'string' },
    'claude-bin': { type: 'string' }, 'tool-profile': { type: 'string' },
  });
  if (!values.request || !values.prompt || !values.out) {
    throw new CrackError('usage', '--request, --prompt, and --out are required.', USAGE);
  }
  const mode = requireMode(values.mode);
  const toolProfile = requireToolProfile(values['tool-profile']);
  if (values.model !== undefined && values.model !== EXTERNAL_LEAD_MODEL) {
    throw new CrackError('unsupported_model', `--model must be exactly ${EXTERNAL_LEAD_MODEL}.`,
      'The subscription adapter has no other route; an API-billed model needs separate authorization.');
  }
  const doc = readJsonInput(values.request, 'lead request');
  const validation = validateLeadRequest(doc, {
    workspace: values.workspace ?? null, mode, canonicalize: canonicalPathSync,
  });
  if (!validation.ok) {
    return { ok: false, status: 'rejected', mode, problems: validation.problems, executed: false };
  }
  const request = validation.request;
  const mcpAllowedTools = splitTools(values['mcp-allowed-tools']);
  return withSignals((signal) => launch(runExternalLead({
    workspace: request.workspace,
    promptFile: values.prompt,
    outDir: values.out,
    model: values.model ?? EXTERNAL_LEAD_MODEL,
    mode,
    deadlineSeconds: parseDeadline(values['deadline-seconds']),
    claudeBin: values['claude-bin'] ?? 'claude',
    mcpConfig: values['mcp-config'] ?? null,
    mcpAllowedTools,
    budget: request.budget,
    toolProfile,
    run: eventsFor(request, mode),
    signal,
  }))).then((summary) => ({
    ...summary,
    requestFile: path.resolve(values.request),
    budget: request.budget,
    ...withRemediation(summary),
  }));
}

// The same remediation text for a first run and a resume, so a login failure
// reads identically wherever it surfaces.
function withRemediation(summary) {
  return summary.failureKind === 'authentication_required'
    ? { remediation: 'The official Claude Code client is not logged in. Log in with that client yourself, then start an approved run. This adapter never retries, logs in, or falls back to another route.' }
    : {};
}

function resumeCommand(argv) {
  const values = parse(argv, {
    run: { type: 'string' }, prompt: { type: 'string' }, out: { type: 'string' },
    'deadline-seconds': { type: 'string' }, 'claude-bin': { type: 'string' },
    'tool-profile': { type: 'string' }, 'authorize-profile-transition': { type: 'boolean' },
    reason: { type: 'string' },
  });
  if (!values.run || !values.prompt || !values.out) {
    throw new CrackError('usage', '--run, --prompt, and --out are required.', USAGE);
  }
  const previousFiles = leadRunFiles(values.run);
  const previous = readSummary(previousFiles.summary);
  const profile = readRunProfile(previousFiles.run);
  const sessionId = previous.sessionId;
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(sessionId)) {
    throw new CrackError('unusable_resume', 'The prior summary has no usable session id.',
      'A resume needs the session id the official client reported; start a new run instead.');
  }
  if (previous.ok !== true) {
    throw new CrackError('unusable_resume', 'The prior run did not complete successfully; resuming it would hide the failure.',
      'Fix the failure or start a new run.');
  }
  // Reuse the exact authorized profile: mode, MCP config, allowlist, required
  // MCP tools, and budget reference. A resume must not silently widen or change
  // what the user approved.
  const storedProfile = requireToolProfile(profile.toolProfile ?? legacyProfileFromTools(profile));
  const requestedProfile = requireToolProfile(values['tool-profile'], storedProfile);
  const authorizedTransition = values['authorize-profile-transition'] === true;
  let profileTransition = null;
  if (requestedProfile !== storedProfile) {
    if (!authorizedTransition) {
      throw new CrackError('profile_transition_required',
        `This run used the "${storedProfile}" tool profile; resuming as "${requestedProfile}" would widen what the user approved.`,
        `Re-run with --tool-profile ${requestedProfile} --authorize-profile-transition to record an explicit, audited change.`);
    }
    if (!(storedProfile === 'files' && requestedProfile === 'terminal')) {
      throw new CrackError('profile_transition_unsupported',
        `Only a files -> terminal widening is supported; "${storedProfile}" -> "${requestedProfile}" is not.`,
        'Start a new run for a different profile, or resume with the stored profile.');
    }
    profileTransition = {
      from: storedProfile,
      to: requestedProfile,
      authorized: true,
      authorizedBy: 'host --authorize-profile-transition',
      reason: typeof values.reason === 'string' && values.reason.trim() ? values.reason.trim() : null,
      previousRun: previousFiles.dir,
      previousRunId: previous.runId ?? profile.identity?.runId ?? null,
      previousInvocationId: profile.invocationId ?? null,
      previousSessionId: sessionId,
      previousSummarySha256: sha256(fs.readFileSync(previousFiles.summary)),
      previousProfileSha256: sha256(fs.readFileSync(previousFiles.run)),
      at: new Date().toISOString(),
    };
  }
  const mcpConfig = profile.mcpConfig ?? null;
  if (mcpConfig !== null) {
    if (typeof mcpConfig !== 'string' || !fs.existsSync(mcpConfig)) {
      throw new CrackError('unusable_resume', 'The prior run used an MCP config that is no longer readable.',
        'Restore the config, or start a new run with an explicit --mcp-config.');
    }
  }
  return withSignals((signal) => launch(runExternalLead({
    workspace: typeof previous.workspace === 'string' ? previous.workspace : profile.workspace,
    promptFile: values.prompt,
    outDir: values.out,
    model: EXTERNAL_LEAD_MODEL,
    mode: profile.mode,
    resume: sessionId,
    deadlineSeconds: parseDeadline(values['deadline-seconds']),
    claudeBin: values['claude-bin'] ?? 'claude',
    mcpConfig,
    mcpAllowedTools: profile.mcpAllowedTools,
    requiredMcpTools: profile.requiredMcpTools,
    budget: profile.budget,
    toolProfile: requestedProfile,
    profileTransition,
    resumeBaseline: { modelUsage: previous.modelUsage },
    signal,
    run: {
      runId: previous.runId ?? profile.identity?.runId ?? null,
      agentId: previous.agentId ?? profile.identity?.agentId ?? 'external-lead',
      parentAgentId: previous.parentAgentId ?? profile.identity?.parentAgentId ?? null,
      requestId: previous.requestId ?? profile.identity?.requestId ?? null,
      phase: typeof previous.phase === 'string' ? `${previous.phase}-resume` : 'resume',
      mode: profile.mode,
    },
  }))).then(async (summary) => {
    const delta = usageDelta(previous, summary);
    const outDir = path.resolve(values.out);
    if (profileTransition !== null) {
      // The previous run's metadata is never rewritten; the audit lives with
      // the new run and its replay.
      await fsp.writeFile(path.join(outDir, 'profile-transition.json'),
        `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...profileTransition }, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 });
      await appendEvent(path.join(outDir, 'events.jsonl'), baseEvent({
        runId: summary.runId, agentId: summary.agentId, parentAgentId: summary.parentAgentId,
        requestId: summary.requestId, phase: summary.phase, mode: summary.mode,
      }, 'profile.transition', 'authorized', {
        from: profileTransition.from,
        to: profileTransition.to,
        previousRun: profileTransition.previousRun,
        previousRunId: profileTransition.previousRunId,
        previousSessionId: profileTransition.previousSessionId,
        previousSummarySha256: profileTransition.previousSummarySha256,
        previousProfileSha256: profileTransition.previousProfileSha256,
        reason: profileTransition.reason,
        toolOwner: 'codex-host',
      }, { requestedModel: EXTERNAL_LEAD_MODEL, route: LEAD_ROUTE }));
    }
    const deltaFile = path.join(path.resolve(values.out), 'resume-delta.json');
    await fsp.writeFile(deltaFile, `${JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      resumedFrom: sessionId,
      counterKind: delta.counterKind,
      profile: {
        mode: profile.mode,
        toolProfile: requestedProfile,
        tools: [...toolsForProfile(requestedProfile)],
        mcpConfig,
        mcpAllowedTools: profile.mcpAllowedTools,
        requiredMcpTools: profile.requiredMcpTools,
      },
      profileTransition,
      delta,
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { ...summary, ...withRemediation(summary), resumeDelta: delta, resumeDeltaFile: deltaFile, reusedProfile: profile, profileTransition };
  });
}

// A profile written before the tool-profile field existed only had the file
// tools; treat it as "files" rather than guessing a widening.
function legacyProfileFromTools(profile) {
  const tools = Array.isArray(profile.requiredTools) ? profile.requiredTools : [];
  return tools.some((tool) => tool === 'Bash') ? 'terminal' : 'files';
}

function readSummary(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new CrackError('unusable_resume', `No readable summary at ${file}.`,
      'Resume requires a prior run in this runner; start a new run instead.');
  }
}

function readRunProfile(file) {
  let profile;
  try {
    profile = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new CrackError('unusable_resume', `No readable run profile at ${file}.`,
      'This run predates stored profiles or was not started by this runner; start a new run instead.');
  }
  if (!LEAD_MODES.includes(profile.mode) || !Array.isArray(profile.mcpAllowedTools) || !Array.isArray(profile.requiredMcpTools)) {
    throw new CrackError('unusable_resume', 'The stored run profile is incomplete.',
      'Start a new run instead of resuming it.');
  }
  return profile;
}

function cancelCommand(argv) {
  const values = parse(argv, { run: { type: 'string' }, 'wait-ms': { type: 'string' } });
  if (!values.run) throw new CrackError('usage', '--run is required.', USAGE);
  let waitMs = 10_000;
  if (values['wait-ms'] !== undefined) {
    if (!/^[1-9][0-9]*$/.test(values['wait-ms'])) throw new CrackError('usage', '--wait-ms must be a positive integer.', USAGE);
    waitMs = Number(values['wait-ms']);
  }
  return cancelRun({ runDir: values.run, waitMs }).then((result) => ({
    ...result,
    run: path.resolve(values.run),
    note: 'Cancellation is requested over the owning runner control channel (fresh heartbeat plus per-run token); no pid is ever signalled from a file.',
  }));
}

function recordCommand(argv) {
  const values = parse(argv, {
    run: { type: 'string' }, type: { type: 'string' }, file: { type: 'string' }, request: { type: 'string' },
    events: { type: 'string' }, 'run-id': { type: 'string' }, 'agent-id': { type: 'string' },
    phase: { type: 'string' }, 'request-id': { type: 'string' }, mode: { type: 'string' },
  });
  if (!values.run || !values.type || !values.file) {
    throw new CrackError('usage', '--run, --type, and --file are required.', USAGE);
  }
  if (!RECORD_TYPES.includes(values.type)) {
    throw new CrackError('usage', `--type must be one of: ${RECORD_TYPES.join(', ')}.`, USAGE);
  }
  const payload = readJsonInput(values.file, 'evidence payload');
  const request = values.request ? validateRequestFile(values.request) : null;
  const ids = completeIds({ values, payload, request });
  const eventsFile = values.events ?? path.join(path.resolve(values.run), 'events.jsonl');
  const extra = {
    requestedModel: typeof payload.requestedModel === 'string' ? payload.requestedModel : (request?.request.lead?.model ?? null),
    observedModel: typeof payload.observedModel === 'string' ? payload.observedModel : null,
    executorRoute: payload.executorRoute ?? payload.usage?.route ?? (values.type === 'lead.result' ? LEAD_ROUTE : 'router'),
    route: payload.usage?.route ?? (values.type === 'lead.result' ? LEAD_ROUTE : 'router'),
    toolOwner: typeof payload.toolOwner === 'string' ? payload.toolOwner : 'codex-host',
    usage: payload.usage ?? null,
  };
  if (!EXECUTOR_ROUTES.includes(extra.executorRoute)) {
    throw new CrackError('invalid_payload', `executorRoute must be one of: ${EXECUTOR_ROUTES.join(', ')}.`, 'Name the route the work actually ran on.');
  }

  let event;
  if (values.type === 'lead.result') {
    const validation = validateLeadResult(payload, { request: request?.request ?? null, role: 'lead' });
    if (!validation.ok) return { ok: false, status: 'rejected', problems: validation.problems, recorded: false };
    event = baseEvent(ids, 'lead.result', payload.status, {
      outcomeSha256: sha256(payload.outcome),
      evidenceCount: payload.evidence.length,
      executor: payload.executor,
      observedModel: payload.observedModel,
    }, extra);
  } else if (values.type === 'worker.result') {
    const validation = validateWorkerResult(payload, { request: request?.request ?? null });
    if (!validation.ok) return { ok: false, status: 'rejected', problems: validation.problems, recorded: false };
    event = baseEvent(ids, 'worker.result', payload.status, {
      outcomeSha256: sha256(payload.outcome),
      evidenceCount: payload.evidence.length,
      executor: payload.executor,
      observedModel: payload.observedModel,
      usageProvenance: payload.usage ?? null,
    }, extra);
  } else {
    const summary = typeof payload.summary === 'string' && payload.summary ? payload.summary : null;
    if (summary === null) throw new CrackError('invalid_payload', 'A recorded event needs a non-empty "summary" string.', 'Add a short factual summary.');
    event = baseEvent(ids, values.type, typeof payload.status === 'string' ? payload.status : 'recorded', {
      summary,
      ...(payload.evidence === undefined ? {} : { evidence: payload.evidence }),
      ...(payload.notes === undefined ? {} : { notes: payload.notes }),
    }, extra);
  }
  return appendEvent(eventsFile, event).then(() => ({
    ok: true,
    status: 'recorded',
    recorded: true,
    type: values.type,
    ids: { runId: ids.runId, agentId: ids.agentId, requestId: ids.requestId ?? null, phase: ids.phase ?? null },
    eventsFile: path.resolve(eventsFile),
    publicEventsFile: publicEventsPath(eventsFile),
    eventId: event.eventId,
  }));
}

// A recorded event must be attributable. Request-backed records inherit the
// ids; otherwise the caller supplies them explicitly.
function completeIds({ values, payload, request }) {
  const fromRequest = request?.request ?? null;
  // Prefer what the payload itself names, then the explicit flags, then the
  // request: a worker result reports the worker's own agent id.
  const runId = values['run-id'] ?? payload.runId ?? fromRequest?.runId ?? null;
  const agentId = values['agent-id'] ?? payload.agentId ?? fromRequest?.agentId
    ?? (values.type === 'lead.result' ? fromRequest?.lead?.id ?? null : null);
  const phase = values.phase ?? payload.phase ?? fromRequest?.phase ?? null;
  const requestId = values['request-id'] ?? payload.requestId ?? fromRequest?.requestId ?? null;
  const mode = fromRequest ? 'external-lead' : requireMode(values.mode);
  const missing = [];
  if (typeof runId !== 'string' || !runId) missing.push('runId');
  if (typeof agentId !== 'string' || !agentId) missing.push('agentId');
  if (missing.length) {
    throw new CrackError('missing_ids', `A recorded event needs ${missing.join(' and ')}.`,
      'Pass --request, or supply --run-id and --agent-id explicitly.');
  }
  return { runId, agentId, phase, requestId, parentAgentId: fromRequest?.parentAgentId ?? null, mode };
}

function validateRequestFile(file) {
  const doc = readJsonInput(file, 'lead request');
  const validation = validateLeadRequest(doc, { mode: 'external-lead', canonicalize: canonicalPathSync });
  if (!validation.ok) throw protocolError('invalid_request', 'The referenced request is not valid.', validation.problems.join(' '));
  return { request: validation.request, file: path.resolve(file) };
}

const COMMANDS = {
  doctor: doctorCommand,
  config: configCommand,
  request: requestCommand,
  run: runCommand,
  resume: resumeCommand,
  cancel: cancelCommand,
  record: recordCommand,
};

run(async (argv) => {
  const [command, ...rest] = argv;
  if (!command || !Object.hasOwn(COMMANDS, command)) {
    throw new CrackError('usage', `Unknown command ${command === undefined ? '(none)' : JSON.stringify(command)}.`, USAGE);
  }
  return COMMANDS[command](rest);
});
