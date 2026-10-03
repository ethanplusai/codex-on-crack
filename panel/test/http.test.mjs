// Localhost fallback: loopback token, Host/Origin checks, explicit JSON POSTs,
// bounded bodies, allowlisted fields, safe artifacts, and the local-ui channel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelController } from '../src/controller.mjs';
import { createDemo } from '../src/demo.mjs';
import { gate, startServer } from '../src/http.mjs';
import { config, workspace } from './fixtures.mjs';

const available = () => ({ dependencies: [{ name: 'claude', status: 'available-unverified' }] });

async function serve(t, controller) {
  let started;
  try {
    started = await startServer({ controller, port: 0 });
  } catch (error) {
    if (/EPERM|EACCES/.test(error.code ?? error.message)) {
      t.skip('this environment blocks binding a localhost socket');
      return null;
    }
    throw error;
  }
  t.after(() => new Promise((resolve) => started.server.close(resolve)));
  const base = `http://127.0.0.1:${started.port}`;
  const auth = { Authorization: `Bearer ${started.token}` };
  const post = (route, body, headers = {}) => fetch(`${base}${route}`, {
    method: 'POST',
    headers: { ...auth, Origin: base, 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { ...started, base, auth, post };
}

test('gate: token, loopback host, same origin, and JSON mutations', () => {
  const req = (headers, method = 'GET') => ({ method, headers: { host: '127.0.0.1:9', ...headers } });
  const opts = { token: 'secret-token', port: 9, api: true };
  assert.equal(gate(req({}), opts), 401);
  assert.equal(gate(req({ authorization: 'Bearer wrong-token!' }), opts), 401);
  assert.equal(gate(req({ authorization: 'Bearer secret-token' }), opts), 0);
  assert.equal(gate(req({ authorization: 'Bearer secret-token', host: 'evil.test:9' }), opts), 403);
  assert.equal(gate(req({ authorization: 'Bearer secret-token', host: '0.0.0.0:9' }), opts), 403);
  assert.equal(gate(req({ authorization: 'Bearer secret-token', origin: 'http://evil.test' }), opts), 403);
  assert.equal(gate(req({ authorization: 'Bearer secret-token', 'sec-fetch-site': 'cross-site' }), opts), 403);
  assert.equal(gate(req({ authorization: 'Bearer secret-token' }, 'POST'), opts), 403, 'a mutation must name its origin');
  assert.equal(gate(req({ authorization: 'Bearer secret-token', origin: 'http://127.0.0.1:9', 'content-type': 'text/plain' }, 'POST'), opts), 415);
  assert.equal(gate(req({ authorization: 'Bearer secret-token', origin: 'http://127.0.0.1:9', 'content-type': 'application/json; charset=utf-8' }, 'POST'), opts), 0);
  assert.equal(gate(req({ authorization: 'Bearer secret-token' }, 'DELETE'), opts), 405);
  assert.equal(gate(req({}), { ...opts, api: false }), 0, 'static assets carry no data');
  assert.equal(gate(req({}, 'POST'), { ...opts, api: false }), 405);
});

test('server: unauthenticated and cross-origin calls are refused; decisions record the local-ui channel', async (t) => {
  const ws = await workspace(t);
  const controller = new PanelController({ config: config(ws), doctor: available });
  const s = await serve(t, controller);
  if (!s) return;
  assert.equal((await fetch(`${s.base}/api/state`)).status, 401);
  assert.equal((await fetch(`${s.base}/api/state`, { headers: { ...s.auth, Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await fetch(`${s.base}/api/state`, { method: 'PUT', headers: s.auth })).status, 405);
  assert.equal((await s.post('/api/review/decide', {}, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await s.post('/api/review/decide', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await s.post('/api/review/decide', '[1,2]')).status, 400);
  assert.equal((await s.post('/api/review/decide', 'x'.repeat(20_000))).status, 413);
  const pid = await s.post('/api/cancel', { runId: 'x', pid: 4242 });
  assert.equal(pid.status, 400);
  assert.equal((await pid.json()).error, 'unknown_field');
  const channel = await s.post('/api/review/decide', { reviewId: 'design', decision: 'approve', expectedHash: 'a'.repeat(64), channel: 'mcp-app' });
  assert.equal((await channel.json()).error, 'unknown_field', 'the client cannot choose its own provenance');

  const state = await (await fetch(`${s.base}/api/state`, { headers: s.auth })).json();
  assert.equal(state.ok, true);
  assert.ok(!JSON.stringify(state).includes(ws.root));
  const hash = state.reviews[0].evidenceHash;
  const stale = await s.post('/api/review/decide', { reviewId: 'design', decision: 'approve', expectedHash: 'b'.repeat(64) });
  assert.equal(stale.status, 409);
  const decided = await s.post('/api/review/decide', { reviewId: 'design', decision: 'approve', feedback: 'Looks right', expectedHash: hash });
  assert.equal(decided.status, 200);
  const after = await (await fetch(`${s.base}/api/state`, { headers: s.auth })).json();
  assert.equal(after.reviews[0].state, 'approved');
  assert.equal(after.reviews[0].decisions[0].channel, 'local-ui');

  const image = await fetch(`${s.base}/api/artifact?review=design&side=actual`, { headers: s.auth });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${s.base}/api/artifact?review=design&side=actual`)).status, 401);
  const shown = after.reviews[0].actual.sha256;
  assert.equal((await fetch(`${s.base}/api/artifact?review=design&side=actual&sha256=${shown}`, { headers: s.auth })).status, 200);
  assert.equal((await fetch(`${s.base}/api/artifact?review=design&side=actual&sha256=${'0'.repeat(64)}`, { headers: s.auth })).status, 409);
  assert.equal((await fetch(`${s.base}/api/artifact?review=design&side=actual&sha256=nothex`, { headers: s.auth })).status, 400);
  assert.equal((await fetch(`${s.base}/api/artifact?review=..%2F..%2Fetc%2Fpasswd&side=actual`, { headers: s.auth })).status, 404);
  assert.equal((await fetch(`${s.base}/api/artifact?review=design&side=..%2Fsecret`, { headers: s.auth })).status, 400);
  assert.equal((await fetch(`${s.base}/../../etc/passwd`)).status, 404);
  const page = await fetch(`${s.base}/`);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('server: the demo panel refuses lifecycle actions and keeps its own channel', async (t) => {
  const demo = createDemo();
  t.after(() => demo.cleanup());
  const controller = new PanelController({ config: demo.config, provenance: 'demo', demo });
  const s = await serve(t, controller);
  if (!s) return;
  const state = await (await fetch(`${s.base}/api/state`, { headers: s.auth })).json();
  assert.equal(state.provenance, 'demo');
  assert.equal((await s.post('/api/launch', { profileId: 'implementation', confirm: true })).status, 403);
  assert.equal((await s.post('/api/cancel', { runId: 'implementation-lead' })).status, 403);
  const decided = await s.post('/api/review/decide', { reviewId: 'design', decision: 'request_changes', feedback: 'Spacing', expectedHash: state.reviews[0].evidenceHash });
  assert.equal(decided.status, 200);
  const after = await (await fetch(`${s.base}/api/state`, { headers: s.auth })).json();
  assert.equal(after.reviews[0].decisions[0].channel, 'demo-ui');
  assert.equal((await s.post('/api/demo/revise', { reviewId: 'design' })).status, 200);
  assert.equal((await s.post('/api/demo/revise', { reviewId: 'design' })).status, 409);
});
