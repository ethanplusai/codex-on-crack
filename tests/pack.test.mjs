// The distributable archive: exactly the inventory, no private data, and
// byte-reproducible for the same input.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { buildZip, pack, readZipEntries, scanEntries } from '../scripts/pack.mjs';
import { inventory, selected } from '../scripts/release.mjs';

test('the zip writer round-trips entries', () => {
  const buffer = buildZip([
    { name: 'a.txt', data: Buffer.from('hello') },
    { name: 'dir/b.bin', data: Buffer.from([0, 1, 2, 255]) },
  ]);
  assert.equal(buffer.subarray(0, 4).toString('hex'), '504b0304');
  const entries = readZipEntries(buffer);
  assert.deepEqual(entries.map((entry) => entry.name), ['a.txt', 'dir/b.bin']);
  assert.equal(entries[0].data.toString('utf8'), 'hello');
  assert.deepEqual([...entries[1].data], [0, 1, 2, 255]);
  assert.equal(buildZip([{ name: 'a.txt', data: Buffer.from('hello') }]).equals(buildZip([{ name: 'a.txt', data: Buffer.from('hello') }])), true,
    'the same input produces the same bytes');
});

test('the archive is exactly the inventory plus the manifest', async (t) => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'crack-pack-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const out = path.join(root, 'out.zip');
  const result = pack({ out });
  assert.equal(result.ok, true);
  assert.equal(result.files, selected().length + 1);

  const entries = readZipEntries(fs.readFileSync(out));
  const names = entries.map((entry) => entry.name);
  assert.deepEqual(names, [...selected(), 'MANIFEST.sha256'].sort());
  for (const name of names) {
    assert.doesNotMatch(name, /(^|\/)(node_modules|\.git|dist|\.local)(\/|$)/, `${name} must not ship`);
    assert.doesNotMatch(name, /\.(log|zip|tar|tgz|gz)$/, `${name} must not ship`);
  }
  assert.ok(!names.some((name) => name.startsWith('PRIVATE-BASELINE')), 'provenance stays with the source tree');
  assert.ok(!names.includes('dist/'), 'the archive is not inside itself');
  assert.equal(result.sha256, crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex'));
});

test('no shipped entry carries a private path or a credential shape', async (t) => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'crack-pack-scan-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const out = path.join(root, 'out.zip');
  pack({ out });
  const entries = readZipEntries(fs.readFileSync(out));
  const home = os.homedir();
  for (const entry of entries) {
    const text = entry.data.toString('utf8');
    if (text.includes('\u0000')) continue;
    assert.ok(!text.includes(home), `${entry.name} must not embed the packaging home path`);
    assert.doesNotMatch(text, /sk-ant-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      `${entry.name} must not carry a credential-shaped string`);
  }
  assert.ok(!entries.some(e=>/^docs\/(pilots|assets)\//.test(e.name)), 'private pilot records and rejected visuals do not ship');
  assert.ok(entries.some(e=>e.name==='docs/RECORDING.md'), 'recording instructions ship');
});

test('packing refuses a stale manifest and a forbidden entry', async (t) => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'crack-pack-stale-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(ROOT, root, {
    recursive: true,
    filter: (src) => !/(^|\/)(node_modules|\.git|dist)(\/|$)/.test(src),
  });
  const manifest = path.join(root, 'MANIFEST.sha256');
  fs.writeFileSync(path.join(root, 'README.md'), `${fs.readFileSync(path.join(root, 'README.md'), 'utf8')}\nchanged\n`);
  assert.throws(() => pack({ root, out: path.join(root, 'out.zip') }), /does not match this package/);

  // A stray unlisted file is simply not shipped; it is never silently added.
  fs.writeFileSync(manifest, inventory(root));
  fs.writeFileSync(path.join(root, 'plugins', 'codex-on-crack', 'notes.log'), 'should not ship\n');
  const repacked = pack({ root, out: path.join(root, 'out.zip') });
  const names = readZipEntries(fs.readFileSync(repacked.archive)).map((entry) => entry.name);
  assert.ok(!names.some((name) => name.endsWith('.log')), 'an unlisted log is not packed');
});

test('the content scan refuses private paths, credentials, and forbidden entries', () => {
  const home = os.homedir();
  // Built piecewise so this test file itself never contains a key-shaped literal.
  const fakeKey = ['sk', 'ant', 'abcdefghijklmnopqrstuvwx'].join('-');
  const problems = scanEntries([
    { name: 'notes.log', data: Buffer.from('plain') },
    { name: 'docs/private.md', data: Buffer.from(`lives in ${home}/secret`) },
    { name: 'code/leak.mjs', data: Buffer.from(`const key = "${fakeKey}";`) },
    { name: 'code/ok.mjs', data: Buffer.from('const key = process.env.API_KEY;') },
  ], home);
  const reasons = problems.map((problem) => `${problem.entry}:${problem.reason}`);
  assert.equal(problems.length, 3, JSON.stringify(reasons));
  assert.ok(reasons.some((entry) => entry.startsWith('notes.log:')));
  assert.ok(reasons.some((entry) => entry.startsWith('docs/private.md:')));
  assert.ok(reasons.some((entry) => entry.startsWith('code/leak.mjs:')));
  assert.ok(!reasons.some((entry) => entry.startsWith('code/ok.mjs:')), 'an env lookup is not a credential');
});

test('the packed archive unpacks and the plugin manifest is intact', async (t) => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'crack-pack-open-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const out = path.join(root, 'out.zip');
  pack({ out });
  const extract = path.join(root, 'extract');
  fs.mkdirSync(extract);

  const entries = readZipEntries(fs.readFileSync(out));
  for (const entry of entries) {
    const target = path.join(extract, entry.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
  }
  const plugin = JSON.parse(fs.readFileSync(path.join(extract, 'plugins', 'codex-on-crack', '.codex-plugin', 'plugin.json'), 'utf8'));
  assert.equal(plugin.name, 'codex-on-crack');
  assert.equal(plugin.skills, './skills/');
  for (const skill of ['crack', 'crack-plan', 'crack-setup']) {
    assert.ok(fs.existsSync(path.join(extract, 'plugins', 'codex-on-crack', 'skills', skill, 'SKILL.md')), `${skill} ships`);
  }
  const marketplace = JSON.parse(fs.readFileSync(path.join(extract, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.equal(marketplace.plugins[0].name, 'codex-on-crack');
  assert.equal(fs.readFileSync(path.join(extract, 'MANIFEST.sha256'), 'utf8'), inventory());
});

test('the extracted archive serves the UI assets and a run through its own viewer', async (t) => {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'crack-pack-serve-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const out = path.join(root, 'out.zip');
  pack({ out });
  const extract = path.join(root, 'extract');
  fs.mkdirSync(extract);
  const entries = readZipEntries(fs.readFileSync(out));
  const names = entries.map((entry) => entry.name);
  for (const asset of ['public/index.html', 'public/style.css', 'public/app.mjs']) {
    assert.ok(names.includes(`plugins/codex-on-crack/skills/crack/viewer/${asset}`), `${asset} must be in the archive`);
  }
  for (const entry of entries) {
    const target = path.join(extract, entry.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
  }

  // A minimal finished run, so the extracted viewer has an explicit source.
  const runDir = path.join(extract, 'demo-runs', 'opus-solo', 'runs', 'lead-1');
  fs.mkdirSync(runDir, { recursive: true });
  const event = (type, at, extra = {}) => ({
    schemaVersion: 1, eventId: `${type}-${at}`, runId: 'run-1', phase: 'phase-1', parentAgentId: 'host-1',
    requestId: 'req-1', agentId: 'solo-lead', invocationId: 'inv-1', mode: 'solo', toolProfile: 'files',
    type, at, status: 'recorded', requestedModel: 'claude-opus-5-5', observedModel: null, route: 'subscription',
    toolOwner: 'external-claude', usage: null, data: {}, ...extra,
  });
  fs.writeFileSync(path.join(runDir, 'events.public.jsonl'), `${[
    event('agent.created', '2026-09-29T10:00:00Z'),
    event('model.observed', '2026-09-29T10:00:01Z', { observedModel: 'claude-opus-5-5' }),
    event('tool.started', '2026-09-29T10:00:02Z', { data: { toolName: 'Bash' } }),
    event('agent.returned', '2026-09-29T10:00:03Z', { status: 'completed' }),
  ].map((e) => JSON.stringify(e)).join('\n')}\n`);
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ mode: 'solo', toolProfile: 'files', identity: { agentId: 'solo-lead' }, startedAt: '2026-09-29T10:00:00Z' }));

  const viewer = path.join(extract, 'plugins', 'codex-on-crack', 'skills', 'crack', 'viewer');
  const { createHandler } = await import(pathToFileURL(path.join(viewer, 'serve.mjs')).href);
  const handler = createHandler({ token: 'extract-token', port: 4318, runs: [runDir] });
  const call = async (url, headers = {}) => {
    const res = {
      statusCode: null, headers: {}, body: '',
      setHeader(key, value) { this.headers[key] = value; },
      writeHead(code) { this.statusCode = code; },
      end(body = '') { this.body = body; return this; },
    };
    await handler({ method: 'GET', url, headers: { host: '127.0.0.1:4318', ...headers } }, res);
    return res;
  };

  const page = await call('/');
  assert.match(String(page.body), /Agent activity/, 'the extracted index.html is served');
  const css = await call('/style.css');
  assert.ok(String(css.body).length > 100, 'the extracted stylesheet is served');
  assert.match(String(css.headers['Content-Type']), /text\/css/);
  assert.equal((await call('/api/state')).statusCode, 401, 'the token is still required');
  const state = JSON.parse(String((await call('/api/state', { authorization: 'Bearer extract-token' })).body));
  assert.equal(state.mode, 'Live');
  assert.ok(state.events.some((e) => e.type === 'tool.started'));
  assert.equal(state.sources[0].mode, 'solo');
});


test('publication scan rejects agent context and capture files but permits product skills', () => {
 const blocked=['docs/AGENTS.md','plugins/demo/sessions/run.json','docs/captures/snapshot.json','docs/recordings/private.md','panel/data/session.jsonl'];
 const entries=[...blocked,'plugins/demo/skills/task/SKILL.md','panel/src/sessions.mjs'].map(name=>({name,data:Buffer.from('safe fixture')}));
 assert.deepEqual(scanEntries(entries).map(p=>p.entry),blocked);
});
