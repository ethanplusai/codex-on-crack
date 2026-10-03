#!/usr/bin/env node
// Lint a plan (schema 2) and compute its waves. Runs no commands; approves nothing.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CrackError, ok, readInput, run } from './lib/io.mjs';
import { locations } from './lib/config.mjs';
import { managedPaths } from './lib/changes.mjs';
import { parseCrackToml } from './lib/roles.mjs';
import { rolesForPlan, validatePlan } from './lib/plan.mjs';

const OPTIONS = {
  'repo-root': { type: 'string' },
  'crack-toml': { type: 'string' },
  home: { type: 'string' },
  'codex-home': { type: 'string' },
};
const USAGE = 'Usage: validate-plan.mjs <plan.json> [--repo-root dir] [--crack-toml path] [--home dir] [--codex-home dir]';

run((argv) => {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new CrackError('usage', error.message, USAGE);
  }
  const { positionals, values } = parsed;
  if (positionals.length !== 1) throw new CrackError('usage', 'Pass exactly one plan.json.', USAGE);
  const planPath = path.resolve(positionals[0]);
  const planData = readInput(planPath);
  if (planData === null) throw new CrackError('plan_missing', `No plan at ${planPath}.`, 'Pass the path to plan.json.');
  let plan;
  try {
    plan = JSON.parse(planData.toString('utf8'));
  } catch {
    throw new CrackError('plan_invalid', 'plan.json is not valid JSON.', 'Fix the JSON syntax, then validate again.');
  }
  const explicit = values['crack-toml'] !== undefined;
  const crackPath = explicit
    ? path.resolve(values['crack-toml'])
    : managedPaths(locations({ home: values.home, codexHome: values['codex-home'] }).codexHome).crackToml;
  const crackData = readInput(crackPath);
  let roles = new Map();
  if (crackData === null) {
    // Direct work needs no roles, so a plan made only of orchestrator tasks is
    // valid with no crack.toml at the default location. An explicit --crack-toml
    // names a file, so a missing one is a real error rather than an empty default.
    if (explicit) {
      throw new CrackError('roles_missing', `No crack.toml at ${crackPath}.`,
        'Pass an existing config, keep the plan orchestrator-only for direct work, or run $codex-on-crack:crack-setup.');
    }
  } else {
    // Fail closed on a malformed or role-less configuration instead of quietly
    // treating it as "no roles configured".
    roles = rolesForPlan(parseCrackToml(crackData.toString('utf8')));
  }
  const root = path.resolve(values['repo-root'] ?? path.dirname(planPath));
  return ok(validatePlan(plan, root, roles));
});
