// Shared fixtures: a synthetic CODEX_HOME per test, and a CLI runner.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCRIPTS = path.join(ROOT, 'plugins', 'codex-on-crack', 'skills', 'crack', 'scripts');
export const LIB = path.join(SCRIPTS, 'lib');

export const ROOT_MODEL = 'gpt-6-astra';
export const FLASH = 'deepseek/deepseek-v4.1-flash';
export const OPUS = 'anthropic-api/claude-opus-4.8';
export const V1_ONLY = 'kimi-api/kimi-k3';
export const DUPLICATED = 'dup/model-x';

export function catalogEntry(slug, extra = {}) {
  return {
    slug,
    display_name: slug,
    multi_agent_version: 'v2',
    default_reasoning_level: 'high',
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
    context_window: 1048576,
    input_modalities: ['text'],
    ...extra,
  };
}

export const DEFAULT_CONFIG = [
  '# Preserve my comments.',
  `model = "${ROOT_MODEL}"`,
  'openai_base_url = "http://127.0.0.1:4202/v1"',
  'model_catalog_json = "catalog.json"',
  '',
  '[model_providers.codex-router]',
  'base_url = "http://127.0.0.1:4202/v1"',
  '',
  '[model_providers.unused]',
  'experimental_bearer_token = "TEST_SECRET_KEY"',
  '',
].join('\n');

export function defaultCatalog() {
  return {
    models: [
      catalogEntry(ROOT_MODEL, {
        input_modalities: ['text', 'image'],
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }],
        context_window: 272000,
      }),
      catalogEntry(FLASH, { input_modalities: ['text', 'image'] }),
      catalogEntry(OPUS, {
        supported_reasoning_levels: [{ effort: 'high' }, { effort: 'max' }],
        context_window: 200000,
      }),
      catalogEntry(V1_ONLY, { multi_agent_version: 'v1' }),
      catalogEntry(DUPLICATED),
      catalogEntry(DUPLICATED),
    ],
  };
}

export const ROLES_TOML = `schema_version = 1

[roles.builder]
model = "${FLASH}"
fallback = "${OPUS}"
writes = true
brief = "Implements one scoped task end to end, including its tests."

[roles.reviewer]
model = "${OPUS}"
writes = false
brief = "Reviews a finished task: spec compliance first, then quality."
`;

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true })
    .map((name) => path.join(dir, name))
    .filter((file) => fs.statSync(file).isFile())
    .sort();
}

export function makeHome(t, { config = DEFAULT_CONFIG, catalog = defaultCatalog(), routerAgents = true } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crack-home-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(path.join(codexHome, 'agents'), { recursive: true });
  const write = (rel, text) => {
    const file = path.join(codexHome, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  if (config !== null) write('config.toml', config);
  if (catalog !== null) write('catalog.json', JSON.stringify(catalog));
  if (routerAgents) {
    write('agents/router-model-anthropic-api-claude-opus-4-8.toml',
      `# Managed by Codex Router.\nname = "router_opus"\nmodel_provider = "codex-router"\nmodel = "${OPUS}"\n`);
  }
  return {
    home,
    codexHome,
    write,
    read: (rel) => fs.readFileSync(path.join(codexHome, rel), 'utf8'),
    exists: (rel) => fs.existsSync(path.join(codexHome, rel)),
    // Every file under CODEX_HOME with its content, for "nothing changed" checks.
    snapshot: () => Object.fromEntries(listFiles(codexHome).map((f) => [path.relative(codexHome, f), fs.readFileSync(f, 'utf8')])),
    args: ['--home', home, '--codex-home', codexHome],
  };
}

export function cli(script, args = []) {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
}
