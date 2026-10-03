#!/usr/bin/env node
// Run report: plan outcomes and escalations, plus real routed usage when logged.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CrackError, ok, readInput, run } from './lib/io.mjs';
import { locations } from './lib/config.mjs';
import { routerUsage, summarizePlan, sessionUsage } from './lib/report.mjs';

const OPTIONS = {
  'root-session': { type: 'string' },
  'session-log': { type: 'string', multiple: true },
  plan: { type: 'string' },
  since: { type: 'string' },
  'router-log': { type: 'string' },
  home: { type: 'string' },
  'codex-home': { type: 'string' },
};
const USAGE = 'Usage: report.mjs --plan <plan.json> [--since <iso time>] [--router-log path] [--home dir] [--codex-home dir]';

run((argv) => {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false, strict: true });
  } catch (error) {
    throw new CrackError('usage', error.message, USAGE);
  }
  const { values } = parsed;
  if (!values.plan) throw new CrackError('usage', '--plan is required.', USAGE);
  const planData = readInput(path.resolve(values.plan));
  if (planData === null) throw new CrackError('plan_missing', `No plan at ${values.plan}.`, 'Pass the path to plan.json.');
  let plan;
  try {
    plan = JSON.parse(planData.toString('utf8'));
  } catch {
    throw new CrackError('plan_invalid', 'plan.json is not valid JSON.', 'Fix the JSON syntax, then retry.');
  }
  const { codexHome } = locations({ home: values.home, codexHome: values['codex-home'] });
  const logPath = values['router-log'] ? path.resolve(values['router-log']) : path.join(codexHome, 'codex-router', 'router.log');
  const log = values['router-log'] ? readInput(logPath) : null;
  const logs = (values['session-log'] ?? []).map((file) => {
    const data = readInput(path.resolve(file));
    if (!data) throw new CrackError('session_missing', 'A supplied session export is missing.', 'Check the input path.');
    return data.toString('utf8');
  });
  if (values['root-session'] && !logs.length) throw new CrackError('usage', '--root-session requires --session-log.', USAGE);
  const since = values.since ?? null;
  return ok({
    ...summarizePlan(plan),
    usage: logs.length ? sessionUsage(logs, values['root-session']) : null,
    diagnostic_router_usage: log === null ? null : {
      source: 'codex-router log',
      since,
      note: 'Counts every request routed through codex-router in this window, including requests outside this run. Models Codex serves natively are not in this log.',
      by_model: routerUsage(log.toString('utf8'), since),
    },
    note: 'Session totals require complete exports. Router window counts are diagnostic only and must not be used as run savings evidence.',
  });
});
