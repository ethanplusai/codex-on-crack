// Clean-copy integration: copy the package somewhere else, install it into an
// isolated Codex home, run and resume the external-lead adapter against a mock
// CLI, replay the two runs, then uninstall and check nothing was left behind.
// No model, no network, no socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './helpers.mjs';

const MOCK_CLI = `#!/usr/bin/env node
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1];
const tools = (args[args.indexOf('--tools') + 1] || '').split(',');
const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : 'sess-new';
const mult = Number(process.env.MOCK_MULT || '1');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: resume, model, tools, permissionMode: 'default', apiKeySource: 'none', claude_code_version: 'test', uuid: 'u-init' });
  out({ type: 'assistant', uuid: 'u-a1', timestamp: '2026-09-29T12:00:01Z', message: { id: 'msg_1', model, content: [{ type: 'text', text: 'PRIVATE-TRANSCRIPT' }, { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls -la' } }], usage: { input_tokens: 2 * mult, output_tokens: 3 * mult } } });
  out({ type: 'user', uuid: 'u-u1', timestamp: '2026-09-29T12:00:02Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: false, content: 'PRIVATE-TOOL-OUTPUT' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, num_turns: 1, session_id: resume, total_cost_usd: 0.25 * mult, usage: { input_tokens: 2 * mult, output_tokens: 3 * mult }, modelUsage: { [model]: { inputTokens: 2 * mult, outputTokens: 3 * mult, cacheReadInputTokens: 5 * mult, cacheCreationInputTokens: 1 * mult, costUSD: 0.25 * mult } }, permission_denials: [] });
});
`;

function run(script, args, env = {}) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120_000 });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
}

test('a clean copy installs, runs a mock lead, replays the chain, and uninstalls', async (t) => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'crack-integration-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // 1. Clean copy of the package, without build output or VCS data.
  const pkg = path.join(root, 'package');
  fs.cpSync(ROOT, pkg, {
    recursive: true,
    filter: (src) => !/(^|\/)(\.git|node_modules|dist|\.local)(\/|$)/.test(src),
  });
  assert.ok(fs.existsSync(path.join(pkg, 'MANIFEST.sha256')));
  assert.ok(!fs.existsSync(path.join(pkg, 'dist')));

  // 2. Install into an isolated home using the copy's own installer.
  const home = path.join(root, 'codex-home');
  const installed = run(path.join(pkg, 'scripts', 'product.mjs'), ['install', '--home', home, '--via', 'source']);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.equal(installed.json.mode, 'source');
  assert.equal(installed.json.hostLoaded, false);

  // 3. Doctor reports the package and the install honestly.
  const doctor = run(path.join(pkg, 'scripts', 'product.mjs'), ['doctor', '--home', home]);
  assert.equal(doctor.json.package.manifestValid, true, 'the clean copy matches its own manifest');
  assert.equal(doctor.json.install.installed, true);
  assert.match(doctor.json.install.evidence, /static source install/);
  assert.equal(doctor.json.runtime_verified, false);

  // 4. Run and resume the external lead adapter from the copy, against a mock CLI.
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  const claudeBin = path.join(root, 'mock-claude');
  fs.writeFileSync(claudeBin, MOCK_CLI, { mode: 0o755 });
  const prompt = path.join(root, 'prompt.txt');
  fs.writeFileSync(prompt, 'Do the bounded work.\n');
  const requestFile = path.join(root, 'request.json');
  fs.writeFileSync(requestFile, JSON.stringify({
    schemaVersion: 1, requestId: 'req-1', runId: 'run-1', phase: 'phase-1', kind: 'worker_assignment',
    agentId: 'lead-1', parentAgentId: null, objective: 'Clean-copy integration run.', workspace: work,
    acceptanceChecks: ['integration completes'], role: 'builder', budget: { authorized: true, usd: 30 },
    lead: { id: 'lead-1', model: 'claude-opus-5-5', route: 'subscription' },
    assignment: { role: 'builder', brief: 'Mock run.' },
  }));
  const lead = path.join(pkg, 'plugins', 'codex-on-crack', 'skills', 'crack', 'scripts', 'lead.mjs');
  const first = run(lead, ['run', '--request', requestFile, '--prompt', prompt, '--out', path.join(root, 'run-1'), '--claude-bin', claudeBin], { MOCK_MULT: '1' });
  assert.equal(first.status, 0, first.stdout);
  assert.equal(first.json.ok, true, first.json.errors.join('; '));
  assert.equal(first.json.toolProfile, 'files');

  const second = run(lead, [
    'resume', '--run', path.join(root, 'run-1'), '--prompt', prompt, '--out', path.join(root, 'run-2'),
    '--claude-bin', claudeBin, '--tool-profile', 'terminal', '--authorize-profile-transition', '--reason', 'integration',
  ], { MOCK_MULT: '3' });
  assert.equal(second.status, 0, second.stdout);
  assert.equal(second.json.ok, true, second.json.errors.join('; '));
  assert.equal(second.json.toolProfile, 'terminal');
  assert.equal(second.json.resumedFrom, first.json.sessionId, 'the same session is resumed');
  assert.deepEqual(second.json.resumeDelta.models['claude-opus-5-5'], {
    complete: true, inputTokens: 4, outputTokens: 6, cacheReadInputTokens: 10, cacheCreationInputTokens: 2,
  });

  // 5. Replay both runs from the copy.
  const replayOut = path.join(root, 'replay');
  const bridged = run(path.join(pkg, 'plugins', 'codex-on-crack', 'skills', 'crack', 'viewer', 'bridge.mjs'),
    ['--run', path.join(root, 'run-1'), '--run', path.join(root, 'run-2'), '--out', replayOut]);
  assert.equal(bridged.status, 0, bridged.stdout);
  assert.equal(bridged.json.ok, true);
  assert.deepEqual(bridged.json.models, ['claude-opus-5-5']);
  const usage = JSON.parse(fs.readFileSync(path.join(replayOut, 'usage-summary.json'), 'utf8'));
  assert.equal(usage.runs.length, 2);
  assert.equal(usage.runs[0].toolProfile, 'files');
  assert.equal(usage.runs[1].toolProfile, 'terminal');
  assert.equal(usage.runs[1].usage.delta.models['claude-opus-5-5'].inputTokens, 4);
  const replay = fs.readFileSync(path.join(replayOut, 'replay.jsonl'), 'utf8');
  assert.ok(!replay.includes('PRIVATE-TRANSCRIPT'), 'transcripts never reach the replay');
  assert.ok(!replay.includes('PRIVATE-TOOL-OUTPUT'), 'tool output never reaches the replay');
  assert.ok(!replay.includes(work), 'workspace paths never reach the replay');
  assert.ok(replay.includes('usage.recorded'));

  // 6. Uninstall leaves nothing of ours behind.
  const uninstall = run(path.join(pkg, 'scripts', 'product.mjs'), ['uninstall', '--home', home]);
  assert.equal(uninstall.status, 0, uninstall.stdout);
  assert.equal(uninstall.json.status, 'uninstalled');
  assert.equal(fs.existsSync(path.join(home, 'codex-on-crack-receipt.json')), false);
  assert.equal(fs.existsSync(path.join(home, 'plugins', 'codex-on-crack')), false);
  assert.equal(fs.existsSync(path.join(home, '.agents', 'plugins', 'marketplace.json')), false);
});
