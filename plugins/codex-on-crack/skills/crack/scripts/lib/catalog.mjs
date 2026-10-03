// Facts about the model catalog Codex actually uses. Never makes a request.
import fs from 'node:fs';
import path from 'node:path';
import { CrackError, readIfExists, readInput, sha256 } from './io.mjs';
import { resolvePath } from './config.mjs';
import { parseToml } from './toml.mjs';

const MAX_CATALOG_BYTES = 20_000_000;
const MAX_AGENT_FILE_BYTES = 256_000;
const EFFORT = /^[a-z_]+$/;

export const REASONS = {
  duplicate: 'Listed more than once in the catalog, so Codex cannot tell which entry applies.',
  not_subagent_capable: 'The catalog does not mark it multi_agent_version "v2", which Codex requires for native subagents.',
};

export function modelEntries(payload) {
  if (Array.isArray(payload)) {
    return payload.filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item));
  }
  if (payload !== null && typeof payload === 'object') {
    for (const key of ['models', 'data']) {
      if (Array.isArray(payload[key])) return modelEntries(payload[key]);
    }
  }
  throw new CrackError('catalog_unrecognized', 'Unrecognized model catalog structure.', 'Inspect the catalog file locally.');
}

export function modelId(entry) {
  if (typeof entry.slug === 'string' && entry.slug) return entry.slug;
  if (typeof entry.id === 'string' && entry.id) return entry.id;
  return null;
}

// codex-router points model_catalog_json at its merged catalog. Without it,
// Codex uses its own cached list, so a native-only setup works too.
export function effectiveCatalog({ config, home, codexHome, catalog }) {
  const configured = config.model_catalog_json;
  if (configured !== undefined && (typeof configured !== 'string' || !configured)) throw new CrackError('catalog_invalid', 'Invalid model_catalog_json.', 'Inspect config locally.');
  const source = configured ? 'model_catalog_json' : catalog ? 'export' : 'models_cache';
  const file = source === 'model_catalog_json'
    ? resolvePath(configured, { home, codexHome })
    : catalog ? path.resolve(catalog) : path.join(codexHome, 'models_cache.json');
  if (configured && catalog && path.resolve(file) !== path.resolve(catalog)) throw new CrackError('catalog_conflict', 'An exported catalog cannot override model_catalog_json.', 'Use the configured catalog.');
  const data = readInput(file);
  if (data === null) {
    throw new CrackError('catalog_missing', `The model catalog Codex uses was not found (${source}).`,
      source === 'models_cache'
        ? 'Open Codex once so it caches its model list, then retry.'
        : 'Repair model_catalog_json with the tool that manages it (for example codex-router).');
  }
  if (data.length > MAX_CATALOG_BYTES) {
    throw new CrackError('catalog_too_large', 'The model catalog is unexpectedly large.', 'Inspect it manually.');
  }
  let payload;
  try {
    payload = JSON.parse(data.toString('utf8'));
  } catch (error) {
    throw new CrackError('catalog_unreadable', `Cannot read the model catalog (${error.name}).`, 'Inspect it locally.');
  }
  return { source, file, hash: sha256(data), entries: modelEntries(payload) };
}

export function describeModels(entries) {
  const byId = new Map();
  for (const entry of entries) {
    const id = modelId(entry);
    if (id !== null) byId.set(id, [...(byId.get(id) ?? []), entry]);
  }
  return [...byId].map(([id, found]) => {
    const entry = found[0];
    const levels = Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [];
    const efforts = levels
      .map((level) => (typeof level === 'string' ? level : level?.effort))
      .filter((effort) => typeof effort === 'string' && EFFORT.test(effort));
    const declared = entry.default_reasoning_level;
    const defaultEffort = typeof declared === 'string' && EFFORT.test(declared)
      && (efforts.length === 0 || efforts.includes(declared)) ? declared : null;
    let reason = null;
    if (found.length > 1) reason = 'duplicate';
    else if (entry.multi_agent_version !== 'v2') reason = 'not_subagent_capable';
    return {
      model: id,
      declaredProvider: entry.model_provider ?? entry.provider ?? null,
      displayName: typeof entry.display_name === 'string' ? entry.display_name : id,
      eligible: reason === null,
      reason,
      why: reason === null ? null : REASONS[reason],
      vision: Array.isArray(entry.input_modalities) && entry.input_modalities.includes('image'),
      contextWindow: Number.isSafeInteger(entry.context_window) && entry.context_window > 0 ? entry.context_window : null,
      efforts,
      defaultEffort,
    };
  });
}

// codex-router writes one agent file per routed model, recording how it reaches
// that model. Mirror its provider so a role reaches the model the same way.
export function routerProvider(codexHome, model) {
  const dir = path.join(codexHome, 'agents');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const providers = new Set();
  for (const name of names.sort()) {
    if (!name.startsWith('router-model-') || !name.endsWith('.toml')) continue;
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_AGENT_FILE_BYTES) continue;
    let doc;
    try {
      doc = parseToml(fs.readFileSync(file, 'utf8'), name);
    } catch {
      continue;
    }
    if (doc.model === model && typeof doc.model_provider === 'string') providers.add(doc.model_provider);
  }
  if (providers.size > 1) {
    throw new CrackError('ambiguous_provider', `codex-router agent files disagree on the provider for ${model}.`,
      'Refresh the router catalog so it rewrites its agent files, then retry.');
  }
  return providers.size === 1 ? [...providers][0] : null;
}
