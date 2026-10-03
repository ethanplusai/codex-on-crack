// Controller contracts: registered roots only, safe artifacts, review binding,
// demo separation, honest unknowns, and owned lifecycle through the existing
// adapter CLI. Every "claude" here is a local mock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PanelController } from '../src/controller.mjs';
import { validatePanelConfig } from '../src/config.mjs';
import { createDemo } from '../src/demo.mjs';
import { config, configDoc, png, waitFor, workspace } from './fixtures.mjs';

const available = () => ({ dependencies: [{ name: 'claude', status: 'available-unverified' }] });
const controllerFor = (ws, overrides = {}, options = {}) => new PanelController({ config: config(ws, overrides), doctor: available, ...options });

test('configuration refuses executable keys, paths outside roots, traversal, and symlink escapes', async (t) => {
  const ws = await workspace(t);
  const bad = (overrides) => validatePanelConfig(configDoc(ws, overrides));
  assert.match(bad({ command: 'rm -rf /' }).problems.join(' '), /may not carry executable actions/);
  const outsideReview = bad({ reviews: [{ id: 'r', title: 'R', reference: path.join(ws.outside, 'secret.png') }] });
  assert.equal(outsideReview.ok, false);
  assert.match(outsideReview.problems.join(' '), /not inside a registered workspace/);
  const traversal = bad({ reviews: [{ id: 'r', title: 'R', reference: `${ws.root}/../outside/secret.png` }] });
  assert.match(traversal.problems.join(' '), /not inside a registered workspace/);
  await fsp.symlink(ws.outside, path.join(ws.root, 'escape'));
  const symlink = bad({ reviews: [{ id: 'r', title: 'R', reference: path.join(ws.root, 'escape', 'secret.png') }] });
  assert.match(symlink.problems.join(' '), /not inside a registered workspace/);
  const pidKey = bad({ runs: [{ id: 'x', dir: ws.root, pid: 1 }] });
  assert.match(pidKey.problems.join(' '), /pid is not accepted/);
  assert.equal(bad({ workspaces: [{ id: 'root', root: '/' }] }).ok, false);
});

test('evidence must be a raster image inside a registered root; symlinks and SVG are refused', async (t) => {
  const ws = await workspace(t);
  const controller = controllerFor(ws);
  await fsp.symlink(path.join(ws.outside, 'secret.png'), path.join(ws.root, 'evidence', 'linked.png'));
  await assert.rejects(controller.submitEvidence({ reviewId: 'design', actual: path.join(ws.root, 'evidence', 'linked.png'), submittedBy: 'model-tool' }), { code: 'outside_roots' });
  await assert.rejects(controller.submitEvidence({ reviewId: 'design', actual: `${ws.root}/evidence/../../outside/secret.png`, submittedBy: 'model-tool' }), { code: 'outside_roots' });
  await fsp.writeFile(path.join(ws.root, 'evidence', 'fake.png'), '<svg onload="alert(1)"></svg>');
  await assert.rejects(controller.submitEvidence({ reviewId: 'design', actual: path.join(ws.root, 'evidence', 'fake.png'), submittedBy: 'model-tool' }), { code: 'unsupported_image' });
  await assert.rejects(controller.submitEvidence({ reviewId: 'design', actual: 'relative.png', submittedBy: 'model-tool' }), { code: 'outside_roots' });
  await assert.rejects(controller.submitEvidence({ reviewId: 'nope', actual: path.join(ws.root, 'evidence', 'actual-2.png'), submittedBy: 'model-tool' }), { code: 'unknown_review' });
  // A model-visible submitter cannot claim to be the user or the configuration.
  await assert.rejects(controller.submitEvidence({ reviewId: 'design', actual: path.join(ws.root, 'evidence', 'actual-2.png'), submittedBy: 'config' }), { code: 'invalid_submitter' });
  const image = await controller.artifact('design', 'reference');
  assert.equal(image.type, 'image/png');
  await assert.rejects(controller.artifact('design', '../../etc/passwd'), { code: 'invalid_side' });
  // A configured file swapped for an outside symlink after startup is refused at read time.
  await fsp.rm(path.join(ws.root, 'evidence', 'actual-1.png'));
  await fsp.symlink(path.join(ws.outside, 'secret.png'), path.join(ws.root, 'evidence', 'actual-1.png'));
  await assert.rejects(controller.artifact('design', 'actual'), { code: 'outside_roots' });
});

test('approval binds to the evidence revision; replacement makes it stale', async (t) => {
  const ws = await workspace(t);
  const controller = controllerFor(ws);
  let [review] = (await controller.snapshot()).reviews;
  assert.equal(review.state, 'ready_for_review');
  await assert.rejects(controller.decide({ reviewId: 'design', decision: 'request_changes', feedback: '  ', expectedHash: review.evidenceHash, channel: 'local-ui' }), { code: 'feedback_required' });
  await assert.rejects(controller.decide({ reviewId: 'design', decision: 'approve', expectedHash: 'f'.repeat(64), channel: 'local-ui' }), { code: 'stale_evidence' });
  await assert.rejects(controller.decide({ reviewId: 'design', decision: 'approve', expectedHash: review.evidenceHash, channel: 'model-tool' }), { code: 'invalid_channel' });
  const firstHash = review.evidenceHash;
  await controller.decide({ reviewId: 'design', decision: 'approve', expectedHash: firstHash, channel: 'local-ui' });
  [review] = (await controller.snapshot()).reviews;
  assert.equal(review.state, 'approved');
  assert.equal(review.approvedBy, 'local-ui');

  await controller.submitEvidence({ reviewId: 'design', actual: path.join(ws.root, 'evidence', 'actual-2.png'), note: 'fixed', submittedBy: 'model-tool' });
  [review] = (await controller.snapshot()).reviews;
  assert.equal(review.state, 'ready_for_review');
  assert.equal(review.revision.number, 2);
  assert.match(review.notice, /no longer counts/);
  assert.equal(review.decisions[0].current, false);
  await assert.rejects(controller.decide({ reviewId: 'design', decision: 'approve', expectedHash: firstHash, channel: 'local-ui' }), { code: 'stale_evidence' });

  await controller.decide({ reviewId: 'design', decision: 'approve', expectedHash: review.evidenceHash, channel: 'mcp-app' });
  [review] = (await controller.snapshot()).reviews;
  assert.equal(review.approvedBy, 'mcp-app');
  // An in-place replacement of the approved file also invalidates the approval.
  await fsp.writeFile(path.join(ws.root, 'evidence', 'actual-2.png'), png([10, 200, 10]));
  [review] = (await controller.snapshot()).reviews;
  assert.equal(review.state, 'ready_for_review');
  assert.equal(review.revision.changedOnDisk, true);
});

test('a review with no evidence awaits it and cannot be decided', async (t) => {
  const ws = await workspace(t);
  const controller = controllerFor(ws, { reviews: [{ id: 'final', title: 'Final', gate: 'final', reference: path.join(ws.root, 'evidence', 'reference.png'), actual: null }], launch: { enabled: false } });
  const [review] = (await controller.snapshot()).reviews;
  assert.equal(review.state, 'awaiting_evidence');
  assert.equal(review.evidenceHash, null);
  await assert.rejects(controller.decide({ reviewId: 'final', decision: 'approve', expectedHash: 'a'.repeat(64), channel: 'local-ui' }), { code: 'awaiting_evidence' });
});

test('demo and real state never share provenance', async (t) => {
  const demo = createDemo();
  t.after(() => demo.cleanup());
  const ws = await workspace(t);
  const real = controllerFor(ws);
  const demoController = new PanelController({ config: demo.config, provenance: 'demo', demo });
  assert.notEqual(real.stateDir, demoController.stateDir);
  const demoSnapshot = await demoController.snapshot();
  assert.equal(demoSnapshot.provenance, 'demo');
  assert.equal(demoSnapshot.launchEnabled, false);
  const hash = demoSnapshot.reviews[0].evidenceHash;
  await assert.rejects(demoController.decide({ reviewId: 'design', decision: 'approve', expectedHash: hash, channel: 'local-ui' }), { code: 'provenance_mismatch' });
  const realHash = (await real.snapshot()).reviews[0].evidenceHash;
  await assert.rejects(real.decide({ reviewId: 'design', decision: 'approve', expectedHash: realHash, channel: 'demo-ui' }), { code: 'provenance_mismatch' });
  await assert.rejects(real.demoRevise('design'), { code: 'demo_only' });
  await assert.rejects(demoController.launch({ profileId: 'implementation', confirm: true }), { code: 'demo_readonly' });
  await assert.rejects(demoController.cancel({ runId: 'implementation-lead' }), { code: 'demo_readonly' });
  await assert.rejects(demoController.resume({ runId: 'design-lead', confirm: true }), { code: 'demo_readonly' });
  assert.ok(demoSnapshot.profiles[0].launch.reasons.some((r) => /Demo/.test(r)));
  await demoController.decide({ reviewId: 'design', decision: 'approve', expectedHash: hash, channel: 'demo-ui' });
  await demoController.demoRevise('design');
  await assert.rejects(demoController.demoRevise('design'), { code: 'no_demo_revision' });
  const after = await demoController.snapshot();
  assert.equal(after.reviews[0].state, 'ready_for_review');
  assert.equal((await real.snapshot()).reviews[0].decisions.length, 0, 'the demo never touched the real review');
});

test('unknown usage stays unknown and secrets in run directories never reach the snapshot', async (t) => {
  const ws = await workspace(t);
  const runDir = path.join(ws.root, 'runs', 'observed');
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.writeFile(path.join(runDir, 'run.json'), JSON.stringify({ mode: 'solo', toolProfile: 'files', identity: { agentId: 'lead', phase: 'build' }, startedAt: new Date(Date.now() - 60_000).toISOString(), workspace: ws.root }));
  await fsp.writeFile(path.join(runDir, 'pid.json'), JSON.stringify({ runner: 'codex-on-crack-external-lead', controlToken: 'TOPSECRETCONTROLTOKEN0123456789', pid: 1 }));
  await fsp.writeFile(path.join(runDir, 'stdout.jsonl'), '{"type":"assistant","message":"PRIVATE_TRANSCRIPT_BODY"}\n');
  await fsp.writeFile(path.join(runDir, 'events.public.jsonl'), `${JSON.stringify({ type: 'tool.started', at: new Date().toISOString(), data: { toolName: 'Read', input: '/etc/passwd' } })}\n`);
  const controller = controllerFor(ws, { runs: [{ id: 'observed', dir: runDir, label: 'Observed lead' }] });
  const snapshot = await controller.snapshot();
  const run = snapshot.runs.find((r) => r.id === 'observed');
  assert.equal(run.origin, 'observed');
  assert.equal(run.state, 'running-observed');
  assert.deepEqual(run.usage.models, []);
  assert.match(run.usage.note, /nothing is inferred/);
  assert.equal(run.timing.activeMs, null);
  assert.equal(run.timing.activeBasis, 'not reported');
  assert.equal(run.timing.elapsedBasis, 'wall clock so far');
  assert.equal(run.actions.cancel.allowed, false);
  assert.match(run.actions.cancel.reason, /Observed only/);
  const text = JSON.stringify(snapshot);
  for (const secret of ['TOPSECRETCONTROLTOKEN', 'PRIVATE_TRANSCRIPT_BODY', '/etc/passwd', ws.root, ws.base, ws.state]) {
    assert.ok(!text.includes(secret), `snapshot must not contain ${secret}`);
  }
  await assert.rejects(controller.cancel({ runId: 'observed' }), { code: 'not_owned' });
  await assert.rejects(controller.cancel({ runId: '../observed' }), { code: 'invalid_run' });
});

test('an unavailable lead route is reported and blocks launch', async (t) => {
  const ws = await workspace(t);
  const doc = configDoc(ws);
  delete doc.launch.claudeBin;
  const result = validatePanelConfig(doc);
  const controller = new PanelController({
    config: result.config,
    doctor: () => ({ dependencies: [{ name: 'claude', status: 'unavailable' }] }),
  });
  const snapshot = await controller.snapshot();
  const lead = snapshot.routes.find((r) => r.role === 'lead');
  assert.equal(lead.status, 'unavailable');
  assert.equal(snapshot.routes.find((r) => r.role === 'worker').status, 'unverified');
  assert.equal(snapshot.routes.find((r) => r.role === 'dispatch').status, 'host-only');
  assert.ok(snapshot.profiles[0].launch.reasons.some((r) => /not found on PATH/.test(r)));
});

test('the early-design gate blocks launch until the current revision is approved', async (t) => {
  const ws = await workspace(t);
  const controller = controllerFor(ws);
  let snapshot = await controller.snapshot();
  assert.equal(snapshot.profiles[0].gate.enforcement, 'controller-enforced');
  assert.equal(snapshot.profiles[0].launch.allowed, false);
  const preview = await controller.launchPreview('impl');
  await assert.rejects(controller.launch({ profileId: 'impl', confirm: true, requestSha256: preview.request.sha256, promptSha256: preview.prompt.sha256 }), { code: 'launch_refused' });
  await controller.decide({ reviewId: 'design', decision: 'request_changes', feedback: 'Fix the spacing', expectedHash: snapshot.reviews[0].evidenceHash, channel: 'local-ui' });
  snapshot = await controller.snapshot();
  assert.equal(snapshot.profiles[0].launch.allowed, false, 'changes requested is not approval');
  await controller.decide({ reviewId: 'design', decision: 'approve', expectedHash: snapshot.reviews[0].evidenceHash, channel: 'local-ui' });
  snapshot = await controller.snapshot();
  assert.equal(snapshot.profiles[0].launch.allowed, true);
});

test('launch is off by default and needs confirmation bound to the request and prompt', async (t) => {
  const ws = await workspace(t);
  const off = controllerFor(ws, { launch: { profiles: configDoc(ws).launch.profiles } });
  assert.equal(off.config.launch.enabled, false);
  assert.ok((await off.snapshot()).profiles[0].launch.reasons.some((r) => /launch.enabled is false/.test(r)));
  const doc = configDoc(ws);
  delete doc.launch.profiles[0].requiresApproval;
  const controller = new PanelController({ config: validatePanelConfig(doc).config, doctor: available });
  const preview = await controller.launchPreview('impl');
  await assert.rejects(controller.launch({ profileId: 'impl', confirm: false, requestSha256: preview.request.sha256, promptSha256: preview.prompt.sha256 }), { code: 'confirmation_required' });
  await fsp.appendFile(path.join(ws.root, 'requests', 'prompt.txt'), 'Edited after the dialog opened.\n');
  await assert.rejects(controller.launch({ profileId: 'impl', confirm: true, requestSha256: preview.request.sha256, promptSha256: preview.prompt.sha256 }), { code: 'stale_confirmation' });
});

test('owned lifecycle: launch through lead.mjs, refuse a duplicate, cancel over the control channel', async (t) => {
  const ws = await workspace(t);
  const doc = configDoc(ws);
  delete doc.launch.profiles[0].requiresApproval;
  const controller = new PanelController({ config: validatePanelConfig(doc).config, doctor: available, env: { ...process.env, FAKE_SCENARIO: 'hang' } });
  t.after(() => controller.close());
  const preview = await controller.launchPreview('impl');
  const { runId } = await controller.launch({ profileId: 'impl', confirm: true, requestSha256: preview.request.sha256, promptSha256: preview.prompt.sha256 });
  const owned = controller.owned.get(runId);
  assert.ok(owned, 'the controller owns the child it spawned');
  await assert.rejects(controller.launch({ profileId: 'impl', confirm: true, requestSha256: preview.request.sha256, promptSha256: preview.prompt.sha256 }), { code: 'already_running' });
  const run = () => controller.snapshot().then((s) => s.runs.find((r) => r.id === runId));
  assert.ok(await waitFor(async () => (await run())?.state === 'running'), 'run becomes visible as running');
  assert.ok(await waitFor(() => fs.existsSync(path.join(controller.getRun(runId).dir, 'control.heartbeat'))), 'runner publishes its control channel');
  const live = await run();
  assert.equal(live.owned, true);
  assert.equal(live.actions.cancel.allowed, true);
  const cancelled = await controller.cancel({ runId });
  assert.equal(cancelled.cancelled, true);
  assert.ok(await waitFor(() => owned.exited, 15_000), 'the owned child exits');
  const done = await run();
  assert.equal(done.state, 'failed');
  assert.equal(done.actions.cancel.allowed, false);
  assert.equal(done.actions.resume.allowed, false, 'a cancelled run cannot be resumed');
});

test('a completed panel run resumes into a new directory with the recorded feedback', async (t) => {
  const ws = await workspace(t);
  const log = path.join(ws.base, 'prompts.jsonl');
  const controller = controllerFor(ws, {}, { env: { ...process.env, FAKE_SCENARIO: 'ok', FAKE_PROMPT_LOG: log } });
  t.after(() => controller.close());
  let snapshot = await controller.snapshot();
  await controller.decide({ reviewId: 'design', decision: 'request_changes', feedback: 'Align the three cards.', expectedHash: snapshot.reviews[0].evidenceHash, channel: 'local-ui' });
  snapshot = await controller.snapshot();
  await controller.decide({ reviewId: 'design', decision: 'approve', expectedHash: snapshot.reviews[0].evidenceHash, channel: 'local-ui' });
  const preview = await controller.launchPreview('impl');
  const { runId } = await controller.launch({ profileId: 'impl', confirm: true, requestSha256: preview.request.sha256, promptSha256: preview.prompt.sha256 });
  assert.ok(await waitFor(() => controller.owned.get(runId).exited, 15_000));
  const completed = (await controller.snapshot()).runs.find((r) => r.id === runId);
  assert.equal(completed.state, 'completed', JSON.stringify(completed.errors));
  assert.equal(completed.model, 'claude-opus-5-5');
  assert.equal(completed.timing.activeMs, 900);
  assert.equal(completed.usage.models[0].equivalentUsd, 0.12);
  assert.equal(completed.usage.models[0].billedUsd, null);
  assert.equal((await controller.snapshot()).routes.find((r) => r.role === 'lead').status, 'verified');
  assert.equal(completed.actions.resume.allowed, true);

  const resumePreview = await controller.resumePreview(runId);
  assert.equal(resumePreview.feedback.text, 'Align the three cards.');
  await assert.rejects(controller.resume({ runId, confirm: true, promptSha256: '0'.repeat(64) }), { code: 'stale_confirmation' });
  const resumed = await controller.resume({ runId, confirm: true, promptSha256: resumePreview.prompt.sha256 });
  assert.ok(await waitFor(() => controller.owned.get(resumed.runId).exited, 15_000));
  const next = (await controller.snapshot()).runs.find((r) => r.id === resumed.runId);
  assert.equal(next.kind, 'resume');
  assert.equal(next.from, runId);
  assert.notEqual(controller.getRun(resumed.runId).dir, controller.getRun(runId).dir);
  assert.ok(fs.existsSync(path.join(controller.getRun(resumed.runId).dir, 'resume-delta.json')), 'the adapter wrote its resume delta');
  const prompts = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.match(prompts.at(-1).prompt, /Apply the corrections\.[\s\S]*Reviewer feedback[\s\S]*Align the three cards\./);
  assert.ok(prompts.at(-1).args.includes('--resume'));
});

test('workspace route evidence is computed only from that workspace runs', async (t) => {
  const demo=createDemo();t.after(()=>demo.cleanup());
  const controller=new PanelController({config:demo.config,provenance:'demo',demo});
  t.after(()=>controller.close());
  controller.sessionWorkspaces.push({id:'empty',label:'Empty',root:demo.config.workspaces[0].root});
  const routes=controller.routes.bind(controller);
  controller.routes=(runs)=>[...routes(runs),{role:'evidence',runIds:runs.map(r=>r.id)}];
  const s=await controller.snapshot();
  assert.ok(s.runs.length>0);
  assert.deepEqual(s.workspaceRoutes.empty.at(-1).runIds,[]);
  for(const w of s.workspaces)assert.deepEqual(s.workspaceRoutes[w.id].at(-1).runIds,s.runs.filter(r=>r.workspaceId===w.id).map(r=>r.id));
  for(const profile of s.profiles)assert.ok(profile.workspaceId);
});
