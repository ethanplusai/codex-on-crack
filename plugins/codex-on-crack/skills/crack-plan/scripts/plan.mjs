#!/usr/bin/env node
// Planning entry for a new build: recommend a lead/worker/tool shape from the
// user's own configured capabilities, and let the user decide.
//
// Static only: it reads the local catalog, roles, and readiness. No model call,
// no provider probe, no configuration write. The per-task role filter mirrors
// ../crack/scripts/select.mjs, which stays the authoritative selector.
import { parseArgs } from 'node:util';
import { CrackError, run } from '../../crack/scripts/lib/io.mjs';
import { checkAgentsShape, installationContext, locations, readConfig } from '../../crack/scripts/lib/config.mjs';
import { doctor } from '../../crack/scripts/lib/readiness.mjs';
import { TASK_CATEGORIES } from '../../crack/scripts/lib/roles.mjs';

const USAGE = `Usage: plan.mjs [--task ${TASK_CATEGORIES.join('|')}] [--role NAME] [--mode delegated|solo|external-lead] [--vision] [--min-context N] [--home dir] [--codex-home dir] [--profile name]`;
const WRITING_TASKS = ['implementation', 'ui', 'tests'];
const MODES = Object.freeze(['delegated', 'solo', 'external-lead']);
// Which conventional role name suits a task, used only as a qualitative
// tie-break. It is not a claim about measured model strength.
const CONVENTIONAL_ROLE = { implementation: 'builder', tests: 'builder', ui: 'builder', review: 'reviewer', research: 'reviewer' };

const MODE_SUMMARY = [
  { id: 'delegated', summary: 'Your selected lead scopes the work and one configured worker implements it.', requires: 'At least one configured worker role, plus native delegation in your host.' },
  { id: 'solo', summary: 'The selected lead does the work directly, with no worker.', requires: 'Nothing extra. Best for small or exploratory changes.' },
  { id: 'external-lead', summary: 'An optional official Claude Code subscription session acts as the project lead while a configured worker implements.', requires: 'The official Claude Code CLI with an existing login. Account quota is not observable here, and no API fallback exists.' },
];

const TOOLS = [
  { name: 'delegation', kind: 'host', note: 'Native worker dispatch uses the host\'s own tools and keeps the user\'s permissions.' },
  { name: 'file-tools', kind: 'profile', profile: 'files', default: true, note: 'Read, Write, Edit, Glob, Grep. Workspace checks are detection after execution, not a sandbox.' },
  { name: 'terminal', kind: 'profile', profile: 'terminal', default: false, optIn: true, note: 'Adds Bash so the lead can run its own checks. Allowlisting a tool is not filesystem isolation.' },
  { name: 'portable-replay', kind: 'viewer', note: 'Token-protected localhost viewer over the run directories or sessions you name. Recorded counters only.' },
];

function eligible(rung, { task, vision, minContext }) {
  const reasons = [];
  const tasks = rung.tasks ?? (rung.role === 'builder' ? ['implementation'] : []);
  if (task && !tasks.includes(task)) reasons.push('task-category-not-mapped');
  if (task) {
    const needsWrites = WRITING_TASKS.includes(task);
    if (rung.writes !== needsWrites) reasons.push(needsWrites ? 'role-is-read-only' : 'role-may-write');
  }
  if (vision && !rung.vision) reasons.push('image-input-not-advertised');
  if (minContext !== null && (rung.context_window === null || rung.context_window < minContext)) reasons.push('context-under-minimum');
  return reasons;
}

// Deterministic, explainable preference order. Every reason is a local fact
// plus an explicitly labelled judgement, never a measured superiority claim.
function rank(candidates, task) {
  const conventional = task === null ? null : CONVENTIONAL_ROLE[task] ?? null;
  const scored = candidates.map((rung) => {
    const why = [];
    let score = 0;
    const tasks = rung.tasks ?? (rung.role === 'builder' ? ['implementation'] : []);
    if (task !== null && tasks.includes(task)) {
      score += 2;
      why.push(`its configured tasks list explicitly includes "${task}"`);
    }
    if (conventional !== null && rung.role === conventional) {
      score += 1;
      why.push(`"${rung.role}" is the conventional role name for "${task}"`);
    }
    if (rung.file === 'in-sync') {
      score += 1;
      why.push('its generated file is present and unmodified');
    }
    if (!why.length) why.push('it is a configured primary role that matches this request');
    return { rung, score, why };
  });
  scored.sort((a, b) => (b.score - a.score) || a.rung.role.localeCompare(b.rung.role));
  return scored;
}

export function plan(values = {}) {
  const task = values.task ?? null;
  if (task !== null && !TASK_CATEGORIES.includes(task)) {
    throw new CrackError('usage', `--task must be one of: ${TASK_CATEGORIES.join(', ')}.`, USAGE);
  }
  const mode = values.mode ?? null;
  if (mode !== null && !MODES.includes(mode)) throw new CrackError('usage', `--mode must be one of: ${MODES.join(', ')}.`, USAGE);
  const requestedRole = values.role ?? null;

  const readiness = doctor(values);
  const vision = values.vision === true;
  const minContext = values['min-context'] === undefined ? null : Number(values['min-context']);
  const primaries = readiness.rungs.filter((rung) => rung.kind === 'primary');
  const candidates = [];
  const excluded = [];
  for (const rung of primaries) {
    const reasons = eligible(rung, { task, vision, minContext });
    if (reasons.length) excluded.push({ role: rung.role, model: rung.model, reasons });
    else candidates.push(rung);
  }

  const unavailable = readiness.problems.map((problem) => ({ code: problem.code, message: problem.message }));
  try {
    const where = locations({ home: values.home, codexHome: values['codex-home'] });
    checkAgentsShape(readConfig({ ...where, ...installationContext(where.codexHome, values.profile) }).config);
  } catch (error) {
    if (error instanceof CrackError && !unavailable.some((entry) => entry.code === error.code)) {
      unavailable.push({ code: error.code, message: error.message });
    }
  }

  const delegatedBlocked = [];
  if (readiness.delegation.configured && !readiness.delegation.ready) delegatedBlocked.push('readiness-not-ready');
  if (!readiness.delegation.configured) delegatedBlocked.push('no-roles-configured');
  if (task !== null && candidates.length === 0 && readiness.delegation.configured) delegatedBlocked.push('no-worker-for-task');
  if (requestedRole !== null && !candidates.some((rung) => rung.role === requestedRole)) delegatedBlocked.push('requested-role-does-not-qualify');
  if (unavailable.some((entry) => entry.code === 'subagents_disabled')) delegatedBlocked.push('subagents-disabled');

  const ranked = candidates.length ? rank(candidates, task) : [];
  const explicit = requestedRole === null ? null : candidates.find((rung) => rung.role === requestedRole) ?? null;
  // A named role that does not qualify is reported, never quietly replaced.
  const recommendedRung = requestedRole !== null ? explicit : (ranked[0]?.rung ?? null);
  const recommendation = requestedRole !== null && explicit === null
    ? null
    : explicit !== null
    ? { role: explicit.role, model: explicit.model, basis: 'user-requested', why: ['you named this role explicitly'], qualitative: false }
    : ranked.length
      ? { role: ranked[0].rung.role, model: ranked[0].rung.model, basis: 'qualitative-judgment-not-measured', why: ranked[0].why, qualitative: true }
      : null;
  const recommended = recommendedRung === null ? null : { ...recommendedRung, ...(recommendation ?? {}) };

  const choice = { required: [], satisfied: [] };
  if (mode !== null) choice.satisfied.push({ what: 'mode', detail: `You chose ${mode}.` });
  if (requestedRole !== null) choice.satisfied.push({ what: 'worker', detail: `You named the "${requestedRole}" role.` });
  if (mode === null) choice.required.push({ what: 'mode', detail: 'Confirm delegated, solo, or external-lead before starting.' });
  if (mode !== 'solo' && requestedRole === null) {
    if (candidates.length === 0) choice.required.push({ what: 'worker', detail: delegatedBlocked.includes('no-roles-configured') ? 'No worker roles are configured yet; run $codex-on-crack:crack-setup.' : 'No configured worker qualifies for this task; adjust the task, or configure another role.' });
    else if (candidates.length > 1) choice.required.push({ what: 'worker', detail: `${candidates.length} configured roles qualify; a reasoned recommendation is offered, and you may choose differently.` });
  }

  const blocking = unavailable.filter((entry) => ['agents_not_table', 'agents_absorbed_keys', 'unsupported_profile', 'ambiguous_profile', 'profile_missing'].includes(entry.code));
  const status = blocking.length ? 'not-ready'
    : !readiness.delegation.configured ? 'workflow-only'
      : mode === 'solo' ? 'plan-ready'
        : delegatedBlocked.length ? 'solo-only'
          : 'plan-ready';

  return {
    schemaVersion: 1,
    // ok means "this plan can proceed": either delegation has a qualifying
    // worker, or solo/direct work is available (which it always is).
    ok: blocking.length === 0,
    status,
    lead: {
      selected: readiness.root_model,
      source: 'user-selected',
      note: 'The Codex composer model. A skill cannot change it, and it is not the external project lead.',
    },
    externalLead: {
      model: 'claude-opus-5-5',
      route: 'subscription',
      status: 'unknown',
      requires: 'The official Claude Code CLI with an existing login.',
      note: 'Different role from the Codex host model: the external lead plans and reviews, and never receives Codex tools. Account quota is not observable here.',
    },
    mode,
    modes: MODE_SUMMARY,
    worker: {
      task,
      recommended,
      candidates,
      excluded,
      choiceRequired: choice.required.some((entry) => entry.what === 'worker'),
    },
    solo: {
      available: true,
      note: 'Solo work needs no worker; the selected lead does it directly.',
    },
    delegated: {
      ready: mode === 'solo' ? false : delegatedBlocked.length === 0,
      blocked: mode === 'solo' ? ['mode-is-solo'] : delegatedBlocked,
    },
    choice,
    tools: TOOLS,
    unavailable,
    unknown: [
      'Live provider routing and account access',
      'Serving identity for any role until a real task runs',
      'Task quality, latency, and cost',
      'Whether a fresh client session loaded the generated roles',
    ],
    next: {
      setup: 'node ../crack/scripts/setup.mjs scan',
      plan_request: 'Use $codex-on-crack:crack with the chosen worker and this scope.',
      external_lead: 'node ../crack/scripts/lead.mjs doctor',
      replay: 'node ../crack/viewer/bridge.mjs --run <run-dir> --out .local/replay',
      replay_native: 'node ../crack/viewer/serve.mjs --session <host-session.jsonl> --session <worker-session.jsonl>',
    },
    readiness: {
      status: readiness.status,
      delegation: readiness.delegation,
      profile: readiness.profile,
      catalog: readiness.catalog,
      problems: readiness.problems,
      warnings: readiness.warnings,
    },
    runtime_verified: false,
    model_calls_made: false,
    inference_request_made: false,
    limitations: [
      'Static facts only: catalog presence is not provider access and does not establish quality.',
      'The worker recommendation is a qualitative judgement about fit, not a measured ranking.',
      'No allowance, quota, savings, or price claims are made; missing usage stays unknown.',
      'The external Claude mode is a subscription CLI route; its account quota is not observable here.',
    ],
  };
}

run((argv) => {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        task: { type: 'string' }, role: { type: 'string' }, mode: { type: 'string' }, vision: { type: 'boolean' },
        'min-context': { type: 'string' }, home: { type: 'string' }, 'codex-home': { type: 'string' }, profile: { type: 'string' },
      },
    }));
  } catch (error) {
    throw new CrackError('usage', error.message, USAGE);
  }
  if (values['min-context'] !== undefined && !/^[1-9][0-9]*$/.test(values['min-context'])) {
    throw new CrackError('usage', '--min-context must be a positive integer.', USAGE);
  }
  return plan(values);
});
