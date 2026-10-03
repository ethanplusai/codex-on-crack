// Trusted startup configuration for the panel controller.
//
// The configuration is written by the user and read once at startup. It is the
// only place workspaces, observed runs, launch profiles, and review evidence are
// registered: nothing reaching the controller over HTTP or MCP can add a root,
// a command, or a path outside them.
import fs from 'node:fs';
import path from 'node:path';
import { LEAD_MODES } from '../../plugins/codex-on-crack/skills/crack/scripts/lib/lead-protocol.mjs';
import { TOOL_PROFILES, DEFAULT_DEADLINE_SECONDS } from '../../plugins/codex-on-crack/skills/crack/scripts/lib/external-lead.mjs';
import { PanelError, canonicalDirectory, resolveInside } from './paths.mjs';

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const GATES = Object.freeze(['early-design', 'visual', 'final']);
const LABEL_MAX = 80;
const ROUTE_ROLES = ['host', 'worker'];
const ROUTE_KINDS = ['host', 'subscription', 'router', 'api', 'unknown'];

const TOP_KEYS = new Set(['schemaVersion', 'stateDir', 'workspaces', 'runs', 'sessions', 'routes', 'launch', 'reviews']);
const WORKSPACE_KEYS = new Set(['id', 'root', 'label']);
const RUN_KEYS = new Set(['id', 'dir', 'label', 'workspace']);
const ROUTE_KEYS = new Set(['label', 'model', 'route']);
const LAUNCH_KEYS = new Set(['enabled', 'claudeBin', 'profiles']);
const PROFILE_KEYS = new Set(['id', 'label', 'workspace', 'request', 'prompt', 'runsDir', 'mode', 'toolProfile',
  'deadlineSeconds', 'requiresApproval', 'resumePrompt', 'feedbackFrom']);
const REVIEW_KEYS = new Set(['id', 'title', 'gate', 'workspace', 'reference', 'actual', 'checks', 'run', 'question']);
// The same refusal the request protocol applies: configuration describes
// sources, never an executable action.
const FORBIDDEN_KEYS = /^(command|cmd|argv|args|shell|exec|execute|script|spawn|env|environment|pid)$/i;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function label(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim().slice(0, LABEL_MAX);
}

function checkKeys(doc, allowed, where, problems) {
  for (const key of Object.keys(doc)) {
    if (FORBIDDEN_KEYS.test(key)) problems.push(`${where}.${key} is not accepted: configuration may not carry executable actions.`);
    else if (!allowed.has(key)) problems.push(`${where}.${key} is not a recognised field.`);
  }
}

function uniqueIds(list, where, problems) {
  const seen = new Set();
  for (const item of list) {
    if (!ID_RE.test(item?.id ?? '')) problems.push(`${where} id ${JSON.stringify(item?.id)} must match ${ID_RE}.`);
    else if (seen.has(item.id)) problems.push(`${where} id ${item.id} is duplicated.`);
    else seen.add(item.id);
  }
}

// Validate and canonicalise. Returns { ok, problems, config }. Paths that do
// not resolve inside a registered root are problems, never silently dropped.
export function validatePanelConfig(doc) {
  const problems = [];
  if (!isPlainObject(doc)) return { ok: false, problems: ['Configuration must be a JSON object.'], config: null };
  checkKeys(doc, TOP_KEYS, 'config', problems);
  if (doc.schemaVersion !== 1) problems.push('config.schemaVersion must be 1.');
  if (typeof doc.stateDir !== 'string' || !path.isAbsolute(doc.stateDir)) problems.push('config.stateDir must be an absolute path.');

  const workspaces = [];
  if (!Array.isArray(doc.workspaces) || doc.workspaces.length === 0) problems.push('config.workspaces must list at least one workspace.');
  else {
    uniqueIds(doc.workspaces, 'workspace', problems);
    for (const [index, entry] of doc.workspaces.entries()) {
      if (!isPlainObject(entry)) { problems.push(`config.workspaces[${index}] must be an object.`); continue; }
      checkKeys(entry, WORKSPACE_KEYS, `config.workspaces[${index}]`, problems);
      const root = canonicalDirectory(entry.root);
      if (root === null) problems.push(`config.workspaces[${index}].root must be an existing absolute directory.`);
      else if (root === path.parse(root).root) problems.push(`config.workspaces[${index}].root must not be the filesystem root.`);
      const name = label(entry.label, entry.id);
      if (name === null) problems.push(`config.workspaces[${index}].label must be a non-empty string.`);
      if (root !== null && name !== null) workspaces.push({ id: entry.id, root, label: name });
    }
  }
  const roots = workspaces.map((w) => w.root);
  const workspaceById = new Map(workspaces.map((w) => [w.id, w]));
  const inside = (value, where, { kind = 'file', mustExist = true } = {}) => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      problems.push(`${where} must be an absolute path.`);
      return null;
    }
    const resolved = resolveInside(roots, value);
    if (resolved === null) {
      problems.push(`${where} is not inside a registered workspace (after resolving symlinks).`);
      return null;
    }
    if (mustExist) {
      let stat = null;
      try { stat = fs.statSync(resolved); } catch { stat = null; }
      if (kind === 'file' && stat?.isFile() !== true) { problems.push(`${where} must be an existing file.`); return null; }
      if (kind === 'dir' && stat?.isDirectory() !== true) { problems.push(`${where} must be an existing directory.`); return null; }
    }
    return resolved;
  };
  const workspaceRef = (value, where, source = null) => {
    if (value === undefined) return (source ? [...workspaces].sort((a,b)=>b.root.length-a.root.length).find(w=>source===w.root||source.startsWith(w.root+path.sep))?.id : null) ?? workspaces[0]?.id ?? null;
    if (!workspaceById.has(value)) { problems.push(`${where} names an unknown workspace.`); return null; }
    return value;
  };

  const runs = [];
  if (doc.runs !== undefined) {
    if (!Array.isArray(doc.runs)) problems.push('config.runs must be an array.');
    else {
      uniqueIds(doc.runs, 'run', problems);
      for (const [index, entry] of doc.runs.entries()) {
        if (!isPlainObject(entry)) { problems.push(`config.runs[${index}] must be an object.`); continue; }
        checkKeys(entry, RUN_KEYS, `config.runs[${index}]`, problems);
        const dir = inside(entry.dir, `config.runs[${index}].dir`, { kind: 'dir' });
        const name = label(entry.label, entry.id);
        if (name === null) problems.push(`config.runs[${index}].label must be a non-empty string.`);
        const workspace = workspaceRef(entry.workspace, `config.runs[${index}].workspace`, dir);
        if (dir !== null && name !== null) runs.push({ id: entry.id, dir, label: name, workspace, origin: 'observed' });
      }
    }
  }

  const sessions = [];
  if (doc.sessions !== undefined) {
    if (!Array.isArray(doc.sessions) || doc.sessions.length > 100) problems.push('config.sessions must be an array of at most 100 sources.');
    else {
      uniqueIds(doc.sessions, 'session', problems);
      for (const entry of doc.sessions) {
        if (!isPlainObject(entry)) { problems.push('Session must be an object.'); continue; }
        checkKeys(entry, new Set(['id','file','label','workspace','details']), 'session', problems);
        const workspace = workspaceRef(entry.workspace, 'session.workspace');
        const name = label(entry.label, entry.id);
        if (!name) problems.push('Session label must be non-empty.');
        if (entry.details !== undefined && typeof entry.details !== 'boolean') problems.push('Session details must be boolean.');
        // Session files live outside project roots. Authorize one exact canonical
        // regular JSONL file, never a directory or a broader account root.
        let valid = false;
        try { valid = typeof entry.file === 'string' && path.isAbsolute(entry.file) && entry.file.endsWith('.jsonl') && fs.realpathSync(entry.file) === entry.file && fs.lstatSync(entry.file).isFile(); } catch {}
        if (!valid) problems.push('Session file must be an existing canonical absolute JSONL file, not a symlink.');
        if (runs.some(r=>r.id===entry.id)) problems.push('Session and run ids must be distinct.');
        if (valid && name) sessions.push({id:entry.id,file:entry.file,label:name,workspace,details:entry.details===true});
      }
    }
  }

  const routes = {};
  if (doc.routes !== undefined) {
    if (!isPlainObject(doc.routes)) problems.push('config.routes must be an object.');
    else {
      for (const [role, entry] of Object.entries(doc.routes)) {
        if (!ROUTE_ROLES.includes(role)) { problems.push(`config.routes.${role} is not a recognised role (host, worker). The lead route is fixed by the adapter.`); continue; }
        if (!isPlainObject(entry)) { problems.push(`config.routes.${role} must be an object.`); continue; }
        checkKeys(entry, ROUTE_KEYS, `config.routes.${role}`, problems);
        const name = label(entry.label, role === 'host' ? 'Codex host' : 'Worker');
        const model = typeof entry.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(entry.model) ? entry.model : null;
        if (entry.model !== undefined && model === null) problems.push(`config.routes.${role}.model must be a model identifier.`);
        const route = entry.route ?? 'unknown';
        if (!ROUTE_KINDS.includes(route)) problems.push(`config.routes.${role}.route must be one of: ${ROUTE_KINDS.join(', ')}.`);
        if (name !== null) routes[role] = { label: name, model, route };
      }
    }
  }

  const reviews = [];
  if (doc.reviews !== undefined) {
    if (!Array.isArray(doc.reviews)) problems.push('config.reviews must be an array.');
    else {
      uniqueIds(doc.reviews, 'review', problems);
      for (const [index, entry] of doc.reviews.entries()) {
        const where = `config.reviews[${index}]`;
        if (!isPlainObject(entry)) { problems.push(`${where} must be an object.`); continue; }
        checkKeys(entry, REVIEW_KEYS, where, problems);
        const title = label(entry.title, entry.id);
        if (title === null) problems.push(`${where}.title must be a non-empty string.`);
        const gate = entry.gate ?? 'visual';
        if (!GATES.includes(gate)) problems.push(`${where}.gate must be one of: ${GATES.join(', ')}.`);
        const reference = entry.reference === undefined || entry.reference === null ? null : inside(entry.reference, `${where}.reference`, { mustExist: false });
        // The actual evidence may not exist yet: the review then awaits evidence.
        const actual = entry.actual === undefined || entry.actual === null ? null : inside(entry.actual, `${where}.actual`, { mustExist: false });
        const checks = entry.checks === undefined ? [] : entry.checks;
        if (!Array.isArray(checks) || checks.some((c) => typeof c !== 'string' || !c.trim() || c.length > 300)) {
          problems.push(`${where}.checks must be an array of short strings.`);
        }
        if (entry.run !== undefined && !ID_RE.test(entry.run)) problems.push(`${where}.run must be a run id.`);
        const workspace = workspaceRef(entry.workspace, `${where}.workspace`, actual ?? reference);
        const question=entry.question??null;
        if(question!==null&&(typeof question!=="string"||!question.trim()||question.length>2000))problems.push(`${where}.question must be a non-empty string of at most 2000 characters.`);
        if (title !== null) {
          reviews.push({ id: entry.id, title, question, gate, workspace, reference, actual, checks: Array.isArray(checks) ? checks.map((c) => String(c).trim()) : [], run: entry.run ?? null });
        }
      }
    }
  }
  const reviewIds = new Set(reviews.map((r) => r.id));

  const launch = { enabled: false, claudeBin: null, profiles: [] };
  if (doc.launch !== undefined) {
    if (!isPlainObject(doc.launch)) problems.push('config.launch must be an object.');
    else {
      checkKeys(doc.launch, LAUNCH_KEYS, 'config.launch', problems);
      if (doc.launch.enabled !== undefined && typeof doc.launch.enabled !== 'boolean') problems.push('config.launch.enabled must be a boolean.');
      launch.enabled = doc.launch.enabled === true;
      if (doc.launch.claudeBin !== undefined && doc.launch.claudeBin !== null) {
        // A trusted test hook for a mocked CLI. It is never reachable from the UI.
        if (typeof doc.launch.claudeBin !== 'string' || !path.isAbsolute(doc.launch.claudeBin)) problems.push('config.launch.claudeBin must be an absolute path.');
        else launch.claudeBin = doc.launch.claudeBin;
      }
      const profiles = doc.launch.profiles ?? [];
      if (!Array.isArray(profiles)) problems.push('config.launch.profiles must be an array.');
      else {
        uniqueIds(profiles, 'profile', problems);
        for (const [index, entry] of profiles.entries()) {
          const where = `config.launch.profiles[${index}]`;
          if (!isPlainObject(entry)) { problems.push(`${where} must be an object.`); continue; }
          checkKeys(entry, PROFILE_KEYS, where, problems);
          const workspace = workspaceRef(entry.workspace, `${where}.workspace`);
          const request = inside(entry.request, `${where}.request`);
          const prompt = inside(entry.prompt, `${where}.prompt`);
          const runsDir = inside(entry.runsDir, `${where}.runsDir`, { mustExist: false });
          const resumePrompt = entry.resumePrompt === undefined ? null : inside(entry.resumePrompt, `${where}.resumePrompt`);
          const mode = entry.mode ?? 'external-lead';
          if (!LEAD_MODES.includes(mode)) problems.push(`${where}.mode must be one of: ${LEAD_MODES.join(', ')}.`);
          const toolProfile = entry.toolProfile ?? 'files';
          if (!Object.hasOwn(TOOL_PROFILES, toolProfile)) problems.push(`${where}.toolProfile must be one of: ${Object.keys(TOOL_PROFILES).join(', ')}.`);
          const deadlineSeconds = entry.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS;
          if (!Number.isSafeInteger(deadlineSeconds) || deadlineSeconds < 1 || deadlineSeconds > 86_400) problems.push(`${where}.deadlineSeconds must be an integer from 1 to 86400.`);
          for (const key of ['requiresApproval', 'feedbackFrom']) {
            if (entry[key] !== undefined && !reviewIds.has(entry[key])) problems.push(`${where}.${key} names an unknown review.`);
          }
          const name = label(entry.label, entry.id);
          if (name === null) problems.push(`${where}.label must be a non-empty string.`);
          launch.profiles.push({
            id: entry.id, label: name, workspace, request, prompt, runsDir, resumePrompt, mode, toolProfile, deadlineSeconds,
            requiresApproval: entry.requiresApproval ?? null, feedbackFrom: entry.feedbackFrom ?? null,
          });
        }
      }
    }
  }

  const ok = problems.length === 0;
  return {
    ok,
    problems,
    config: ok ? { schemaVersion: 1, stateDir: path.resolve(doc.stateDir), workspaces, runs, sessions, routes, reviews, launch } : null,
  };
}

export function loadPanelConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new PanelError('config_missing', `No readable panel configuration at ${file}.`, 500);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new PanelError('config_invalid', 'The panel configuration is not valid JSON.', 500);
  }
  const result = validatePanelConfig(doc);
  if (!result.ok) {
    const error = new PanelError('config_invalid', `The panel configuration has ${result.problems.length} problem(s).`, 500);
    error.problems = result.problems;
    throw error;
  }
  return result.config;
}
