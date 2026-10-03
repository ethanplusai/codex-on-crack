#!/usr/bin/env node
// Static readiness for codex-on-crack. Reads only; never makes a model call.
import fs from 'node:fs';
import path from 'node:path';
import { CrackError, readIfExists, sha256 } from './io.mjs';
import { checkAgentsShape, locations, readConfig, installationContext } from './config.mjs';
import { describeModels, effectiveCatalog } from './catalog.mjs';
import { agentFiles, parseCrackToml, reviewWarnings, validateRoles } from './roles.mjs';
import { isManagedPath, ledger, managedPaths, policyMigration } from './changes.mjs';

import { checkRouting } from './routing.mjs';

export function doctor(values) {
  const where = locations({ home: values.home, codexHome: values['codex-home'] });
  const { config, profile, warnings } = readConfig({ ...where, ...installationContext(where.codexHome, values.profile) });
  const paths = managedPaths(where.codexHome);
  const crackText = readIfExists(paths.crackToml)?.toString('utf8');
  const delegationConfigured = crackText !== undefined;
  const problems = [];
  const collect = (entry, blocking) => {
    if (blocking) problems.push(entry);
    else warnings.push(entry.hint ? `${entry.message} ${entry.hint}` : entry.message);
  };
  const attempt = (step, { blocking = true } = {}) => {
    try {
      return step();
    } catch (error) {
      if (!(error instanceof CrackError)) throw error;
      collect({ code: error.code, message: error.message, hint: error.hint }, blocking);
      return null;
    }
  };
  // Enabled subagents are a delegation prerequisite. Every other shape error
  // breaks Codex's config for direct work too, so it stays blocking either way.
  let shape = null;
  try {
    shape = checkAgentsShape(config);
  } catch (error) {
    if (!(error instanceof CrackError)) throw error;
    collect({ code: error.code, message: error.message, hint: error.hint },
      delegationConfigured || error.code !== 'subagents_disabled');
  }
  if (shape) warnings.push(...shape);
  // A model catalog is only needed to validate roles. Workflow-only use reads it
  // best-effort and never fails on it.
  const readCatalog = () => effectiveCatalog({ config, ...where, ...installationContext(where.codexHome, values.profile) });
  const catalog = delegationConfigured
    ? attempt(readCatalog)
    : (() => { try { return readCatalog(); } catch { return null; } })();
  if (!delegationConfigured && catalog === null) {
    warnings.push('No readable model catalog was found; that only matters when you configure a builder with $codex-on-crack:crack-setup.');
  }
  const models = catalog ? describeModels(catalog.entries) : [];
  const byModel = new Map(models.map((model) => [model.model, model]));
  let roles = [];
  if (!delegationConfigured) {
    // Workflow-only is a complete, supported state: the skills work without any
    // roles. Only a leftover generated file, which no crack.toml explains, is a
    // real inconsistency.
    const orphans = fs.existsSync(paths.agentsDir)
      ? fs.readdirSync(paths.agentsDir)
        .filter((name) => isManagedPath(where.codexHome, path.join(paths.agentsDir, name)))
        .sort()
      : [];
    if (orphans.length) {
      problems.push({
        code: 'orphaned_agent_files',
        message: `Role file(s) exist without crack.toml: ${orphans.join(', ')}.`,
        hint: 'Run $codex-on-crack:crack-setup to regenerate them, or remove them if you no longer want delegation.',
      });
    }
  } else if (catalog) {
    const validated = attempt(() => validateRoles(parseCrackToml(crackText), models));
    if (validated) {
      roles = validated.roles;
      warnings.push(...validated.warnings, ...reviewWarnings(roles));
    }
  }
  attempt(() => policyMigration(where.codexHome, new Map()));
  if (roles.length) warnings.push(...(attempt(() => checkRouting({ config, roles, models, codexHome: where.codexHome })) ?? []));
  const expected = attempt(() => ledger(where.codexHome)) ?? new Map();
  const files = attempt(() => agentFiles({ codexHome: where.codexHome, roles })) ?? [];
  const rungs = files.map(({ file, text, role, rung, provider }) => {
    const current = readIfExists(file);
    let state = 'in-sync';
    if (current === null) state = 'missing';
    else if (current.toString('utf8') !== text) state = expected.get(file) === sha256(current) ? 'stale' : 'edited';
    if (state !== 'in-sync') {
      problems.push({
        code: `agent_file_${state}`,
        message: `${path.basename(file)} is ${state}.`,
        hint: state === 'edited'
          ? 'Move your edits into crack.toml, delete the file, then run $codex-on-crack:crack-setup.'
          : 'Run $codex-on-crack:crack-setup to regenerate the agent files.',
      });
    }
    return {
      role: role.name,
      kind: rung.kind,
      agent: rung.agent,
      model: rung.model,
      effort: rung.effort,
      writes: role.writes,
      ...(role.tasks === undefined ? {} : { tasks: role.tasks }),
      vision: byModel.get(rung.model)?.vision ?? false,
      context_window: byModel.get(rung.model)?.contextWindow ?? null,
      provider,
      provider_source: provider ? 'router-agent' : 'inherited',
      file: state,
    };
  });
  if (!config.model) warnings.push('No root model is set in config; the orchestrator is whatever you pick in the model picker.');
  warnings.push('Project, CLI, UI, and managed-policy overrides are not resolved by this static check.');
  return {
    ok: problems.length === 0,
    status: problems.length ? 'not-ready' : delegationConfigured ? 'static-ready' : 'workflow-ready',
    delegation: {
      configured: delegationConfigured,
      ready: delegationConfigured && problems.length === 0,
      note: delegationConfigured
        ? 'Roles are configured. Delegation also needs the client to load the agent files in a fresh session.'
        : 'Workflow-only: no roles are configured. Run $codex-on-crack:crack-setup when you want a delegated builder.',
    },
    runtime_verified: false,
    inference_request_made: false,
    root_model: config.model ?? null,
    profile,
    catalog: catalog ? { source: catalog.source } : null,
    rungs,
    problems,
    warnings,
  };
}
