// Vendored from agent-activity-viewer, adapted for this package:
//  - the child's stderr is surfaced so the failure can be classified;
//  - an environment that forbids binding a localhost socket reports a skip
//    instead of a failure (some sandboxes return EPERM for listen()).
// The package's own viewer entry point is covered by tests/replay.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function start(args = []) {
  const child = spawn(process.execPath, ['src/server.mjs', '--port', '0', ...args], {
    cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const url = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Server startup timeout')); }, 5000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = out.match(/Viewer: (\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited ${code}: ${stderr.trim()}`));
    });
  });
  return { child, url: new URL(url), stderr: () => stderr };
}

function listeningBlocked(message) {
  return /EPERM|EACCES|operation not permitted|listen/i.test(message);
}

test('server protects data and tails explicit lifecycle events', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'viewer-api-'));
  const file = path.join(dir, 'events.jsonl');
  const event = (id, type) => ({ schemaVersion: 1, eventId: id, agentId: 'lead', parentAgentId: null, at: new Date().toISOString(), type, data: {} });
  await fsp.writeFile(file, `${JSON.stringify(event('1', 'agent.started'))}\n`);
  let child;
  try {
    let run;
    try {
      run = await start(['--events', file]);
    } catch (error) {
      if (listeningBlocked(error.message)) {
        t.skip('this environment blocks binding a localhost socket');
        return;
      }
      throw error;
    }
    child = run.child;
    const base = run.url.origin;
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    const headers = { Authorization: `Bearer ${run.url.hash.slice(7)}` };
    assert.equal((await fetch(`${base}/api/state`, { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
    assert.equal((await fetch(`${base}/api/state`, { method: 'POST', headers })).status, 405);
    let state = await (await fetch(`${base}/api/state`, { headers })).json();
    assert.equal(state.mode, 'Live');
    assert.equal(state.events.length, 1);
    await fsp.appendFile(file, `${JSON.stringify(event('2', 'agent.returned'))}\n`);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    state = await (await fetch(`${base}/api/state`, { headers })).json();
    assert.equal(state.events.at(-1).type, 'agent.returned');
    assert.equal(state.sources[0].status, 'Watching');
  } finally {
    child?.kill();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
