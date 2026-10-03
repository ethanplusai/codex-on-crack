// crack.toml: validate it against the catalog, and render the files it generates.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CrackError } from './io.mjs';
import { parseToml, tomlString } from './toml.mjs';
import { routerProvider } from './catalog.mjs';

export const MARKER = '# Managed by codex-on-crack.';
export const ROLE_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const ROLE_KEYS = new Set(['model', 'fallback', 'effort', 'writes', 'brief', 'tasks']);
const REFERENCES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'references');

export const TASK_CATEGORIES = ['implementation', 'ui', 'review', 'research', 'tests'];

export const DEFAULT_ROLES = {
  scout: {
    writes: false,
    brief: 'Read-only codebase discovery and research. Maps the code, conventions, and constraints a task depends on and reports them with file and line citations. Never edits files.',
  },
  builder: {
    writes: true,
    brief: 'Implements one scoped task end to end, including its tests, inside its assigned paths.',
  },
  tester: {
    writes: true,
    brief: 'Writes and runs tests for a scoped behavior: happy path, negative cases, and boundaries. Changes only test files unless the brief says otherwise.',
  },
  reviewer: {
    writes: false,
    brief: 'Reviews a finished task in two stages: first whether it meets the spec, then whether it is well built. Reports findings with file and line citations. Never edits files.',
  },
  designer: {
    writes: true,
    brief: 'Builds and visually checks UI work: layout, states, responsiveness, and accessibility, using screenshots or the browser when available.',
  },
};

export function workerContract() {
  return fs.readFileSync(path.join(REFERENCES, 'worker-contract.md'), 'utf8');
}

export function parseCrackToml(text, label = 'crack.toml') {
  return parseToml(text, label);
}

function invalid(message) {
  return new CrackError('invalid_roles', message, 'Fix crack.toml (or the draft you passed), then retry.');
}

function checkRoleShape(name, role) {
  if (!ROLE_NAME.test(name)) throw invalid(`Role name "${name}" must match ${ROLE_NAME}.`);
  if (name.endsWith('_fallback')) throw invalid(`Role name "${name}" must not end in _fallback; that suffix names escalation rungs.`);
  if (role === null || typeof role !== 'object' || Array.isArray(role)) throw invalid(`roles.${name} must be a table.`);
  const unknown = Object.keys(role).filter((key) => !ROLE_KEYS.has(key));
  if (unknown.length) throw invalid(`roles.${name} has unknown key(s): ${unknown.join(', ')}.`);
  if (typeof role.model !== 'string' || !role.model) throw invalid(`roles.${name}.model is required.`);
  if (role.fallback !== undefined && (typeof role.fallback !== 'string' || !role.fallback)) {
    throw invalid(`roles.${name}.fallback must be a model id.`);
  }
  if (role.fallback === role.model) throw invalid(`roles.${name}.fallback must differ from its model.`);
  if (role.effort !== undefined && (typeof role.effort !== 'string' || !/^[a-z_]+$/.test(role.effort))) {
    throw invalid(`roles.${name}.effort must be a lowercase effort name.`);
  }
  if (role.writes !== undefined && typeof role.writes !== 'boolean') throw invalid(`roles.${name}.writes must be true or false.`);
  if (role.tasks !== undefined && (!Array.isArray(role.tasks) || role.tasks.some((task) => !TASK_CATEGORIES.includes(task)) || new Set(role.tasks).size !== role.tasks.length)) {
    throw invalid(`roles.${name}.tasks must be a unique array of task categories: ${TASK_CATEGORIES.join(', ')}.`);
  }
  if (typeof role.brief !== 'string' || !role.brief.trim() || role.brief.length > 2000) {
    throw invalid(`roles.${name}.brief must be 1-2000 characters.`);
  }
}

export function validateRoles(doc, models) {
  if (doc?.schema_version !== 1) throw invalid('crack.toml needs schema_version = 1.');
  const table = doc.roles;
  if (table === null || typeof table !== 'object' || Array.isArray(table) || !Object.keys(table).length) {
    throw invalid('crack.toml needs at least one [roles.<name>] table.');
  }
  const byModel = new Map(models.map((model) => [model.model, model]));
  const warnings = [];
  const roles = Object.entries(table).map(([name, role]) => {
    checkRoleShape(name, role);
    const rung = (kind, model) => {
      const found = byModel.get(model);
      if (!found) {
        throw new CrackError('model_not_in_catalog', `roles.${name}: ${model} is not in the catalog Codex uses.`,
          'Pick a model from `setup.mjs scan`, or add it with the tool that manages your catalog.');
      }
      if (!found.eligible) {
        throw new CrackError('model_ineligible', `roles.${name}: ${model} cannot run as a subagent (${found.reason}).`,
          'Pick an eligible model from `setup.mjs scan`.');
      }
      if (!found.efforts.length) throw invalid(`roles.${name}: supported reasoning efforts are missing from local metadata.`);
      let effort = found.defaultEffort;
      if (role.effort !== undefined) {
        if (!found.efforts.includes(role.effort)) throw invalid(`roles.${name} (${kind}): ${model} does not support effort "${role.effort}" in local metadata.`);
        effort = role.effort;
      }
      if (!effort) throw invalid(`roles.${name}: no verified default effort; select a supported effort explicitly.`);
      return { kind, agent: kind === 'primary' ? `crack_${name}` : `crack_${name}_fallback`, model, effort };
    };
    const rungs = [rung('primary', role.model)];
    if (role.fallback !== undefined) rungs.push(rung('fallback', role.fallback));
    return {
      name,
      model: role.model,
      fallback: role.fallback ?? null,
      effort: role.effort ?? null,
      writes: role.writes ?? false,
      ...(role.tasks === undefined ? {} : { tasks: [...role.tasks] }),
      brief: role.brief.trim(),
      rungs,
    };
  });
  return { roles, warnings };
}

export function renderCrackToml(roles, installation = null) {
  const lines = [`${MARKER} Edit roles here, then run setup again to regenerate the agent files.`, 'schema_version = 1'];
  if (installation) {
    lines.push('', '[installation]', `profile = ${tomlString(installation.profile ?? '')}`, `catalog = ${tomlString(installation.catalog)}`);
  }
  for (const role of roles) {
    lines.push('', `[roles.${role.name}]`, `model = ${tomlString(role.model)}`);
    if (role.fallback) lines.push(`fallback = ${tomlString(role.fallback)}`);
    if (role.effort) lines.push(`effort = ${tomlString(role.effort)}`);
    if (role.tasks !== undefined) lines.push(`tasks = [${role.tasks.map(tomlString).join(', ')}]`);
    lines.push(`writes = ${role.writes}`, `brief = ${tomlString(role.brief)}`);
  }
  return `${lines.join('\n')}\n`;
}

function workerInstructions(contract, role, rung) {
  const parts = [contract.trim(), '', `## Your role: ${role.name}`, role.brief];
  if (!role.writes) {
    parts.push('', 'You are read-only. Never create, edit, move, or delete files, and never run commands that change them. Report findings instead.');
  }
  if (rung.kind === 'fallback') {
    parts.push('', 'You are the escalation rung. A different model already attempted this task and did not pass review; its report is attached to your brief. Do not repeat its approach blindly. Find the root cause of the failure and fix it.');
  }
  return parts.join('\n');
}

export function renderAgentFile({ role, rung, provider, contract }) {
  const label = rung.kind === 'fallback' ? `${role.name} (escalation rung)` : role.name;
  const lines = [
    `${MARKER} Generated from crack.toml; edit that file and run setup again instead of editing this one.`,
    `name = ${tomlString(rung.agent)}`,
    `description = ${tomlString(`codex-on-crack ${label}: ${role.brief}`)}`,
    `model = ${tomlString(rung.model)}`,
  ];
  if (provider) lines.push(`model_provider = ${tomlString(provider)}`);
  if (rung.effort) lines.push(`model_reasoning_effort = ${tomlString(rung.effort)}`);
  lines.push(
    `developer_instructions = ${tomlString(workerInstructions(contract, role, rung))}`,
    '',
    '# Inherit parent permissions. Recursion is forbidden by instructions; host enforcement varies.',
    '[agents]',
    'enabled = false',
  );
  return `${lines.join('\n')}\n`;
}

export function agentFiles({ codexHome, roles, contract = workerContract() }) {
  const agentsDir = path.join(codexHome, 'agents');
  return roles.flatMap((role) => role.rungs.map((rung) => {
    const provider = routerProvider(codexHome, rung.model);
    return {
      file: path.join(agentsDir, `${rung.agent}.toml`),
      text: renderAgentFile({ role, rung, provider, contract }),
      role,
      rung,
      provider,
    };
  }));
}

export function reviewWarnings(roles) {
  const builder = roles.find((role) => role.name === 'builder');
  const reviewer = roles.find((role) => role.name === 'reviewer');
  if (builder && reviewer && builder.model === reviewer.model) {
    return ['reviewer and builder use the same model in separate sessions; independent context can help, but review quality still needs evidence.'];
  }
  return [];
}
