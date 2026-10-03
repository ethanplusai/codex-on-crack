// Optional external project lead: runs the official Claude Code client on the
// existing subscription login with a fixed, reviewed tool profile.
//
// Self-contained and host-agnostic. It has no dependency on the benchmark
// harness, no absolute machine paths, no loopback proxy, no API fallback, and
// no credential files. Authentication stays inside the official client; every
// credential-shaped variable is removed from the child environment.
//
// Two things this module cannot do, and does not pretend to do:
//  - It cannot sandbox the child. `--safe-mode --setting-sources ""` is a
//    configuration boundary; file tools run in the host's process. Workspace
//    checks below are detection after execution, never prevention.
//  - It cannot signal a process it does not own. Cancellation goes through an
//    authenticated control channel owned by the live runner, which then stops
//    its own child process group. A pid file alone is never trusted.
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  EXTERNAL_LEAD_MODEL, LEAD_ROUTE, SCHEMA_VERSION, isInsideRoot, normalizePath, safeEventId, toPublicEvent,
  usageProvenance,
} from './lead-protocol.mjs';

export { EXTERNAL_LEAD_MODEL, LEAD_ROUTE };

export const LEAD_ROUTE_KIND = 'claude-code-subscription';
export const LEAD_FILE_TOOLS = Object.freeze(['Read', 'Write', 'Edit', 'Glob', 'Grep']);
// Terminal profile: the official Claude Code Bash tool alongside the file
// tools, so an authorized lead can run and debug its own checks. It is opt-in
// per run and never implied by a plain resume.
export const LEAD_TERMINAL_TOOLS = Object.freeze([...LEAD_FILE_TOOLS, 'Bash']);
export const TOOL_PROFILES = Object.freeze({ files: LEAD_FILE_TOOLS, terminal: LEAD_TERMINAL_TOOLS });
export const DEFAULT_TOOL_PROFILE = 'files';
// Tools whose arguments are commands rather than paths. Their scope follows the
// approved workspace and task; the adapter does not parse or verify them.
export const TERMINAL_TOOLS = Object.freeze(['Bash']);
// The official client reports this synthetic model when the session is not
// logged in. Treating it as a model observation would misreport a login problem
// as a model mismatch, so it is classified separately and never retried.
export const SYNTHETIC_MODEL = '<synthetic>';
const AUTH_REQUIRED_RE = /(?:not logged in|please run\s*\/login|invalid api key|authentication[_ ]?(?:required|failed)|oauth token (?:is )?(?:invalid|expired))/i;
export const DEFAULT_DEADLINE_SECONDS = 2700;
export const MIN_NODE_MAJOR = 20;
export const RUN_MARKER = 'codex-on-crack-external-lead';
export const RUN_RECORD_VERSION = 3;
export const DEFAULT_GRACE_MS = 15_000;
export const LEAD_MODES = Object.freeze(['external-lead', 'solo']);

export function toolsForProfile(profile) {
  if (typeof profile !== 'string' || !Object.hasOwn(TOOL_PROFILES, profile)) {
    throw new Error(`--tool-profile must be one of: ${Object.keys(TOOL_PROFILES).join(', ')}`);
  }
  return TOOL_PROFILES[profile];
}

export function isTerminalTool(tool) {
  return TERMINAL_TOOLS.includes(tool);
}
const FORBIDDEN_ARGS = new Set([
  '--bare', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions',
  '--permission-mode', '--add-dir', '--settings',
]);
const MCP_TOOL_RE = /^mcp__[A-Za-z0-9_-]{1,200}$/;
const RESUME_ID_RE = /^[A-Za-z0-9-]{1,128}$/;
// Patterns that would route the official client away from the subscription
// login or hand it a credential it should not have.
const SCRUBBED_ENV = [
  /^ANTHROPIC_/,
  /^CLAUDE_CODE_USE_/,
  /^CLAUDE_CODE_OAUTH_TOKEN/,
  /^CLAUDE_CODE_API_KEY/,
  /^CLAUDE_CODE_SUBAGENT_MODEL$/,
  /^CLAUDE_CODE_MAX_OUTPUT_TOKENS$/,
  /^AWS_BEARER_TOKEN_BEDROCK$/,
  /^DEEPSEEK_/,
  /^OPENAI_/,
];
const MAX_PARSED_LINE_CHARS = 32 * 1024 * 1024;
const MESSAGE_USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const SESSION_USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'];
const CONTROL_TIMEOUT_MS = 4000;
const HEARTBEAT_INTERVAL_MS = 200;
const HEARTBEAT_FRESH_MS = 2000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function globBase(pattern) {
  const parts = pattern.split('/');
  const index = parts.findIndex((part) => /[*?[\]{}]/.test(part));
  return (index === -1 ? parts : parts.slice(0, index)).join('/') || '/';
}

// Resolve the real path of the nearest existing ancestor and re-attach the
// remaining (possibly nonexistent) segments, after normalising `.`/`..`. A
// symlink anywhere above the leaf is therefore followed before any scope check.
// Returns null when the path is not absolute or escapes the filesystem root.
export function canonicalPathSync(value) {
  const lexical = normalizePath(value);
  if (lexical === null) return null;
  let current = lexical;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return normalizePath(tail.length === 0 ? real : path.join(real, ...tail.slice().reverse()));
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

// True when both paths resolve to a location inside the same approved root.
export function canonicalInside(root, candidate) {
  const resolvedRoot = canonicalPathSync(root);
  const resolved = canonicalPathSync(candidate);
  if (resolvedRoot === null || resolved === null) return false;
  return isInsideRoot(resolvedRoot, resolved);
}

export function buildLeadArgs({ model, resume = null, mcpConfig = null, mcpAllowedTools = [], toolProfile = DEFAULT_TOOL_PROFILE } = {}) {
  if (model !== EXTERNAL_LEAD_MODEL) {
    throw new Error(`--model must be exactly ${EXTERNAL_LEAD_MODEL}; the subscription adapter has no other route.`);
  }
  const tools = toolsForProfile(toolProfile);
  if (!Array.isArray(mcpAllowedTools) || mcpAllowedTools.some((t) => typeof t !== 'string' || !MCP_TOOL_RE.test(t))) {
    throw new Error('--mcp-allowed-tools entries must be MCP tool names starting with mcp__');
  }
  if (mcpAllowedTools.length && !mcpConfig) throw new Error('--mcp-allowed-tools requires --mcp-config');
  if (mcpConfig !== null && (typeof mcpConfig !== 'string' || !path.isAbsolute(mcpConfig))) {
    throw new Error('--mcp-config must be an absolute path');
  }
  // Without an explicit MCP config, --safe-mode plus an empty settings source
  // keeps the run off project/user configuration. --safe-mode would disable the
  // scoped MCP server, so it is omitted only in that reviewed case.
  const args = mcpConfig ? [] : ['--safe-mode'];
  args.push('--restricted', '--setting-sources', '', '--strict-mcp-config');
  if (mcpConfig) args.push('--mcp-config', mcpConfig);
  args.push(
    '-p',
    '--model', model,
    '--tools', tools.join(','),
    '--allowedTools', [...tools, ...mcpAllowedTools].join(','),
    '--output-format', 'stream-json',
    '--verbose',
  );
  if (resume !== null) {
    if (typeof resume !== 'string' || !RESUME_ID_RE.test(resume)) throw new Error('--resume must be a session id');
    args.push('--resume', resume);
  }
  for (const arg of args) {
    if (FORBIDDEN_ARGS.has(arg)) throw new Error(`refusing forbidden CLI argument ${arg}`);
  }
  return args;
}

// Keep only variables the official client needs for the subscription login.
// Credential-shaped overrides are deleted, never copied, and the small/fast
// model is pinned to the requested model so the observed-model check is exact.
export function buildLeadEnv({ baseEnv = process.env, model = EXTERNAL_LEAD_MODEL } = {}) {
  if (model !== EXTERNAL_LEAD_MODEL) throw new Error(`unsupported model ${JSON.stringify(model)}`);
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (SCRUBBED_ENV.some((re) => re.test(key))) continue;
    env[key] = value;
  }
  env.ANTHROPIC_SMALL_FAST_MODEL = model;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
  if (env.ANTHROPIC_BASE_URL || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY) {
    throw new Error('refusing to launch: the child environment still carries a provider override');
  }
  return env;
}

export class LeadStreamSummarizer {
  constructor({
    runId, agentId, parentAgentId = null, requestId = null, phase = null, mode = 'external-lead',
    invocationId, requestedModel, workspace, workspaceAliases = [], toolProfile = DEFAULT_TOOL_PROFILE,
    configuredTools = null, requiredTools = null,
    mcpEnabled = false, configuredMcpTools = [], requiredMcpTools = null, clock = () => new Date(),
    onEvent = null,
  }) {
    this.requestedModel = requestedModel;
    this.toolProfile = toolProfile;
    this.configuredTools = [...(configuredTools ?? toolsForProfile(toolProfile))];
    this.requiredTools = [...(requiredTools ?? this.configuredTools)];
    this.mcpEnabled = mcpEnabled;
    this.configuredMcpTools = [...configuredMcpTools];
    this.requiredMcpTools = requiredMcpTools === null
      ? (mcpEnabled ? [...configuredMcpTools] : [])
      : [...requiredMcpTools];
    this.workspace = path.resolve(workspace);
    this.roots = [...new Set([workspace, ...workspaceAliases].filter(Boolean).map((p) => canonicalPathSync(p) ?? path.resolve(p)))];
    this.identity = { runId, agentId, parentAgentId, requestId, phase, mode, toolProfile, invocationId };
    this.onEvent = onEvent;
    this.clock = clock;
    this.seq = 0;
    this.lines = 0;
    this.malformedLines = 0;
    this.oversizedLines = 0;
    this.duplicateRecords = 0;
    this.duplicateAssistantRecords = 0;
    this.uuids = new Set();
    this.init = null;
    this.assistantModels = new Set();
    this.messages = new Map();
    this.toolUseIds = new Set();
    this.toolCalls = new Map();
    this.toolUses = {};
    this.toolErrors = 0;
    this.toolFinished = 0;
    this.terminalToolUses = 0;
    this.terminalCommands = 0;
    this.outsideWorkspace = [];
    this.result = null;
    this.extraResults = 0;
    this.streamErrors = [];
    this.timeline = [];
    this.syntheticRecords = 0;
    this.authenticationRequired = false;
  }

  emit(type, { at = null, atSource = 'stream', status = null, model = null, toolOwner = 'external-claude', usage = null, data = {} } = {}) {
    const event = {
      schemaVersion: SCHEMA_VERSION,
      eventId: safeEventId(this.identity.runId, this.identity.agentId, type, this.seq, this.identity.invocationId),
      runId: this.identity.runId,
      phase: this.identity.phase,
      parentAgentId: this.identity.parentAgentId,
      requestId: this.identity.requestId,
      agentId: this.identity.agentId,
      invocationId: this.identity.invocationId,
      mode: this.identity.mode,
      toolProfile: this.identity.toolProfile,
      type,
      at: at ?? this.clock().toISOString(),
      atSource,
      status,
      requestedModel: this.requestedModel,
      observedModel: model,
      route: LEAD_ROUTE,
      toolOwner,
      usage,
      data,
    };
    this.seq++;
    this.timeline.push(event);
    if (this.onEvent) this.onEvent(event);
    return event;
  }

  pushLine(line) {
    this.lines++;
    const receivedAt = this.clock().toISOString();
    if (!line.trim()) return;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      this.malformedLines++;
      return;
    }
    if (!isPlainObject(rec) || typeof rec.type !== 'string') {
      this.malformedLines++;
      return;
    }
    if (typeof rec.uuid === 'string') {
      if (this.uuids.has(rec.uuid)) {
        this.duplicateRecords++;
        return;
      }
      this.uuids.add(rec.uuid);
    }
    const source = typeof rec.timestamp === 'string' && Number.isFinite(Date.parse(rec.timestamp))
      ? { at: new Date(rec.timestamp).toISOString(), atSource: 'stream' }
      : { at: receivedAt, atSource: 'receive-time' };
    if (rec.type === 'system') this.#system(rec, source);
    else if (rec.type === 'assistant') this.#assistant(rec, source);
    else if (rec.type === 'user') this.#user(rec, source);
    else if (rec.type === 'result') this.#result(rec);
  }

  // Only an actual error envelope counts here. Prose that merely mentions a
  // login is work, not a client failure.
  #result(rec) {
    if (this.result) this.extraResults++;
    else this.result = rec;
    const failed = rec.is_error === true || (typeof rec.subtype === 'string' && /error/i.test(rec.subtype));
    if (!failed) return;
    if (typeof rec.result === 'string' && AUTH_REQUIRED_RE.test(rec.result)) this.authenticationRequired = true;
    if (typeof rec.error === 'string' && AUTH_REQUIRED_RE.test(rec.error)) this.authenticationRequired = true;
  }

  markOversizedLine() {
    this.oversizedLines++;
  }

  #system(rec, source) {
    if (rec.subtype !== 'init') {
      if (typeof rec.subtype === 'string' && /error/i.test(rec.subtype)) this.streamErrors.push(`system ${rec.subtype}`);
      return;
    }
    if (this.init) {
      this.streamErrors.push('multiple init records');
      return;
    }
    this.init = {
      sessionId: typeof rec.session_id === 'string' ? rec.session_id : null,
      model: typeof rec.model === 'string' ? rec.model : null,
      apiKeySource: typeof rec.apiKeySource === 'string' ? rec.apiKeySource : null,
      permissionMode: typeof rec.permissionMode === 'string' ? rec.permissionMode : null,
      cliVersion: typeof rec.claude_code_version === 'string' ? rec.claude_code_version : null,
      cwd: typeof rec.cwd === 'string' ? rec.cwd : null,
      tools: Array.isArray(rec.tools) ? rec.tools.filter((t) => typeof t === 'string') : null,
    };
    this.emit('agent.created', { ...source, status: 'created', model: this.init.model, data: {
      sessionId: this.init.sessionId,
    } });
    this.emit('agent.started', { ...source, status: 'started', model: this.init.model, data: {
      sessionId: this.init.sessionId,
      tools: this.init.tools,
      permissionMode: this.init.permissionMode,
      cliVersion: this.init.cliVersion,
      toolOwner: 'external-claude',
    } });
    if (this.init.model) {
      this.emit('model.observed', { ...source, status: 'observed', model: this.init.model, data: { via: 'system.init' } });
    }
  }

  #assistant(rec, source) {
    const message = rec.message;
    if (!isPlainObject(message) || typeof message.id !== 'string') {
      this.malformedLines++;
      return;
    }
    const synthetic = message.model === SYNTHETIC_MODEL;
    if (synthetic) this.syntheticRecords++;
    // A synthetic record is the client talking, not a served model: it is
    // counted separately and never compared against the requested model.
    if (!synthetic && typeof message.model === 'string' && !this.assistantModels.has(message.model)) {
      this.assistantModels.add(message.model);
      this.emit('model.observed', { ...source, status: 'observed', model: message.model, data: { via: 'assistant.message' } });
    }
    // A login notice is only evidence when the client itself produced it (the
    // synthetic model). Ordinary prose can discuss logins without failing a run.
    if (synthetic && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isPlainObject(block) && typeof block.text === 'string' && AUTH_REQUIRED_RE.test(block.text)) {
          this.authenticationRequired = true;
        }
      }
    }
    const known = this.messages.get(message.id);
    if (known) this.duplicateAssistantRecords++;
    const usage = known ?? {};
    for (const field of MESSAGE_USAGE_FIELDS) {
      const value = message.usage?.[field];
      if (isCount(value)) usage[field] = Math.max(usage[field] ?? 0, value);
    }
    this.messages.set(message.id, usage);
    if (!Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (!isPlainObject(block) || block.type !== 'tool_use' || typeof block.id !== 'string') continue;
      if (this.toolUseIds.has(block.id)) continue;
      this.toolUseIds.add(block.id);
      const name = typeof block.name === 'string' ? block.name : 'unknown';
      this.toolUses[name] = (this.toolUses[name] ?? 0) + 1;
      this.toolCalls.set(block.id, name);
      if (isTerminalTool(name)) {
        this.terminalToolUses++;
        if (typeof block.input?.command === 'string' && block.input.command) this.terminalCommands++;
      }
      this.emit('tool.started', { ...source, status: 'started', model: message.model ?? null, data: { toolName: name, toolUseId: block.id, toolOwner: 'external-claude' } });
      this.#checkPaths(name, block.input);
    }
  }

  // Successful and failed tool results both need a terminal event; a replay
  // that only records failures shows work that never ended.
  #user(rec, source) {
    const content = rec.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isPlainObject(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      if (this.toolFinished > 0 && this.toolCalls.get(block.tool_use_id) === undefined) continue;
      const isError = block.is_error === true;
      if (isError) this.toolErrors++;
      this.toolFinished++;
      this.emit('tool.finished', {
        ...source,
        status: isError ? 'error' : 'completed',
        data: { toolName: this.toolCalls.get(block.tool_use_id) ?? 'unknown', toolUseId: block.tool_use_id, isError, toolOwner: 'external-claude' },
      });
    }
  }

  #inside(candidate) {
    const canonical = canonicalPathSync(candidate);
    if (canonical === null) return false;
    return this.roots.some((root) => isInsideRoot(root, canonical));
  }

  // Observations are reported after the tool call appears in the stream. They
  // are detection, not prevention: the file tools run in the host's process.
  #checkPaths(tool, input) {
    // A terminal tool carries a command, not a path. Its scope follows the
    // approved workspace and task; command text is never parsed as a path, so a
    // relative command such as `cd .. && ls` is not misreported as an escape.
    if (isTerminalTool(tool)) return;
    if (!isPlainObject(input)) return;
    for (const key of ['file_path', 'path', 'notebook_path']) {
      const value = input[key];
      if (typeof value !== 'string' || !value) continue;
      // A relative path resolves against the session cwd, which is the workspace.
      const resolvedValue = path.isAbsolute(value) ? value : path.join(this.workspace, value);
      if (!this.#inside(resolvedValue)) this.outsideWorkspace.push({ tool, key, path: normalizePath(resolvedValue) ?? resolvedValue });
    }
    if (tool === 'Glob' && typeof input.pattern === 'string') {
      const pattern = input.pattern;
      const escapes = path.isAbsolute(pattern) ? !this.#inside(globBase(pattern)) : pattern.split(/[\\/]/).includes('..');
      if (escapes) this.outsideWorkspace.push({ tool, key: 'pattern', path: pattern });
    }
  }

  finish({ exitCode = null, signal = null, timedOut = false, stopReason = null, spawnError = null, extraErrors = [], resumedFrom = null, resumeBaseline = null } = {}) {
    const errors = [...extraErrors, ...this.streamErrors];
    const warnings = [];
    const requested = this.requestedModel;
    const result = this.result;

    if (spawnError) errors.push(`failed to start the lead client: ${spawnError}`);
    if (timedOut) errors.push('deadline exceeded; the lead process group was stopped');
    if (stopReason && !timedOut) errors.push(`stopped: ${stopReason}`);
    if (exitCode !== 0) errors.push(`lead client exited with code ${exitCode}${signal ? ` (signal ${signal})` : ''}`);
    if (!this.init) errors.push('no system init record');
    if (!result) errors.push('no result record: the lead result is incomplete');
    if (this.extraResults) errors.push(`${this.extraResults} extra result record(s)`);
    if (result && (result.subtype !== 'success' || result.is_error === true)) {
      errors.push(`result reported ${result.subtype ?? 'unknown'}${result.is_error === true ? ' with is_error' : ''}`);
    }

    let modelUsage = null;
    if (result) {
      if (!isPlainObject(result.modelUsage) || Object.keys(result.modelUsage).length === 0) {
        errors.push('result has no modelUsage: usage provenance is unknown');
      } else {
        modelUsage = {};
        for (const [model, entry] of Object.entries(result.modelUsage)) {
          const clean = {};
          for (const field of SESSION_USAGE_FIELDS) {
            const value = entry?.[field];
            if (value === undefined) continue;
            if (!isCount(value)) errors.push(`modelUsage.${model}.${field} is not a non-negative integer`);
            else clean[field] = value;
          }
          if (!isCount(entry?.inputTokens) || !isCount(entry?.outputTokens)) errors.push(`modelUsage.${model} lacks input/output token counts`);
          if (typeof entry?.costUSD === 'number' && Number.isFinite(entry.costUSD)) clean.costUSD = entry.costUSD;
          modelUsage[model] = clean;
        }
      }
    }

    const observed = {
      init: this.init?.model ?? null,
      assistant: [...this.assistantModels],
      modelUsage: modelUsage ? Object.keys(modelUsage) : [],
    };
    const allObserved = new Set([observed.init, ...observed.assistant, ...observed.modelUsage].filter(Boolean));
    if (observed.init === SYNTHETIC_MODEL) this.syntheticRecords++;
    // The synthetic client record is not a served model, so it never counts as
    // the requested model nor as a substitute for one.
    const servedModels = new Set([...allObserved].filter((m) => m !== SYNTHETIC_MODEL));
    const unexpectedModels = [...servedModels].filter((m) => m !== requested);
    if (servedModels.size === 0 && !this.authenticationRequired) errors.push('no model was observed');
    // A login problem is its own failure kind, reported only when no model was
    // actually served: a real mismatch must take precedence over a login notice.
    if (this.authenticationRequired && unexpectedModels.length === 0) {
      errors.push('authentication_required: the official client is not logged in (it returned a synthetic "Not logged in" record). No retry, login, or fallback was attempted.');
    }
    if (unexpectedModels.length) errors.push(`observed model(s) other than ${requested}: ${unexpectedModels.join(', ')}`);

    const toolsExposed = this.init?.tools ?? null;
    const unexpectedTools = toolsExposed === null ? [] : toolsExposed.filter((t) => !this.isAllowedTool(t));
    if (unexpectedTools.length) errors.push(`unexpected tools exposed: ${unexpectedTools.join(', ')}`);
    const requiredToolsExposed = toolsExposed ?? [];
    const missingTools = toolsExposed === null ? [] : this.requiredTools.filter((t) => !requiredToolsExposed.includes(t));
    if (missingTools.length) errors.push(`required tool(s) were not exposed: ${missingTools.join(', ')}`);

    // MCP is only trusted when it matches the explicit configured allowlist.
    const calledMcp = Object.keys(this.toolUses).filter((t) => t.startsWith('mcp__'));
    const unconfiguredCalled = calledMcp.filter((t) => !this.configuredMcpTools.includes(t));
    if (unconfiguredCalled.length) errors.push(`MCP tool(s) called outside the configured allowlist: ${unconfiguredCalled.join(', ')}`);
    const exposedMcp = toolsExposed === null ? null : toolsExposed.filter((t) => t.startsWith('mcp__'));
    const unconfiguredExposed = exposedMcp === null ? [] : exposedMcp.filter((t) => !this.configuredMcpTools.includes(t));
    if (unconfiguredExposed.length) errors.push(`MCP tool(s) exposed outside the configured allowlist: ${unconfiguredExposed.join(', ')}`);
    const missingMcp = this.requiredMcpTools.filter((t) => (exposedMcp === null ? !calledMcp.includes(t) : !exposedMcp.includes(t)));
    if (missingMcp.length) errors.push(`required MCP tool(s) were not exposed: ${missingMcp.join(', ')}`);

    const permissionDenials = Array.isArray(result?.permission_denials)
      ? result.permission_denials.map((d) => ({
        toolName: typeof d?.tool_name === 'string' ? d.tool_name : null,
        toolUseId: typeof d?.tool_use_id === 'string' ? d.tool_use_id : null,
      }))
      : [];
    for (const denial of permissionDenials) {
      this.emit('permission.denied', { status: 'denied', atSource: 'receive-time', data: {
        toolName: denial.toolName, toolUseId: denial.toolUseId, toolOwner: 'external-claude',
      } });
    }
    const requiredDenied = [...this.requiredTools, ...this.requiredMcpTools];
    const deniedRequired = permissionDenials
      .map((d) => d.toolName)
      .filter((name) => name !== null && requiredDenied.includes(name));
    if (deniedRequired.length) errors.push(`required tool permission(s) denied: ${[...new Set(deniedRequired)].join(', ')}`);

    if (this.init) {
      if (this.init.permissionMode === 'bypassPermissions') errors.push('the lead session ran with bypassPermissions');
      if (this.init.cwd && !this.roots.some((root) => path.resolve(this.init.cwd) === root)) {
        errors.push('the lead session cwd differs from the requested workspace');
      }
      if (this.init.apiKeySource !== 'none') {
        errors.push(`expected the subscription login (apiKeySource "none"), saw ${JSON.stringify(this.init.apiKeySource)}`);
      }
    }
    if (this.outsideWorkspace.length) {
      errors.push(`${this.outsideWorkspace.length} file tool call(s) targeted paths outside the workspace`);
    }
    if (this.malformedLines) warnings.push(`${this.malformedLines} malformed stdout line(s)`);
    if (this.oversizedLines) warnings.push(`${this.oversizedLines} stdout line(s) too large to parse`);
    if (this.duplicateRecords) warnings.push(`${this.duplicateRecords} duplicate record uuid(s) ignored`);
    if (this.duplicateAssistantRecords) warnings.push(`${this.duplicateAssistantRecords} duplicate assistant record(s) deduplicated`);
    if (this.terminalToolUses > 0) {
      warnings.push(`${this.terminalToolUses} terminal tool call(s) are not statically path-checked; scope follows the approved workspace and task`);
    }

    const provisional = { messages: this.messages.size };
    for (const field of MESSAGE_USAGE_FIELDS) {
      provisional[field] = [...this.messages.values()].reduce((sum, u) => sum + (u[field] ?? 0), 0);
    }
    const reportedCost = typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null;
    const usage = usageProvenance({ route: LEAD_ROUTE, reportedCostUsd: reportedCost });

    this.emit('usage.recorded', { status: 'provisional', atSource: 'receive-time', usage: { ...provisional }, data: {
      usageScope: 'message',
      counterKind: 'per-message-snapshot',
      completeness: 'provisional',
      cumulative: false,
      countsAreCumulative: false,
      note: 'Per-message snapshots; never add these to the session total.',
    } });
    const deltaUsage = resumeBaseline === null ? null : usageDeltaFor(resumeBaseline, modelUsage);
    if (modelUsage) {
      this.emit('usage.recorded', { status: 'final', atSource: 'receive-time', usage: { ...modelUsage }, data: {
        usageScope: 'session',
        counterKind: resumeBaseline === null ? 'authoritative-total' : 'authoritative-total-with-delta',
        completeness: 'final',
        cumulative: true,
        countsAreCumulative: true,
        resumed: resumedFrom !== null,
        includesPriorTurns: resumedFrom !== null,
        delta: deltaUsage,
        deltaScope: deltaUsage === null ? null : 'this-invocation',
        billing: usage.billing,
        billedUsd: usage.billedUsd,
        equivalentUsd: usage.equivalentUsd,
        accountQuota: usage.accountQuota,
        note: 'Session totals are cumulative. Use data.delta for this invocation; never add cumulative totals across runs.',
      } });
    }
    const ok = errors.length === 0;
    const failureKind = ok ? null
      : unexpectedModels.length ? 'model_mismatch'
        : this.authenticationRequired ? 'authentication_required'
          : !result ? 'incomplete_result'
            : exitCode !== 0 ? 'process_failed'
              : timedOut ? 'deadline'
                : 'run_failed';
    this.emit(ok ? 'agent.returned' : 'agent.failed', {
      status: ok ? 'completed' : 'failed',
      atSource: 'receive-time',
      data: {
        reason: ok ? null : 'lead-run-not-ok',
        failureKind,
        subtype: result?.subtype ?? null,
        numTurns: isCount(result?.num_turns) ? result.num_turns : null,
        durationMs: isCount(result?.duration_ms) ? result.duration_ms : null,
        toolFacts: { started: Object.values(this.toolUses).reduce((a, b) => a + b, 0), finished: this.toolFinished, errors: this.toolErrors },
      },
    });
    this.terminalEvents = null;

    return {
      schemaVersion: SCHEMA_VERSION,
      ok,
      route: LEAD_ROUTE,
      routeKind: LEAD_ROUTE_KIND,
      requestedModel: requested,
      observedModels: observed,
      unexpectedModels,
      failureKind,
      authenticationRequired: this.authenticationRequired,
      syntheticRecords: this.syntheticRecords,
      fallbackUsed: false,
      noFallback: 'Single configured subscription route; the adapter never substitutes a model or provider.',
      sessionId: this.init?.sessionId ?? (typeof result?.session_id === 'string' ? result.session_id : null),
      apiKeySource: this.init?.apiKeySource ?? null,
      permissionMode: this.init?.permissionMode ?? null,
      cliVersion: this.init?.cliVersion ?? null,
      toolsExposed,
      toolProfile: this.toolProfile,
      tools: [...this.configuredTools],
      requiredTools: [...this.requiredTools],
      requiredMcpTools: [...this.requiredMcpTools],
      configuredMcpTools: [...this.configuredMcpTools],
      unexpectedTools,
      missingTools,
      missingMcp,
      resumedFrom,
      result: result ? {
        subtype: result.subtype ?? null,
        isError: result.is_error === true,
        numTurns: isCount(result.num_turns) ? result.num_turns : null,
        durationMs: isCount(result.duration_ms) ? result.duration_ms : null,
        durationApiMs: isCount(result.duration_api_ms) ? result.duration_api_ms : null,
        stopReason: typeof result.stop_reason === 'string' ? result.stop_reason : null,
      } : null,
      modelUsage,
      modelUsageSource: 'result.modelUsage (cumulative CLI session totals; use resume-delta.json for this invocation)',
      usage,
      provisionalMessageUsage: {
        ...provisional,
        note: 'Deduplicated per-message snapshots; informational only, never add to modelUsage.',
      },
      permissionDenials,
      toolUses: this.toolUses,
      toolErrors: this.toolErrors,
      toolFinished: this.toolFinished,
      terminalToolUses: this.terminalToolUses,
      terminalCommands: this.terminalCommands,
      outsideWorkspaceToolUses: this.outsideWorkspace,
      stream: {
        lines: this.lines,
        malformedLines: this.malformedLines,
        oversizedLines: this.oversizedLines,
        duplicateRecords: this.duplicateRecords,
        duplicateAssistantRecords: this.duplicateAssistantRecords,
        assistantMessages: this.messages.size,
      },
      events: this.timeline.length,
      errors,
      warnings,
    };
  }

  isAllowedTool(tool) {
    return this.configuredTools.includes(tool) || this.configuredMcpTools.includes(tool);
  }
}

// Delta for one resumed invocation, from cumulative CLI totals.
function usageDeltaFor(baseline, current) {
  if (!isPlainObject(baseline?.modelUsage) || !isPlainObject(current)) return null;
  const models = {};
  for (const [model, entry] of Object.entries(current)) {
    const prior = baseline.modelUsage[model];
    if (!isPlainObject(prior)) {
      models[model] = { complete: false, note: 'No prior total for this model.' };
      continue;
    }
    const fields = { complete: true };
    for (const field of SESSION_USAGE_FIELDS) {
      const before = prior[field];
      const after = entry[field];
      if (before === undefined || after === undefined || after - before < 0) {
        fields[field] = null;
        fields.complete = false;
      } else {
        fields[field] = after - before;
      }
    }
    models[model] = fields;
  }
  return { counterKind: 'delta-this-invocation', models };
}

class LineSplitter {
  #decoder = new TextDecoder();
  #buf = '';
  #skipping = false;

  constructor(onLine, onOversized, maxChars = MAX_PARSED_LINE_CHARS) {
    this.onLine = onLine;
    this.onOversized = onOversized;
    this.maxChars = maxChars;
  }

  push(chunk) {
    this.#buf += this.#decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = this.#buf.indexOf('\n')) !== -1) {
      const line = this.#buf.slice(0, idx);
      this.#buf = this.#buf.slice(idx + 1);
      if (this.#skipping) this.#skipping = false;
      else this.onLine(line);
    }
    if (this.#buf.length > this.maxChars) {
      if (!this.#skipping) this.onOversized();
      this.#skipping = true;
      this.#buf = '';
    }
  }

  end() {
    this.#buf += this.#decoder.decode();
    if (this.#buf && !this.#skipping) this.onLine(this.#buf);
    this.#buf = '';
  }
}

function createGroupStopper(child, graceMs) {
  const timers = [];
  let started = false;
  const send = (sig) => {
    try {
      process.kill(-child.pid, sig);
    } catch (err) {
      if (err.code !== 'ESRCH') {
        try {
          child.kill(sig);
        } catch {
          // already gone
        }
      }
    }
  };
  return {
    stop() {
      if (started || !child.pid) return;
      started = true;
      send('SIGINT');
      timers.push(setTimeout(() => send('SIGTERM'), graceMs));
      timers.push(setTimeout(() => send('SIGKILL'), graceMs * 2));
    },
    clear() {
      for (const timer of timers) clearTimeout(timer);
    },
    reapGroup() {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // group already empty
      }
    },
    started() {
      return started;
    },
  };
}

function endStream(stream) {
  return new Promise((resolve) => {
    if (stream.writableFinished || stream.destroyed) {
      resolve();
      return;
    }
    stream.once('error', () => resolve());
    stream.end(resolve);
  });
}

async function assertAbsent(file) {
  try {
    await fsp.lstat(file);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  throw new Error(`refusing to overwrite existing file ${file}`);
}

export function leadRunFiles(outDir) {
  const out = path.resolve(outDir);
  return {
    dir: out,
    stdout: path.join(out, 'stdout.jsonl'),
    received: path.join(out, 'received.jsonl'),
    stderr: path.join(out, 'stderr.log'),
    pid: path.join(out, 'pid.json'),
    run: path.join(out, 'run.json'),
    summary: path.join(out, 'summary.json'),
    events: path.join(out, 'events.jsonl'),
    publicEvents: path.join(out, 'events.public.jsonl'),
  };
}

// A loopback control endpoint: the only way to stop a live run. It binds to
// An authenticated control channel: the only way to stop a live run. The runner
// publishes a heartbeat and polls a request file; a cancellation must carry the
// per-run token from the 0600 pid file and match the live invocation id. No pid
// is ever signalled from a file: if no runner is polling, cancellation fails
// closed and an unrelated process cannot be touched.
export const CONTROL_FILES = Object.freeze({
  heartbeat: 'control.heartbeat',
  request: 'control.request.json',
  reply: 'control.reply.json',
});

function startControlChannel({ files, token, invocationId, onCancel, clock }) {
  const heartbeatFile = path.join(files.dir, CONTROL_FILES.heartbeat);
  const requestFile = path.join(files.dir, CONTROL_FILES.request);
  const replyFile = path.join(files.dir, CONTROL_FILES.reply);
  let stopped = false;
  const beat = () => {
    try {
      fs.writeFileSync(heartbeatFile, JSON.stringify({ invocationId, at: clock().toISOString() }), { mode: 0o600 });
    } catch {
      // the heartbeat is best effort; a missing beat fails cancellation closed
    }
    let request = null;
    try {
      request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
    } catch {
      return;
    }
    if (request?.invocationId !== invocationId || !timingSafeEqualStrings(request.token, token)) return;
    if (request.action !== 'cancel') return;
    if (!stopped) {
      stopped = true;
      onCancel();
    }
    try {
      fs.writeFileSync(replyFile, JSON.stringify({ ok: true, status: 'stopping', invocationId, at: clock().toISOString() }), { mode: 0o600 });
      fs.rmSync(requestFile, { force: true });
    } catch {
      // the reply is a courtesy; the caller also watches the run summary
    }
  };
  beat();
  const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    files: { heartbeat: heartbeatFile, request: requestFile, reply: replyFile },
    stop() {
      clearInterval(timer);
      for (const file of [heartbeatFile, requestFile]) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          // best effort
        }
      }
    },
  };
}

function timingSafeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export async function runExternalLead(options = {}) {
  const {
    workspace,
    promptFile,
    outDir,
    model = EXTERNAL_LEAD_MODEL,
    resume = null,
    deadlineSeconds = DEFAULT_DEADLINE_SECONDS,
    claudeBin = 'claude',
    claudeBinPrefixArgs = [],
    baseEnv = process.env,
    graceMs = DEFAULT_GRACE_MS,
    deadlineMs = null,
    signal = null,
    mcpConfig = null,
    mcpAllowedTools = [],
    requiredMcpTools = null,
    toolProfile = DEFAULT_TOOL_PROFILE,
    requiredTools = null,
    run = null,
    mode = 'external-lead',
    budget = null,
    profileTransition = null,
    resumeBaseline = null,
    onStarted = null,
    clock = () => new Date(),
  } = options;

  if (model !== EXTERNAL_LEAD_MODEL) throw new Error(`--model must be exactly ${EXTERNAL_LEAD_MODEL}`);
  if (!LEAD_MODES.includes(mode)) throw new Error(`--mode must be one of: ${LEAD_MODES.join(', ')}`);
  const tools = toolsForProfile(toolProfile);
  const effectiveRequiredTools = requiredTools ?? tools;
  if (!Number.isSafeInteger(deadlineSeconds) || deadlineSeconds < 1 || deadlineSeconds > 86_400) {
    throw new Error('--deadline-seconds must be an integer from 1 to 86400');
  }
  if (typeof workspace !== 'string' || !workspace) throw new Error('--workspace is required');
  if (typeof promptFile !== 'string' || !promptFile) throw new Error('--prompt is required');
  if (typeof outDir !== 'string' || !outDir) throw new Error('--out is required');

  const requestedWorkspace = path.resolve(workspace);
  let realWorkspace;
  try {
    realWorkspace = await fsp.realpath(requestedWorkspace);
    if (!(await fsp.stat(realWorkspace)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error('--workspace must be an existing directory');
  }
  const promptPath = path.resolve(promptFile);
  let promptStat = null;
  try {
    promptStat = await fsp.stat(promptPath);
  } catch {
    promptStat = null;
  }
  if (promptStat?.isFile() !== true) throw new Error('--prompt must be a regular file');

  const files = leadRunFiles(outDir);
  await fsp.mkdir(files.dir, { recursive: true, mode: 0o700 });
  for (const file of [files.stdout, files.received, files.stderr, files.pid, files.run, files.summary, files.events, files.publicEvents]) {
    await assertAbsent(file);
  }
  let mcpConfigPath = null;
  if (mcpConfig !== null) {
    mcpConfigPath = path.resolve(mcpConfig);
    let mcpStat = null;
    try {
      mcpStat = await fsp.stat(mcpConfigPath);
    } catch {
      mcpStat = null;
    }
    if (mcpStat?.isFile() !== true) throw new Error('--mcp-config must be a regular file');
    try {
      JSON.parse(await fsp.readFile(mcpConfigPath, 'utf8'));
    } catch {
      throw new Error('--mcp-config is not valid JSON');
    }
  }

  const invocationId = crypto.randomBytes(12).toString('hex');
  const controlToken = crypto.randomBytes(24).toString('hex');
  const env = buildLeadEnv({ baseEnv, model });
  const args = buildLeadArgs({ model, resume, mcpConfig: mcpConfigPath, mcpAllowedTools, toolProfile });

  const stdoutFile = fs.createWriteStream(files.stdout, { flags: 'wx', mode: 0o600 });
  const stderrFile = fs.createWriteStream(files.stderr, { flags: 'wx', mode: 0o600 });
  const receivedFile = fs.createWriteStream(files.received, { flags: 'wx', mode: 0o600 });
  // Events are appended as they happen, so a cancelled or crashed run still
  // leaves the trail it produced.
  const eventsFile = fs.createWriteStream(files.events, { flags: 'wx', mode: 0o600 });
  const publicEventsFile = fs.createWriteStream(files.publicEvents, { flags: 'wx', mode: 0o600 });
  const startedAt = clock();
  const extraErrors = [];
  const identity = {
    runId: run?.runId ?? null,
    agentId: run?.agentId ?? null,
    parentAgentId: run?.parentAgentId ?? null,
    requestId: run?.requestId ?? null,
    phase: run?.phase ?? null,
    mode,
    toolProfile,
    invocationId,
  };
  const writeEvent = (event) => {
    eventsFile.write(`${JSON.stringify(event)}\n`);
    publicEventsFile.write(`${JSON.stringify(toPublicEvent(event))}\n`);
  };
  const summarizer = new LeadStreamSummarizer({
    ...identity,
    requestedModel: model,
    workspace: realWorkspace,
    workspaceAliases: [requestedWorkspace],
    toolProfile,
    configuredTools: tools,
    requiredTools: effectiveRequiredTools,
    mcpEnabled: mcpConfigPath !== null,
    configuredMcpTools: mcpAllowedTools,
    requiredMcpTools,
    clock,
    onEvent: run === null ? null : writeEvent,
  });
  if (run === null) {
    // Still record the read model identity when the caller did not supply ids.
    summarizer.identity.runId = 'unscoped';
    summarizer.identity.agentId = 'external-lead';
  }

  const child = spawn(claudeBin, [...claudeBinPrefixArgs, ...args], {
    cwd: realWorkspace,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  let spawnError = null;
  child.on('error', (err) => {
    spawnError = spawnError ?? (err.code ?? err.message);
  });
  const exited = new Promise((resolve) => {
    child.once('error', () => resolve({ code: null, signal: null }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  const stopper = createGroupStopper(child, graceMs);
  const control = startControlChannel({
    files,
    token: controlToken,
    invocationId,
    clock,
    onCancel: () => stopper.stop(),
  });

  if (child.pid) {
    await fsp.writeFile(files.pid, `${JSON.stringify({
      runner: RUN_MARKER,
      runnerVersion: RUN_RECORD_VERSION,
      invocationId,
      pid: child.pid,
      processGroup: child.pid,
      control: CONTROL_FILES,
      controlToken,
      startedAt: startedAt.toISOString(),
      requestedModel: model,
      route: LEAD_ROUTE,
      mode,
      toolProfile,
      tools: [...tools],
      workspace: realWorkspace,
      argv: [claudeBin, ...args],
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  await fsp.writeFile(files.run, `${JSON.stringify({
    schemaVersion: RUN_RECORD_VERSION,
    invocationId,
    mode,
    model,
    route: LEAD_ROUTE,
    toolProfile,
    tools: [...tools],
    workspace: realWorkspace,
    requiredTools: [...effectiveRequiredTools],
    mcpEnabled: mcpConfigPath !== null,
    mcpConfig: mcpConfigPath,
    mcpAllowedTools: [...mcpAllowedTools],
    requiredMcpTools: summarizer.requiredMcpTools,
    budget: budget === null ? null : summaryBudget(budget),
    resume,
    identity,
    profileTransition: profileTransition === null ? null : { ...profileTransition },
    startedAt: startedAt.toISOString(),
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });

  const splitter = new LineSplitter((line) => {
    summarizer.pushLine(line);
    try {
      const record = JSON.parse(line);
      receivedFile.write(`${JSON.stringify({ ...record, sourceTimestamp: record.timestamp ?? null, observedAt: clock().toISOString() })}\n`);
    } catch {
      // The original malformed line stays in stdout.jsonl; the summarizer flags it.
    }
  }, () => summarizer.markOversizedLine());
  child.stdout?.on('data', (chunk) => {
    stdoutFile.write(chunk);
    splitter.push(chunk);
  });
  child.stdout?.on('end', () => splitter.end());
  child.stderr?.on('data', (chunk) => stderrFile.write(chunk));

  if (child.stdin) {
    child.stdin.on('error', () => {});
    const prompt = fs.createReadStream(promptPath);
    prompt.on('error', (err) => {
      extraErrors.push(`failed to read the prompt file (${err.code ?? err.name})`);
      child.stdin.destroy();
      stopper.stop();
    });
    prompt.pipe(child.stdin);
  }

  let timedOut = false;
  let stopReason = null;
  let cancelled = false;
  const deadlineTimer = setTimeout(() => {
    timedOut = true;
    stopReason = 'deadline';
    stopper.stop();
  }, deadlineMs ?? deadlineSeconds * 1000);
  const onAbort = () => {
    cancelled = true;
    stopReason = stopReason ?? 'cancelled';
    stopper.stop();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  if (onStarted) {
    onStarted({
      pid: child.pid ?? null,
      outDir: files.dir,
      invocationId,
      control: { ...CONTROL_FILES },
      cancel: () => {
        cancelled = true;
        stopReason = stopReason ?? 'cancelled';
        stopper.stop();
      },
    });
  }

  const { code, signal: exitSignal } = await exited;
  clearTimeout(deadlineTimer);
  stopper.clear();
  if (child.pid) stopper.reapGroup();
  if (signal) signal.removeEventListener('abort', onAbort);
  await Promise.all([endStream(stdoutFile), endStream(stderrFile), endStream(receivedFile)]);
  control.stop();

  const endedAt = clock();
  if (cancelled && !timedOut) extraErrors.push('cancelled by the host; the process group was stopped');
  const summary = {
    ...summarizer.finish({
      exitCode: code, signal: exitSignal, timedOut, stopReason, spawnError, extraErrors,
      resumedFrom: resume, resumeBaseline,
    }),
    invocationId,
    mode,
    toolProfile,
    tools: [...tools],
    profileTransition: profileTransition === null ? null : { ...profileTransition },
    runId: run?.runId ?? null,
    requestId: run?.requestId ?? null,
    phase: run?.phase ?? null,
    agentId: run?.agentId ?? null,
    parentAgentId: run?.parentAgentId ?? null,
    budget: budget === null ? null : summaryBudget(budget),
    workspace: realWorkspace,
    process: { pid: child.pid ?? null, exitCode: code, signal: exitSignal, timedOut, cancelled, stopReason, spawnError },
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    wallDurationMs: endedAt - startedAt,
    deadlineSeconds,
    safeMode: mcpConfigPath === null,
    mcpConfig: mcpConfigPath,
    mcpAllowedTools,
    resumeProfile: summarizer.requiredMcpTools,
    files: { stdout: files.stdout, stderr: files.stderr, pid: child.pid ? files.pid : null, run: files.run },
  };
  await fsp.writeFile(files.summary, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await Promise.all([endStream(eventsFile), endStream(publicEventsFile)]);
  return summary;
}

function summaryBudget(budget) {
  if (!isPlainObject(budget)) return null;
  return {
    authorized: budget.authorized === true,
    usd: typeof budget.usd === 'number' ? budget.usd : null,
    note: typeof budget.note === 'string' ? budget.note : null,
  };
}

// Stop a live run. Ownership is proven by the runner's own heartbeat for the
// same invocation plus the per-run token; a pid file by itself is never
// trusted, and no process is ever signalled from this function.
export async function cancelRun({ runDir, timeoutMs = CONTROL_TIMEOUT_MS, waitMs = 10_000, clock = () => new Date() } = {}) {
  const files = leadRunFiles(runDir);
  if (fs.existsSync(files.summary)) {
    return { ok: false, status: 'completed', reason: 'this run already wrote a summary; nothing to stop', run: files.dir };
  }
  let record;
  try {
    record = JSON.parse(await fsp.readFile(files.pid, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ok: false, status: 'no-live-runner', reason: 'no pid file: this run was never started or its directory was cleared' };
    }
    return { ok: false, status: 'refused', reason: 'pid file is not valid JSON' };
  }
  if (!isPlainObject(record) || record.runner !== RUN_MARKER) {
    return { ok: false, status: 'refused', reason: 'pid file is not owned by this runner; refusing to signal anything' };
  }
  if (!isPlainObject(record.control) || typeof record.controlToken !== 'string' || typeof record.invocationId !== 'string') {
    return { ok: false, status: 'no-live-runner', reason: 'the owning runner exposed no authenticated control channel' };
  }
  const heartbeatFile = path.join(files.dir, record.control.heartbeat);
  const requestFile = path.join(files.dir, record.control.request);
  const replyFile = path.join(files.dir, record.control.reply);
  // Liveness is the runner's own heartbeat for this exact invocation, not the
  // pid file. A stale or forged marker therefore reaches nothing.
  let heartbeat = null;
  try {
    heartbeat = JSON.parse(fs.readFileSync(heartbeatFile, 'utf8'));
  } catch {
    return { ok: false, status: 'no-live-runner', reason: 'the owning runner is not polling; refusing to signal a pid' };
  }
  const beatAge = Date.now() - Date.parse(heartbeat?.at ?? '');
  if (heartbeat?.invocationId !== record.invocationId || !Number.isFinite(beatAge) || beatAge > HEARTBEAT_FRESH_MS) {
    return { ok: false, status: 'no-live-runner', reason: 'the runner heartbeat is stale; refusing to signal a pid' };
  }
  try {
    fs.writeFileSync(requestFile, JSON.stringify({ invocationId: record.invocationId, token: record.controlToken, action: 'cancel', at: clock().toISOString() }), { mode: 0o600 });
  } catch {
    return { ok: false, status: 'refused', reason: 'the control request could not be written' };
  }
  const deadline = Date.now() + timeoutMs;
  let reply = null;
  while (Date.now() < deadline) {
    try {
      const candidate = JSON.parse(fs.readFileSync(replyFile, 'utf8'));
      if (candidate?.invocationId === record.invocationId) {
        reply = candidate;
        break;
      }
    } catch {
      // keep waiting for the runner to answer
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (reply === null) {
    return { ok: false, status: 'refused', reason: 'the live runner did not accept the control token; nothing was signalled' };
  }
  if (reply.ok !== true || reply.status !== 'stopping') {
    return { ok: false, status: 'not-stopped', reason: `the owning runner replied ${JSON.stringify(reply.status)}` };
  }
  const waited = await waitFor(() => fs.existsSync(files.summary), waitMs);
  return {
    ok: true,
    status: 'stopped',
    via: 'authenticated control channel',
    run: files.dir,
    confirmed: waited,
    signal: 'own process group',
  };
}

async function waitFor(predicate, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

// Non-spending readiness. Never calls a model; a missing dependency is
// unavailable and an unverified capability is unknown, never "verified".
export function leadDoctor({ baseEnv = process.env, home = null } = {}) {
  const nodeVersion = process.versions.node;
  const nodeMajor = Number(nodeVersion.split('.')[0]);
  const claude = findOnPath('claude', baseEnv.PATH ?? '');
  const dependencies = [
    {
      name: 'node',
      required: true,
      status: nodeMajor >= MIN_NODE_MAJOR ? 'available' : 'unavailable',
      detail: `Node ${nodeVersion}; ${MIN_NODE_MAJOR}+ required`,
    },
    {
      name: 'claude',
      required: true,
      status: claude === null ? 'unavailable' : 'available-unverified',
      path: claude,
      detail: claude === null
        ? 'Official Claude Code CLI not found on PATH. Install and log in with the Claude subscription before launch.'
        : 'CLI found. Its version, login and serving model are only verifiable by a run.',
    },
    {
      name: 'control-endpoint',
      required: true,
      status: 'available-unverified',
      detail: 'Cancellation is requested over a per-run, token-authenticated control channel the live runner polls; a pid file is never signalled. Verified by a live run.',
    },
  ];
  const capabilities = [
    { name: `model:${EXTERNAL_LEAD_MODEL}`, status: 'unknown', detail: 'Availability and serving identity require a live, budgeted run.' },
    { name: 'subscription-login', status: 'unknown', detail: 'The official client owns authentication; this check never reads credentials.' },
    {
      name: 'workspace-file-tools',
      status: 'unknown',
      detail: `Configured allowlist: ${LEAD_FILE_TOOLS.join(', ')}. Workspace checks are detection after execution, not a sandbox.`,
    },
    {
      name: 'tool-profiles',
      status: 'unknown',
      detail: `Profiles: files (default) and terminal (opt-in, adds ${TERMINAL_TOOLS.join(', ')}). Allowlisting a tool is not filesystem isolation; a live run reports what the session exposed.`,
    },
  ];
  const problems = dependencies.filter((d) => d.required && d.status === 'unavailable')
    .map((d) => ({ code: `${d.name.replace(/-/g, '_')}_unavailable`, message: d.detail }));
  const status = problems.length ? 'unavailable' : 'unknown';
  return {
    ok: problems.length === 0,
    status,
    ready: false,
    runtime_verified: false,
    model_calls_made: false,
    inference_request_made: false,
    home,
    route: LEAD_ROUTE,
    route_kind: LEAD_ROUTE_KIND,
    model: EXTERNAL_LEAD_MODEL,
    modes: [...LEAD_MODES],
    dependencies,
    capabilities,
    problems,
    limitations: [
      'Static check only: it cannot prove login state, serving model, tool exposure, or subscription quota.',
      'No hard account-wide spend enforcement; use host checkpoints and provider budget controls.',
      'File-tool workspace checks are detection after execution, not sandbox enforcement.',
      'Host desktop/browser control is not verified by this command and is not claimed.',
    ],
  };
}

function findOnPath(name, pathValue) {
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111)) return candidate;
    } catch {
      // keep searching
    }
  }
  return null;
}

// Validate a lead configuration document without spending: the same checks a
// run applies, reported before anything is launched.
export function validateLeadConfig(doc) {
  const problems = [];
  if (!isPlainObject(doc)) return { ok: false, status: 'invalid', problems: ['Configuration must be a JSON object.'], resolved: null };
  if (doc.schemaVersion !== SCHEMA_VERSION) problems.push(`schemaVersion must be ${SCHEMA_VERSION}.`);
  if (doc.mode !== undefined && !LEAD_MODES.includes(doc.mode)) problems.push(`mode must be one of: ${LEAD_MODES.join(', ')}.`);
  if (!isPlainObject(doc.lead)) problems.push('lead is required.');
  else if (doc.lead.model !== EXTERNAL_LEAD_MODEL) problems.push(`lead.model must be exactly ${EXTERNAL_LEAD_MODEL}.`);
  if (typeof doc.workspace !== 'string' || canonicalPathSync(doc.workspace) === null) problems.push('workspace must be an absolute path.');
  if (!isPlainObject(doc.budget) || doc.budget.authorized !== true || typeof doc.budget.usd !== 'number' || !(doc.budget.usd >= 0)) {
    problems.push('budget.authorized must be true with a non-negative usd amount.');
  }
  let args = null;
  try {
    args = buildLeadArgs({
      model: doc.lead?.model,
      mcpConfig: isPlainObject(doc.mcp) && doc.mcp.config ? doc.mcp.config : null,
      mcpAllowedTools: isPlainObject(doc.mcp) && Array.isArray(doc.mcp.allowedTools) ? doc.mcp.allowedTools : [],
      toolProfile: doc.toolProfile ?? DEFAULT_TOOL_PROFILE,
    });
  } catch (error) {
    problems.push(error.message);
  }
  const profileTools = (() => {
    try {
      return toolsForProfile(doc.toolProfile ?? DEFAULT_TOOL_PROFILE);
    } catch {
      return null;
    }
  })();
  if (Array.isArray(doc.tools) && profileTools !== null) {
    const extra = doc.tools.filter((tool) => !profileTools.includes(tool) && !tool.startsWith('mcp__'));
    if (extra.length) problems.push(`tools may only request the reviewed allowlist for this profile; unexpected: ${extra.join(', ')}`);
  }
  const envKeys = Object.keys(buildLeadEnv({ baseEnv: {}, model: EXTERNAL_LEAD_MODEL })).sort();
  return {
    ok: problems.length === 0,
    status: problems.length === 0 ? 'valid' : 'invalid',
    model_calls_made: false,
    runtime_verified: false,
    problems,
    resolved: problems.length === 0 ? {
      model: EXTERNAL_LEAD_MODEL,
      route: LEAD_ROUTE,
      mode: doc.mode ?? 'external-lead',
      toolProfile: doc.toolProfile ?? DEFAULT_TOOL_PROFILE,
      args,
      tools: profileTools ?? [...LEAD_FILE_TOOLS],
      pinnedEnvKeys: envKeys,
      scrubbedEnvPatterns: SCRUBBED_ENV.map((re) => re.source),
    } : null,
  };
}
