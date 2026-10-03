// Acceptance corrections: per-profile serialisation across launch, resume, and
// controllers sharing state; the approval gate on resume; confirmed input
// snapshots; verified run-file reads; fresh evidence hashing; and honest
// decision provenance. Every "claude" here is the local mock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { PanelController } from '../src/controller.mjs';
import { validatePanelConfig } from '../src/config.mjs';
import { CHANNELS } from '../src/reviews.mjs';
import { config, configDoc, png, waitFor, workspace } from './fixtures.mjs';

const available = () => ({ dependencies: [{ name: 'claude', status: 'available-unverified' }] });

function ungated(ws, mutate = () => {}) {
  const doc = configDoc(ws);
  delete doc.launch.profiles[0].requiresApproval;
  mutate(doc);
  const result = validatePanelConfig(doc);
  if (!result.ok) throw new Error(result.problems.join('; '));
  return result.config;
}

function make(t, cfg, options = {}) {
  const controller = new PanelController({ config: cfg, doctor: available, ...options });
  t.after(() => controller.close());
  return controller;
}

async function confirmLaunch(controller) {
  const preview = await controller.launchPreview('impl');
  return { profileId: 'impl', confirm: true, requestSha256: preview.request.sha256, promptSha256: preview.prompt.sha256 };
}

async function approveCurrent(controller) {
  const [review] = (await controller.snapshot()).reviews;
  await controller.decide({ reviewId: 'design', decision: 'approve', expectedHash: review.evidenceHash, channel: 'local-ui' });
}

async function completedRun(t, controller) {
  controller.env = { ...controller.env, FAKE_SCENARIO: 'ok' };
  const { runId } = await controller.launch(await confirmLaunch(controller));
  assert.ok(await waitFor(() => controller.owned.get(runId).exited, 15_000));
  const run = (await controller.snapshot()).runs.find((r) => r.id === runId);
  assert.equal(run.state, 'completed', JSON.stringify(run.errors));
  return runId;
}

function settledCounts(results) {
  return {
    ok: results.filter((r) => r.status === 'fulfilled').length,
    refused: results.filter((r) => r.status === 'rejected' && r.reason.code === 'already_running').length,
  };
}

// Evidence mtimes are pinned to a whole second before the panel first sees
// them, so a later restore is bit-exact (Date-based utimes loses sub-ms).
const PINNED = 1_700_000_000;
function pinMtimes(ws) {
  for (const name of ['reference.png', 'actual-1.png', 'actual-2.png']) fs.utimesSync(path.join(ws.root, 'evidence', name), PINNED, PINNED);
}

// Rewrite bytes in place (same inode, same length) and restore the mtime.
function rewriteSameLengthKeepMtime(file) {
  const before = fs.statSync(file);
  assert.equal(before.mtimeMs, PINNED * 1000);
  const bytes = fs.readFileSync(file);
  bytes[bytes.length - 20] ^= 0xff;
  const fd = fs.openSync(file, 'r+');
  fs.writeSync(fd, bytes, 0, bytes.length, 0);
  fs.closeSync(fd);
  fs.utimesSync(file, PINNED, PINNED);
  const after = fs.statSync(file);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
}

// ------------------------------------------------------------ 1. concurrency

test('concurrent launches of one profile: exactly one spawns', async (t) => {
  const ws = await workspace(t);
  const spawned = [];
  const controller = make(t, ungated(ws), {
    env: { ...process.env, FAKE_SCENARIO: 'hang' },
    spawnImpl: (...args) => { spawned.push(args); return spawn(...args); },
  });
  const body = await confirmLaunch(controller);
  const results = await Promise.allSettled([controller.launch(body), controller.launch(body), controller.launch(body)]);
  assert.deepEqual(settledCounts(results), { ok: 1, refused: 2 });
  assert.equal(spawned.length, 1);
});

test('two controllers sharing state cannot both launch, and launch versus resume is serialised', async (t) => {
  const ws = await workspace(t);
  const a = make(t, ungated(ws), { env: { ...process.env, FAKE_SCENARIO: 'ok' } });
  const b = make(t, ungated(ws), { env: { ...process.env, FAKE_SCENARIO: 'hang' } });
  const first = await completedRun(t, a);
  a.env = { ...process.env, FAKE_SCENARIO: 'hang' };

  // Launch from one controller races a launch from the other.
  const body = await confirmLaunch(a);
  let results = await Promise.allSettled([a.launch(body), b.launch(body)]);
  assert.deepEqual(settledCounts(results), { ok: 1, refused: 1 });
  const winner = results[0].status === 'fulfilled' ? a : b;
  const loser = winner === a ? b : a;
  const live = results.find((r) => r.status === 'fulfilled').value.runId;
  // The other controller sees the profile as busy and refuses resume too.
  const busy = (await loser.snapshot()).profiles[0];
  assert.equal(busy.launch.allowed, false);
  assert.ok(busy.launch.reasons.some((r) => /already active or starting/.test(r)));
  const preview = await a.resumePreview(first);
  assert.equal(preview.allowed, false);
  await assert.rejects(loser.resume({ runId: first, confirm: true, promptSha256: '0'.repeat(64) }), { code: 'already_running' });
  await winner.cancel({ runId: live });
  assert.ok(await waitFor(() => winner.owned.get(live).exited, 15_000));
  assert.ok(await waitFor(() => winner.leases.holder('impl') === null), 'the lease is released when the child exits');

  // Resume and launch race (in both controllers at once).
  const resumePreview = await a.resumePreview(first);
  assert.equal(resumePreview.allowed, true, resumePreview.reason);
  const resumeBody = { runId: first, confirm: true, promptSha256: resumePreview.prompt.sha256 };
  results = await Promise.allSettled([a.resume(resumeBody), b.launch(body), a.launch(body), b.resume(resumeBody)]);
  assert.deepEqual(settledCounts(results), { ok: 1, refused: 3 });
});

test('a lease is reclaimed only when its holders are gone; a live lease is never stolen', async (t) => {
  const ws = await workspace(t);
  const controller = make(t, ungated(ws), { env: { ...process.env, FAKE_SCENARIO: 'hang' } });
  const leaseFile = controller.leases.file('impl');
  // A live holder (this test process, another session): refused, file intact.
  const live = JSON.stringify({ schemaVersion: 1, token: 'a'.repeat(32), pid: process.pid, childPid: null, session: 'elsewhere', runId: null });
  fs.writeFileSync(leaseFile, live);
  await assert.rejects(controller.launch(await confirmLaunch(controller)), { code: 'already_running' });
  assert.equal(fs.readFileSync(leaseFile, 'utf8'), live);
  // A lease whose controller and child have both exited is stale.
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  fs.writeFileSync(leaseFile, JSON.stringify({ schemaVersion: 1, token: 'b'.repeat(32), pid: dead, childPid: dead, session: 'gone', runId: null }));
  const { runId } = await controller.launch(await confirmLaunch(controller));
  const holder = controller.leases.holder('impl');
  assert.equal(holder.live, true);
  assert.equal(holder.runId, runId);
  // A symlinked lease is treated as held, never followed or removed.
  await controller.cancel({ runId });
  assert.ok(await waitFor(() => controller.owned.get(runId).exited, 15_000));
  fs.symlinkSync(path.join(ws.outside, 'secret.png'), leaseFile);
  await assert.rejects(controller.launch(await confirmLaunch(controller)), { code: 'already_running' });
  assert.ok(fs.lstatSync(leaseFile).isSymbolicLink());
});

// ------------------------------------------------------------ 2. resume gate

test('resume enforces the approval gate on current evidence, including after a successful run', async (t) => {
  const ws = await workspace(t);
  pinMtimes(ws);
  const controller = make(t, config(ws), { env: { ...process.env, FAKE_SCENARIO: 'ok' } });
  await approveCurrent(controller);
  const runId = await completedRun(t, controller);
  assert.equal((await controller.snapshot()).runs.find((r) => r.id === runId).actions.resume.allowed, true);

  // New evidence after the run: the approval is stale, so resume waits.
  await controller.submitEvidence({ reviewId: 'design', actual: path.join(ws.root, 'evidence', 'actual-2.png'), submittedBy: 'model-tool' });
  const shown = (await controller.snapshot()).runs.find((r) => r.id === runId).actions.resume;
  assert.equal(shown.allowed, false);
  assert.match(shown.reason, /Waiting for approval of “Dashboard layout”.*applies to resuming/);
  const preview = await controller.resumePreview(runId);
  assert.equal(preview.allowed, false);
  assert.equal(preview.reason, shown.reason, 'the UI reason is the enforced reason');
  await assert.rejects(controller.resume({ runId, confirm: true, promptSha256: '0'.repeat(64) }), (error) => error.code === 'resume_refused' && error.message === shown.reason);

  // Approve revision 2, then rewrite it in place with the mtime restored: the
  // enforcement path hashes the bytes now and refuses.
  await approveCurrent(controller);
  const ready = await controller.resumePreview(runId);
  assert.equal(ready.allowed, true);
  rewriteSameLengthKeepMtime(path.join(ws.root, 'evidence', 'actual-2.png'));
  await assert.rejects(controller.resume({ runId, confirm: true, promptSha256: ready.prompt.sha256 }), { code: 'resume_refused' });
  assert.equal(controller.leases.holder('impl'), null, 'a refused resume releases the lease');
});

// ------------------------------------------------------------ 3. confirmed bytes

test('the adapter consumes the confirmed bytes even if the registered files change at spawn time', async (t) => {
  const ws = await workspace(t);
  const log = path.join(ws.base, 'prompts.jsonl');
  const requestFile = path.join(ws.root, 'requests', 'request.json');
  const promptFile = path.join(ws.root, 'requests', 'prompt.txt');
  const correctionsFile = path.join(ws.root, 'requests', 'corrections.txt');
  const argvs = [];
  const controller = make(t, ungated(ws), {
    env: { ...process.env, FAKE_SCENARIO: 'ok', FAKE_PROMPT_LOG: log },
    spawnImpl: (command, argv, options) => {
      // The spawn boundary: the registered originals are edited right now.
      argvs.push(argv);
      const doc = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
      fs.writeFileSync(requestFile, JSON.stringify({ ...doc, agentId: 'mutated-lead' }));
      fs.writeFileSync(promptFile, 'MUTATED PROMPT\n');
      fs.writeFileSync(correctionsFile, 'MUTATED CORRECTIONS\n');
      return spawn(command, argv, options);
    },
  });
  const { runId } = await controller.launch(await confirmLaunch(controller));
  assert.ok(await waitFor(() => controller.owned.get(runId).exited, 15_000));
  const runDir = controller.getRun(runId).dir;
  const profile = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  assert.equal(profile.identity.agentId, 'panel-lead', 'the run used the confirmed request');
  let prompts = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(prompts.at(-1).prompt, 'Implement the approved design.\n');
  const inputs = path.join(controller.stateDir, 'inputs', runId);
  const args = argvs[0];
  assert.equal(args[args.indexOf('--request') + 1], path.join(inputs, 'request.json'));
  assert.equal(args[args.indexOf('--prompt') + 1], path.join(inputs, 'prompt.txt'));
  assert.equal(fs.statSync(inputs).mode & 0o777, 0o700);
  assert.equal(args[args.indexOf('--out') + 1], runDir, 'a new run directory under the profile runsDir');

  // Resume: the composed prompt is snapshotted the same way.
  fs.writeFileSync(correctionsFile, 'Apply the corrections.\n');
  const preview = await controller.resumePreview(runId);
  const resumed = await controller.resume({ runId, confirm: true, promptSha256: preview.prompt.sha256 });
  assert.ok(await waitFor(() => controller.owned.get(resumed.runId).exited, 15_000));
  prompts = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(prompts.at(-1).prompt, 'Apply the corrections.\n');
  assert.ok(prompts.at(-1).args.includes('--resume'));
  assert.ok(fs.existsSync(path.join(controller.getRun(resumed.runId).dir, 'resume-delta.json')));
  // A planted entry in the inputs location is never reused or followed.
  fs.writeFileSync(promptFile, 'Implement the approved design.\n');
  fs.writeFileSync(requestFile, `${JSON.stringify(JSON.parse(fs.readFileSync(requestFile, 'utf8')), null, 2)}\n`);
  await fsp.rm(path.join(controller.stateDir, 'inputs'), { recursive: true });
  fs.symlinkSync(ws.outside, path.join(controller.stateDir, 'inputs'));
  await assert.rejects(controller.launch(await confirmLaunch(controller)), { code: 'state_invalid' });
  assert.deepEqual(fs.readdirSync(ws.outside), ['secret.png']);
});

// ------------------------------------------------------------ 4. run files

async function observedRun(dir, marker) {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'run.json'), JSON.stringify({ mode: 'solo', toolProfile: 'files', identity: { agentId: 'lead' }, startedAt: new Date().toISOString() }));
  await fsp.writeFile(path.join(dir, 'events.public.jsonl'), `${JSON.stringify({ type: 'tool.started', at: new Date().toISOString(), data: { toolName: marker } })}\n`);
}

test('run reads are verified: swapped directories, symlinked or oversized files, and FIFOs are refused', async (t) => {
  const ws = await workspace(t);
  const dirs = Object.fromEntries(['swap', 'summary', 'events', 'big', 'fifo'].map((name) => [name, path.join(ws.root, 'runs', name)]));
  for (const [name, dir] of Object.entries(dirs)) await observedRun(dir, `Tool${name}`);
  const decoy = path.join(ws.root, 'decoy');
  await observedRun(decoy, 'LEAKEDINSIDE');
  await observedRun(path.join(ws.outside, 'run'), 'LEAKEDOUTSIDE');
  await fsp.writeFile(path.join(ws.outside, 'summary.json'), JSON.stringify({ ok: true, errors: ['LEAKEDSUMMARY'] }));
  const controller = make(t, config(ws, { runs: Object.entries(dirs).map(([id, dir]) => ({ id, dir })) }));
  let snapshot = await controller.snapshot();
  for (const id of Object.keys(dirs)) assert.equal(snapshot.runs.find((r) => r.id === id).state, 'running-observed');

  // After startup: the directory becomes a symlink (inside the root), the
  // summary and events become symlinks out, one stream grows past the limit,
  // and one summary becomes a FIFO.
  await fsp.rm(dirs.swap, { recursive: true });
  await fsp.symlink(decoy, dirs.swap);
  await fsp.symlink(path.join(ws.outside, 'summary.json'), path.join(dirs.summary, 'summary.json'));
  await fsp.rm(path.join(dirs.events, 'events.public.jsonl'));
  await fsp.symlink(path.join(ws.outside, 'run', 'events.public.jsonl'), path.join(dirs.events, 'events.public.jsonl'));
  fs.truncateSync(path.join(dirs.big, 'events.public.jsonl'), 16 * 1024 * 1024 + 1);
  execFileSync('mkfifo', [path.join(dirs.fifo, 'summary.json')]);

  snapshot = await controller.snapshot();
  for (const id of Object.keys(dirs)) {
    const run = snapshot.runs.find((r) => r.id === id);
    assert.equal(run.state, 'unreadable', id);
    assert.deepEqual(run.activity, [], id);
    assert.equal(run.actions.resume.allowed, false);
  }
  assert.match(snapshot.runs.find((r) => r.id === 'big').errors[0], /exceeds its size limit/);
  assert.match(snapshot.runs.find((r) => r.id === 'swap').errors[0], /no longer a plain directory/);
  const text = JSON.stringify(snapshot);
  for (const secret of ['LEAKEDINSIDE', 'LEAKEDOUTSIDE', 'LEAKEDSUMMARY', ws.root, ws.outside]) assert.ok(!text.includes(secret), secret);
});

test('a launched run whose directory is swapped later is unreadable and cannot be resumed', async (t) => {
  const ws = await workspace(t);
  const controller = make(t, ungated(ws), { env: { ...process.env, FAKE_SCENARIO: 'ok' } });
  const runId = await completedRun(t, controller);
  const dir = controller.getRun(runId).dir;
  await fsp.rename(dir, `${dir}-moved`);
  await fsp.symlink(`${dir}-moved`, dir);
  const run = (await controller.snapshot()).runs.find((r) => r.id === runId);
  assert.equal(run.state, 'unreadable');
  await assert.rejects(controller.resume({ runId, confirm: true, promptSha256: '0'.repeat(64) }), { code: 'resume_refused' });
});

test('controller state files are never written or read through a symlink', async (t) => {
  const ws = await workspace(t);
  const controller = make(t, config(ws));
  const [review] = (await controller.snapshot()).reviews;
  const target = path.join(ws.outside, 'target.jsonl');
  await fsp.writeFile(target, '');
  fs.symlinkSync(target, path.join(controller.stateDir, 'reviews.jsonl'));
  await assert.rejects(controller.decide({ reviewId: 'design', decision: 'approve', expectedHash: review.evidenceHash, channel: 'local-ui' }), { code: 'state_unreadable' });
  assert.equal(fs.readFileSync(target, 'utf8'), '', 'nothing written through the link');
  fs.symlinkSync(target, path.join(controller.stateDir, 'launches.jsonl'));
  assert.throws(() => controller.recordLaunch({ runId: 'x' }), { code: 'ELOOP' });
  assert.equal(fs.readFileSync(target, 'utf8'), '');
  // A planted hard link is refused for appends as well.
  const other = path.join(ws.base, 'other.jsonl');
  await fsp.writeFile(other, '');
  fs.rmSync(path.join(controller.stateDir, 'launches.jsonl'));
  fs.linkSync(other, path.join(controller.stateDir, 'launches.jsonl'));
  assert.throws(() => controller.recordLaunch({ runId: 'x' }), { code: 'state_invalid' });
  assert.equal(fs.readFileSync(other, 'utf8'), '');
});

// ------------------------------------------------------------ 5. evidence bytes

test('decisions and served images bind to the current bytes, not a cached hash', async (t) => {
  const ws = await workspace(t);
  pinMtimes(ws);
  const controller = make(t, config(ws));
  const actualFile = path.join(ws.root, 'evidence', 'actual-1.png');
  let [review] = (await controller.snapshot()).reviews;
  const firstHash = review.evidenceHash;
  const firstImage = review.actual.sha256;
  assert.match(firstImage, /^[0-9a-f]{64}$/);
  assert.equal((await controller.artifact('design', 'actual', firstImage)).sha256, firstImage);

  // Same inode, same length, mtime restored.
  rewriteSameLengthKeepMtime(actualFile);
  await assert.rejects(controller.decide({ reviewId: 'design', decision: 'approve', expectedHash: firstHash, channel: 'local-ui' }), { code: 'stale_evidence' });
  await assert.rejects(controller.artifact('design', 'actual', firstImage), { code: 'stale_evidence' });
  [review] = (await controller.snapshot()).reviews;
  assert.notEqual(review.evidenceHash, firstHash, 'the display snapshot also sees the rewrite');
  assert.notEqual(review.actual.sha256, firstImage);

  // Approve the current bytes; then swap the file for a symlink to another image inside the root.
  await controller.decide({ reviewId: 'design', decision: 'approve', expectedHash: review.evidenceHash, channel: 'local-ui' });
  await fsp.rm(actualFile);
  await fsp.symlink(path.join(ws.root, 'evidence', 'actual-2.png'), actualFile);
  [review] = (await controller.snapshot()).reviews;
  assert.equal(review.state, 'awaiting_evidence');
  assert.equal(review.actual.present, false);
  assert.equal(review.actual.problem, 'path_changed');
  await assert.rejects(controller.artifact('design', 'actual'), { code: 'path_changed' });
  assert.equal((await controller.snapshot()).profiles[0].launch.allowed, false);
});

// ------------------------------------------------------------ 6. provenance

test('decision channels describe how a decision arrived, not that a human made it', async (t) => {
  assert.match(CHANNELS['local-ui'].authentication, /local client, not a person/);
  assert.doesNotMatch(JSON.stringify(CHANNELS), /\buser\b/);
  const ws = await workspace(t);
  const controller = make(t, config(ws));
  await approveCurrent(controller);
  const [review] = (await controller.snapshot()).reviews;
  assert.equal(review.decisions[0].channel, 'local-ui');
  assert.equal(review.decisions[0].actor, 'local panel client');
  await assert.rejects(controller.decide({ reviewId: 'design', decision: 'approve', expectedHash: review.evidenceHash, channel: 'human' }), { code: 'invalid_channel' });
});

test('approval of evidence that later changes is not reused for a different image revision', async (t) => {
  const ws = await workspace(t);
  const controller = make(t, config(ws));
  await approveCurrent(controller);
  await fsp.writeFile(path.join(ws.root, 'evidence', 'actual-1.png'), png([1, 2, 3]));
  const [review] = (await controller.snapshot()).reviews;
  assert.equal(review.state, 'ready_for_review');
  assert.equal((await controller.snapshot()).profiles[0].gate.satisfied, false);
});
