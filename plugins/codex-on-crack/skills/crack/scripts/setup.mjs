#!/usr/bin/env node
// $codex-on-crack:crack-setup: scan the catalog, preview role files, apply with a receipt, undo.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CrackError, ok, readIfExists, readInput, realInput, run } from './lib/io.mjs';
import { checkAgentsShape, locations, readConfig, installationContext } from './lib/config.mjs';
import { describeModels, effectiveCatalog } from './lib/catalog.mjs';
import {
  DEFAULT_ROLES, agentFiles, parseCrackToml, renderCrackToml, reviewWarnings, validateRoles,
} from './lib/roles.mjs';
import {
  applyChanges, policyMigration, managedPaths, managedPolicy, planChanges, policyBlock, undoReceipt,
} from './lib/changes.mjs';
import { checkRouting } from './lib/routing.mjs';
import { parseToml } from './lib/toml.mjs';

const OPTIONS = {
  home: { type: 'string' },
  'codex-home': { type: 'string' },
  profile: { type: 'string' },
  roles: { type: 'string' },
  'model-catalog': { type: 'string' },
  'migrate-legacy': { type: 'boolean', default: false },
  policy: { type: 'boolean', default: false },
  receipt: { type: 'string' },
  apply: { type: 'boolean', default: false },
};
const USAGE = 'Usage: setup.mjs <scan|plan|apply|undo> [--roles draft.toml] [--policy] [--receipt path] [--apply] [--home dir] [--codex-home dir] [--profile name]';
const AGENT_FILE = /^crack_[a-z0-9_]+\.toml$/;

function inspect(values) {
  const where = locations({ home: values.home, codexHome: values['codex-home'] });
  const { config, inputHashes, profile, warnings } = readConfig({ ...where, ...installationContext(where.codexHome, values.profile, values['model-catalog']) });
  warnings.push(...checkAgentsShape(config));
  const catalog = effectiveCatalog({ config, ...where, ...installationContext(where.codexHome, values.profile, values['model-catalog']) });
  inputHashes[catalog.file] = catalog.hash;
  return { ...where, config, inputHashes, profile, warnings, catalog, models: describeModels(catalog.entries) };
}

function legacyRole(codexHome) {
  const file = path.join(codexHome, 'agents', 'astra_flash_builder.toml');
  const data = readIfExists(file);
  if (data === null) return null;
  try {
    const doc = parseToml(data.toString('utf8'), 'astra_flash_builder.toml');
    return { file, model: typeof doc.model === 'string' ? doc.model : null };
  } catch {
    return { file, model: null };
  }
}

function scan(values) {
  const state = inspect(values);
  const { crackToml } = managedPaths(state.codexHome);
  return ok({
    root_model: state.config.model ?? null,
    profile: state.profile,
    catalog: { source: state.catalog.source },
    eligible: state.models.filter((m) => m.eligible)
      .map(({ model, displayName, vision, contextWindow, efforts, defaultEffort }) => ({ model, displayName, vision, contextWindow, efforts, defaultEffort })),
    ineligible: state.models.filter((m) => !m.eligible)
      .map(({ model, displayName, reason, why }) => ({ model, displayName, reason, why })),
    default_roles: DEFAULT_ROLES,
    existing: {
      crack_toml: fs.existsSync(crackToml) ? crackToml : null,
      astra_flash_builder: legacyRole(state.codexHome),
    },
    warnings: state.warnings,
  });
}

function desired(state, values) {
  const paths = managedPaths(state.codexHome);
  const source = values.roles ? path.resolve(values.roles) : paths.crackToml;
  const data = values.roles ? readInput(source) : readIfExists(source);
  if (data === null) {
    throw new CrackError('roles_missing', values.roles ? `No roles draft at ${source}.` : 'No crack.toml yet.',
      'Pass --roles <draft.toml> to configure delegation, as $codex-on-crack:crack-setup does. '
      + 'Direct work and the workflow skills need no roles at all.');
  }
  const { roles, warnings } = validateRoles(parseCrackToml(data.toString('utf8'), path.basename(source)), state.models);
  warnings.push(...checkRouting({ ...state, roles }));
  const files = agentFiles({ codexHome: state.codexHome, roles });
  const requested = new Map([[paths.crackToml, renderCrackToml(roles, { profile: state.profile, catalog: state.catalog.file })]]);
  for (const { file, text } of files) requested.set(file, text);
  // Retire agent files for roles or rungs that no longer exist (ours and unedited only).
  const names = fs.existsSync(paths.agentsDir) ? fs.readdirSync(paths.agentsDir).sort() : [];
  for (const name of names) {
    const file = path.join(paths.agentsDir, name);
    if (AGENT_FILE.test(name) && !requested.has(file)) requested.set(file, null);
  }
  policyMigration(state.codexHome, requested, { policy: values.policy, migrateLegacy: values['migrate-legacy'] });
  return {
    requested,
    roles: roles.map(({ name, writes, rungs }) => ({
      name,
      writes,
      rungs: rungs.map(({ kind, agent, model, effort }) => ({ kind, agent, model, effort })),
    })),
    providers: files.map(({ rung, provider }) => ({
      agent: rung.agent,
      model: rung.model,
      provider,
      provider_source: provider ? 'router-agent' : 'inherited',
    })),
    warnings: [...state.warnings, ...warnings, ...reviewWarnings(roles)],
  };
}

const listChanges = (changes) => changes.map(({ action, path: file }) => ({ action, path: file }));

function preview(values) {
  const state = inspect(values);
  const plan = desired(state, values);
  const changes = planChanges(state.codexHome, plan.requested);
  return ok({
    changes: listChanges(changes),
    roles: plan.roles,
    providers: plan.providers,
    warnings: plan.warnings,
    note: 'Preview only. Nothing was written, and config.toml is never written.',
  });
}

function apply(values) {
  const state = inspect(values);
  const plan = desired(state, values);
  const changes = planChanges(state.codexHome, plan.requested);
  const receipt = applyChanges(state.codexHome, changes, state.inputHashes);
  return ok({
    receipt,
    changes: listChanges(changes),
    roles: plan.roles,
    providers: plan.providers,
    warnings: plan.warnings,
    next: receipt
      ? 'Fully quit and reopen Codex so it loads the new agent files. The first real task on each new model is its runtime check.'
      : 'Already up to date; nothing changed.',
  });
}

function undo(values) {
  if (!values.receipt) throw new CrackError('usage', '--receipt is required for undo.', USAGE);
  const { codexHome } = locations({ home: values.home, codexHome: values['codex-home'] });
  const result = undoReceipt(codexHome, realInput(values.receipt), { apply: values.apply });
  return ok({ ...result, note: values.apply ? 'Restored. Fully quit and reopen Codex.' : 'Preview only. Add --apply to restore.' });
}

const COMMANDS = { scan, plan: preview, apply, undo };

run((argv) => {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new CrackError('usage', error.message, USAGE);
  }
  const command = COMMANDS[parsed.positionals[0]];
  if (!command || parsed.positionals.length !== 1) throw new CrackError('usage', 'Unknown or missing command.', USAGE);
  return command(parsed.values);
});
