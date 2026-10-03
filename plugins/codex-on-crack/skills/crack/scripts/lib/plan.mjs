// Plan schema 2: structure, roles, file scopes, and waves. Runs nothing.
import fs from 'node:fs';
import path from 'node:path';
import { CrackError } from './io.mjs';

export const STATES = new Set(['planned', 'ready', 'running', 'review', 'changes_requested', 'escalated', 'accepted', 'blocked']);
export const RUNGS = new Set(['primary', 'fallback', 'orchestrator']);
const PLACEHOLDER = /\b(TBD|TODO|REPLACE_ME)\b|<[^>]+>/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function planError(message) {
  return new CrackError('plan_invalid', message, 'Fix the plan, then validate it again.');
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw planError(`${label} must be a nonempty string.`);
  if (PLACEHOLDER.test(value)) throw planError(`${label} still contains a template placeholder.`);
  return value;
}

export function normalizePath(value, label) {
  const raw = text(value, label);
  const parts = raw.split('/').filter((part) => part && part !== '.');
  if (raw.startsWith('/') || !parts.length || parts.some((part) => part === '..' || part === '.git')) {
    throw planError(`${label} must be a repository-relative path without '..' or '.git'.`);
  }
  if (/[*?[\]\\:\n\r]/.test(raw)) throw planError(`${label} must be a literal path, not a glob.`);
  return parts.join('/');
}

function documentRef(value, label, root) {
  const relative = normalizePath(value, label);
  const failure = planError(`${label} must reference an existing document inside the repo root.`);
  let real;
  try {
    real = fs.realpathSync(path.join(root, relative));
  } catch {
    throw failure;
  }
  const inside = path.relative(fs.realpathSync(root), real);
  if (inside.startsWith('..') || path.isAbsolute(inside) || !fs.statSync(real).isFile()) throw failure;
}

function objects(value, label) {
  if (!Array.isArray(value) || !value.length || !value.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))) {
    throw planError(`${label} must be a nonempty list of objects.`);
  }
  return value;
}

function checks(value, label) {
  objects(value, label).forEach((item, index) => {
    text(item.command, `${label}[${index}].command`);
    text(item.expected, `${label}[${index}].expected`);
  });
}

function graph(items, label) {
  const indexed = new Map();
  for (const item of items) {
    const name = text(item.id, `${label}.id`);
    if (!ID.test(name) || indexed.has(name)) throw planError(`Invalid or duplicate ${label} ID: ${name}`);
    indexed.set(name, item);
  }
  for (const [name, item] of indexed) {
    const deps = item.depends_on;
    if (!Array.isArray(deps) || !deps.every((dep) => typeof dep === 'string')) throw planError(`${label} ${name} needs a depends_on list.`);
    if (new Set(deps).size !== deps.length || deps.some((dep) => !indexed.has(dep) || dep === name)) {
      throw planError(`${label} ${name} has duplicate, missing, or self dependencies.`);
    }
  }
  const done = new Set();
  const active = new Set();
  const visit = (name) => {
    if (active.has(name)) throw planError(`Dependency cycle in ${label}: ${name}`);
    if (done.has(name)) return;
    active.add(name);
    for (const dep of indexed.get(name).depends_on) visit(dep);
    active.delete(name);
    done.add(name);
  };
  for (const name of indexed.keys()) visit(name);
  return indexed;
}

export function pathsOverlap(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function rolesForPlan(doc) {
  if (doc?.roles === null || typeof doc?.roles !== 'object' || Array.isArray(doc.roles)) {
    throw new CrackError('invalid_roles', 'crack.toml has no [roles] tables.', 'Run $codex-on-crack:crack-setup.');
  }
  return new Map(Object.entries(doc.roles).map(([name, role]) => [name, { writes: role?.writes === true }]));
}

function ancestorsOf(phases, name, seen = new Set()) {
  for (const dep of phases.get(name).depends_on) {
    if (!seen.has(dep)) {
      seen.add(dep);
      ancestorsOf(phases, dep, seen);
    }
  }
  return seen;
}

// Waves: dependency levels (task dependencies plus every task in a prerequisite
// phase), each split into sub-waves so that concurrent writers never share a
// path and never exceed the writer cap. Readers ride in a level's first sub-wave.
function computeWaves(tasks, phases, info, capacity) {
  const prerequisites = new Map([...tasks.values()].map((task) => {
    const earlier = ancestorsOf(phases, task.phase);
    const fromPhases = [...tasks.values()].filter((other) => earlier.has(other.phase)).map((other) => other.id);
    return [task.id, new Set([...task.depends_on, ...fromPhases])];
  }));
  const levels = new Map();
  const levelOf = (id) => {
    if (!levels.has(id)) {
      const deps = [...prerequisites.get(id)];
      levels.set(id, deps.length ? 1 + Math.max(...deps.map(levelOf)) : 0);
    }
    return levels.get(id);
  };
  const byLevel = [];
  for (const id of tasks.keys()) (byLevel[levelOf(id)] ??= []).push(id);
  const waves = [];
  for (const ids of byLevel) {
    if (!ids) continue;
    const readers = ids.filter((id) => !info.get(id).writes);
    const groups = [];
    for (const id of ids.filter((candidate) => info.get(candidate).writes)) {
      const fits = groups.find((group) => group.length < capacity && group.every((other) => !info.get(id).scope
        .some((a) => info.get(other).scope.some((b) => pathsOverlap(a, b)))));
      if (fits) fits.push(id);
      else groups.push([id]);
    }
    if (!groups.length) groups.push([]);
    groups.forEach((group, index) => {
      waves.push({
        wave: waves.length + 1,
        tasks: index === 0 ? [...readers, ...group] : group,
        writers: group,
        worktrees: group.length > 1,
      });
    });
  }
  return waves;
}

export function validatePlan(plan, root, roles) {
  if (plan === null || typeof plan !== 'object' || plan.schema_version !== 2) throw planError('Expected schema_version 2.');
  text(plan.project, 'project');
  documentRef(plan.spec, 'spec', root);
  const capacity = plan.max_parallel_writers ?? 1;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8) {
    throw planError('max_parallel_writers must be an integer from 1 to 8.');
  }
  const phases = graph(objects(plan.phases, 'phases'), 'phase');
  const tasks = graph(objects(plan.tasks, 'tasks'), 'task');
  for (const phase of phases.values()) {
    text(phase.goal, 'phase.goal');
    checks(phase.integration_checks, 'phase.integration_checks');
  }
  const info = new Map();
  for (const task of tasks.values()) {
    const id = task.id;
    if (!phases.has(task.phase)) throw planError(`Task ${id} refers to a missing phase.`);
    const role = text(task.role, `Task ${id} role`);
    const writes = role === 'orchestrator' ? true : roles.get(role)?.writes;
    if (writes === undefined) {
      throw new CrackError('plan_invalid',
        `Task ${id} role "${role}" is not in crack.toml (and is not "orchestrator").`,
        roles.size
          ? 'Fix the role name or crack.toml, then validate again.'
          : 'No roles are configured. Keep this task with role "orchestrator" for direct work, or run $codex-on-crack:crack-setup to configure a delegated role.');
    }
    if (task.risk !== 'normal' && task.risk !== 'sensitive') throw planError(`Task ${id} needs risk normal or sensitive.`);
    if (task.risk === 'sensitive' && role !== 'orchestrator') {
      throw planError(`Sensitive task ${id} must stay with the orchestrator; split safe supporting work into another task.`);
    }
    if (!STATES.has(task.state)) throw planError(`Task ${id} has an invalid state.`);
    if (!RUNGS.has(task.rung ?? 'primary')) throw planError(`Task ${id} rung must be primary, fallback, or orchestrator.`);
    const cycles = task.review_cycles ?? 0;
    if (!Number.isInteger(cycles) || cycles < 0) throw planError(`Task ${id} review_cycles must be a non-negative integer.`);
    documentRef(task.brief, `Task ${id} brief`, root);
    const listed = task.allowed_paths ?? [];
    if (!Array.isArray(listed)) throw planError(`Task ${id} allowed_paths must be a list.`);
    const scope = listed.map((entry) => normalizePath(entry, `Task ${id} allowed path`));
    if (writes && !scope.length) throw planError(`Task ${id} writes, so it needs allowed_paths.`);
    if (!writes && scope.length) throw planError(`Task ${id} uses read-only role "${role}" but lists allowed_paths.`);
    if (!Array.isArray(task.acceptance) || !task.acceptance.length) throw planError(`Task ${id} requires acceptance criteria.`);
    task.acceptance.forEach((criterion) => text(criterion, `Task ${id} acceptance`));
    checks(task.checks, `Task ${id} checks`);
    info.set(id, { writes, scope });
  }
  for (const task of tasks.values()) {
    for (const dep of task.depends_on) {
      const depPhase = tasks.get(dep).phase;
      if (depPhase !== task.phase && !ancestorsOf(phases, task.phase).has(depPhase)) {
        throw planError(`Task ${task.id} depends on a task in a phase that is not declared as its prerequisite.`);
      }
    }
  }
  return {
    status: 'structure-valid',
    phases: phases.size,
    tasks: tasks.size,
    max_parallel_writers: capacity,
    waves: computeWaves(tasks, phases, info, capacity),
    note: 'No commands were run. Readiness, workspaces, permissions, semantic correctness, and acceptance are not verified.',
  };
}
