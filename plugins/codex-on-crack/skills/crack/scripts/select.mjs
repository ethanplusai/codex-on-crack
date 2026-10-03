#!/usr/bin/env node
// Deterministic advisory selection. Never dispatches or changes configuration.
import { parseArgs } from 'node:util';
import { CrackError, run } from './lib/io.mjs';
import { doctor } from './lib/readiness.mjs';
import { TASK_CATEGORIES, ROLE_NAME } from './lib/roles.mjs';

const USAGE = 'Usage: select.mjs --task CATEGORY [--role NAME] [--vision] [--min-context N] [--home dir] [--codex-home dir] [--profile name]';
run((argv) => {
  let values;
  try { ({ values } = parseArgs({ args: argv, strict: true, options: {
    task: { type: 'string' }, role: { type: 'string' }, vision: { type: 'boolean' },
    'min-context': { type: 'string' }, home: { type: 'string' }, 'codex-home': { type: 'string' }, profile: { type: 'string' },
  } })); } catch { throw new CrackError('usage', 'Invalid selection arguments.', USAGE); }
  if (!TASK_CATEGORIES.includes(values.task) || (values.role !== undefined && !ROLE_NAME.test(values.role))) {
    throw new CrackError('usage', 'Supply a supported task category and valid role name.', USAGE);
  }
  const minimum = values['min-context'] === undefined ? null : Number(values['min-context']);
  if (minimum !== null && (!/^[1-9][0-9]*$/.test(values['min-context']) || !Number.isSafeInteger(minimum))) {
    throw new CrackError('usage', '--min-context must be a positive safe integer.', USAGE);
  }
  const readiness = doctor(values);
  const excluded = [];
  const candidates = readiness.rungs.filter((rung) => rung.kind === 'primary').filter((rung) => {
    const reasons = [];
    if (values.role && rung.role !== values.role) return false;
    const tasks = rung.tasks ?? (rung.role === 'builder' ? ['implementation'] : []);
    if (!values.role && !tasks.includes(values.task)) reasons.push('Task category is not mapped to this role.');
    const needsWrites = ['implementation', 'ui', 'tests'].includes(values.task);
    if (rung.writes !== needsWrites) reasons.push(needsWrites ? 'Task requires a role allowed to write.' : 'Task requires a read-only role.');
    if (values.vision && !rung.vision) reasons.push('Image input capability is not advertised by the catalog.');
    if (minimum !== null && (rung.context_window === null || rung.context_window < minimum)) reasons.push('Catalog context window is unknown or below the requested minimum.');
    if (reasons.length) { excluded.push({ role: rung.role, reasons }); return false; }
    return true;
  }).map((rung) => ({ ...rung, reasons: [values.role ? 'Explicit configured role requested.' : 'Configured task mapping matched.',
    'Role write permission matches the task category.', ...(values.vision ? ['Catalog advertises image input.'] : []),
    ...(minimum === null ? [] : ['Catalog context window meets the requested minimum.'])] }));
  const ready = readiness.delegation.ready;
  return {
    ok: ready, status: !ready ? 'not-ready' : candidates.length === 1 ? 'selected' : 'needs-choice',
    task: values.task, selected: ready && candidates.length === 1 ? candidates[0] : null, candidates, excluded,
    reasons: !ready ? ['Static readiness must pass before a role can be recommended.'] : candidates.length === 0
      ? ['No configured primary role satisfies the request; configure a compatible role or revise the request.']
      : candidates.length > 1 ? ['Multiple user-configured roles qualify; the lead must ask for a choice.'] : ['Exactly one configured primary role qualifies.'],
    readiness: readiness.status, problems: readiness.problems,
    runtime_verified: false, inference_request_made: false,
    unknown: ['Live inference and serving identity', 'Task quality, latency, and cost', 'Active project, UI, CLI, and managed overrides', 'Whether a fresh client session loaded these roles'],
    limitations: [...readiness.warnings, 'Advisory only: no dispatch, fallback selection, model ranking, or root/session/configuration change.',
      'Catalog capabilities are local metadata; absent capabilities do not establish support.'],
  };
});
