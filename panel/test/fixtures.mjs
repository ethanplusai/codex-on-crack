// Test fixtures: a temporary workspace with generated images, a mocked
// official CLI, and panel configurations. Nothing contacts a model.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Canvas } from '../src/png.mjs';
import { validatePanelConfig } from '../src/config.mjs';

// The development package (src, tests, pinned dependencies) and the runtime-only plugin folder.
export const DEV_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_ROOT = path.resolve(DEV_ROOT, '../plugins/codex-on-crack-panel');
export const REPO_ROOT = path.resolve(DEV_ROOT, '..');
export const LEAD_MODEL = 'claude-opus-5-5';

export function hasModule(name) {
  try {
    return fs.existsSync(path.join(DEV_ROOT, 'node_modules', ...name.split('/'), 'package.json'));
  } catch {
    return false;
  }
}

export function png(color = [120, 90, 210], size = 24) {
  return new Canvas(size, size, [255, 255, 255]).rect(4, 4, size - 8, size - 8, color).png();
}

// A mocked `claude` CLI. Scenarios: ok (completes) and hang (runs until stopped).
export const FAKE_CLI = `#!/usr/bin/env node
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
const scenario = process.env.FAKE_SCENARIO || 'ok';
const toolsArg = args[args.indexOf('--tools') + 1];
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  if (process.env.FAKE_PROMPT_LOG) process.getBuiltinModule('node:fs').appendFileSync(process.env.FAKE_PROMPT_LOG, JSON.stringify({ args, prompt }) + '\\n');
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: 'sess-panel', model, tools: toolsArg.split(','), permissionMode: 'default', apiKeySource: 'none', claude_code_version: '9.9.9', uuid: 'u-init' });
  if (scenario === 'hang') { setInterval(() => {}, 1000); return; }
  out({ type: 'assistant', uuid: 'u-a1', timestamp: new Date().toISOString(), message: { id: 'msg_1', model, content: [{ type: 'text', text: 'PRIVATE_TRANSCRIPT_BODY' }], usage: { input_tokens: 3, output_tokens: 2 } } });
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, duration_api_ms: 900, num_turns: 1, session_id: 'sess-panel', total_cost_usd: 0.12, usage: { input_tokens: 3, output_tokens: 40 }, modelUsage: { [model]: { inputTokens: 3, outputTokens: 40, cacheReadInputTokens: 100, cacheCreationInputTokens: 50, costUSD: 0.12 } }, permission_denials: [] });
  process.exit(0);
});
`;

export async function workspace(t) {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'crack-panel-test-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'work');
  const outside = path.join(base, 'outside');
  const state = path.join(base, 'state');
  for (const dir of [root, outside, path.join(root, 'evidence'), path.join(root, 'requests')]) await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(root, 'evidence', 'reference.png'), png([110, 80, 200]));
  await fsp.writeFile(path.join(root, 'evidence', 'actual-1.png'), png([200, 80, 80]));
  await fsp.writeFile(path.join(root, 'evidence', 'actual-2.png'), png([110, 80, 200]));
  await fsp.writeFile(path.join(outside, 'secret.png'), png([0, 0, 0]));
  const claudeBin = path.join(base, 'fake-claude');
  await fsp.writeFile(claudeBin, FAKE_CLI, { mode: 0o755 });
  await fsp.writeFile(path.join(root, 'requests', 'request.json'), `${JSON.stringify(request(root), null, 2)}\n`);
  await fsp.writeFile(path.join(root, 'requests', 'prompt.txt'), 'Implement the approved design.\n');
  await fsp.writeFile(path.join(root, 'requests', 'corrections.txt'), 'Apply the corrections.\n');
  return { base, root, outside, state, claudeBin };
}

export function request(root) {
  return {
    schemaVersion: 1, requestId: 'req-panel', runId: 'run-panel', phase: 'implementation', kind: 'host_validation',
    agentId: 'panel-lead', parentAgentId: null, objective: 'Implement the approved dashboard layout.', workspace: root,
    acceptanceChecks: ['Layout matches'], checks: ['Layout matches'], budget: { authorized: true, usd: 5 },
    lead: { id: 'panel-lead', model: LEAD_MODEL, route: 'subscription' },
  };
}

export function configDoc(ws, overrides = {}) {
  return {
    schemaVersion: 1,
    stateDir: ws.state,
    workspaces: [{ id: 'work', root: ws.root, label: 'Test workspace' }],
    runs: [],
    routes: { host: { label: 'Codex host', model: 'gpt-6-astra', route: 'host' }, worker: { label: 'Builder', model: 'deepseek/deepseek-v4.1-flash', route: 'router' } },
    reviews: [{
      id: 'design', title: 'Dashboard layout', gate: 'early-design',
      reference: path.join(ws.root, 'evidence', 'reference.png'),
      actual: path.join(ws.root, 'evidence', 'actual-1.png'),
      checks: ['Cards share one row'],
    }],
    launch: {
      enabled: true,
      claudeBin: ws.claudeBin,
      profiles: [{
        id: 'impl', label: 'Implementation', workspace: 'work',
        request: path.join(ws.root, 'requests', 'request.json'),
        prompt: path.join(ws.root, 'requests', 'prompt.txt'),
        resumePrompt: path.join(ws.root, 'requests', 'corrections.txt'),
        runsDir: path.join(ws.root, 'runs'), mode: 'solo', requiresApproval: 'design', feedbackFrom: 'design',
        deadlineSeconds: 60,
      }],
    },
    ...overrides,
  };
}

export function config(ws, overrides = {}) {
  const result = validatePanelConfig(configDoc(ws, overrides));
  if (!result.ok) throw new Error(result.problems.join('; '));
  return result.config;
}

export async function waitFor(predicate, timeoutMs = 10_000, stepMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
}
