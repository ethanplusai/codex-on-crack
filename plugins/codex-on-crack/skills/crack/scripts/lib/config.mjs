// Read Codex configuration. Nothing in codex-on-crack ever writes config.toml.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CrackError, readIfExists, readInput, sha256 } from './io.mjs';
import { parseToml } from './toml.mjs';

// Keys Codex reads as scalar settings directly under [agents]. Every other key
// there is an agent NAME whose value must be a role table, so a scalar under an
// unrecognized name makes Codex reject the whole config ("expected struct
// AgentRoleToml"), which takes down the App and the CLI together.
export const AGENT_SCALAR_SETTINGS = new Set([
  'enabled',
  'default_subagent_model',
  'default_subagent_reasoning_effort',
  'interrupt_message',
  'max_concurrent_threads_per_session',
  'max_threads',
  'max_depth',
  'job_max_runtime_seconds',
]);

export function isTable(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function expandHome(value, home) {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

function realOrResolved(value) {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function locations({ home, codexHome } = {}) {
  const resolvedHome = realOrResolved(expandHome(home ?? os.homedir(), os.homedir()));
  const codex = codexHome ?? process.env.CODEX_HOME ?? path.join(resolvedHome, '.codex');
  return { home: resolvedHome, codexHome: realOrResolved(expandHome(codex, resolvedHome)) };
}

export function resolvePath(value, { home, codexHome }) {
  const expanded = expandHome(value
    .replaceAll('${CODEX_HOME}', codexHome).replaceAll('$CODEX_HOME', codexHome)
    .replaceAll('${HOME}', home).replaceAll('$HOME', home), home);
  return path.isAbsolute(expanded) ? expanded : path.join(codexHome, expanded);
}

export function mergeTables(base, overlay) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    result[key] = isTable(value) && isTable(result[key]) ? mergeTables(result[key], value) : value;
  }
  return result;
}

function readTomlFile(file, label) {
  const data = readInput(file);
  if (data === null) return null;
  return { data, doc: parseToml(data.toString('utf8'), label) };
}

export function readConfig({ codexHome, profile } = {}) {
  const configPath = path.join(codexHome, 'config.toml');
  const base = readTomlFile(configPath, 'config.toml');
  let config = base?.doc ?? {};
  const inputHashes = { [configPath]: sha256(base?.data ?? null) };
  const warnings = [];
  const selected = profile ?? config.profile ?? null;
  if (selected !== null) {
    if (typeof selected !== 'string' || !/^[A-Za-z0-9_-]+$/.test(selected)) {
      throw new CrackError('unsupported_profile', 'Unsupported profile name.', 'Inspect the active profile manually.');
    }
    const standalonePath = path.join(codexHome, `${selected}.config.toml`);
    const standalone = readTomlFile(standalonePath, `${selected}.config.toml`);
    const legacy = isTable(config.profiles) ? config.profiles[selected] : undefined;
    if (standalone && legacy !== undefined) {
      throw new CrackError('ambiguous_profile', 'Both a standalone file and a legacy [profiles] entry define this profile.',
        'Remove one of them first.');
    }
    if (standalone) {
      config = mergeTables(config, standalone.doc);
      inputHashes[standalonePath] = sha256(standalone.data);
    } else if (isTable(legacy)) {
      config = mergeTables(config, legacy);
      warnings.push('A legacy inline profile was inspected; confirm your client still applies it.');
    } else {
      throw new CrackError('profile_missing', 'The selected profile is not available as a readable configuration file.',
        'Pass an existing --profile, or none.');
    }
  }
  return { config, inputHashes, profile: selected, warnings };
}

export function checkAgentsShape(config) {
  const warnings = [];
  const agents = config.agents ?? {};
  if (!isTable(agents)) {
    throw new CrackError('agents_not_table', 'The existing [agents] setting is not a TOML table.', 'Repair config.toml, then retry.');
  }
  // Checking shape rather than a list of known top-level names catches any
  // absorbed key, not just the handful an installer happens to anticipate.
  const misplaced = Object.entries(agents)
    .filter(([key, value]) => !AGENT_SCALAR_SETTINGS.has(key) && !isTable(value))
    .map(([key]) => key)
    .sort();
  if (misplaced.length) {
    throw new CrackError('agents_absorbed_keys',
      `Setting(s) that do not belong under [agents] were found there: ${misplaced.join(', ')}. `
      + 'In TOML, a table header remains active until the next table header, so a top-level key written after '
      + '[agents] is absorbed into it; Codex then reads that key as an agent name and refuses to load the whole config.',
      'Move those keys above the first table header, or under the agent role they belong to. If your Codex build '
      + 'documents one of them as a genuine [agents] setting, it is newer than this check; verify with `codex doctor` '
      + 'rather than editing around this error.');
  }
  if (agents.enabled === false) {
    throw new CrackError('subagents_disabled', 'Subagents are disabled in this config ([agents] enabled = false).',
      'codex-on-crack will not enable them silently. Change it yourself if you want delegation.');
  }
  if ('default_subagent_model' in agents) {
    warnings.push('The global default_subagent_model is neither used nor changed; each codex-on-crack role pins its own model.');
  }
  if (isTable(config.features) && config.features.multi_agent === false) {
    warnings.push('A legacy features.multi_agent = false flag exists; check whether your client honors it.');
  }
  return warnings;
}

// Reuse the selected profile/export; never infer another backend during updates.
export function installationContext(codexHome, profile, catalog) {
  const file = path.join(codexHome, 'crack', 'crack.toml');
  const data = readIfExists(file);
  const saved = data === null ? {} : parseToml(data.toString('utf8'), 'crack.toml').installation ?? {};
  if (saved.profile !== undefined && typeof saved.profile !== 'string') throw new CrackError('invalid_installation', 'Invalid recorded profile.', 'Review crack.toml.');
  if (saved.catalog !== undefined && typeof saved.catalog !== 'string') throw new CrackError('invalid_installation', 'Invalid recorded catalog.', 'Review crack.toml.');
  return { profile: profile ?? (saved.profile || undefined), catalog: catalog ?? saved.catalog };
}
