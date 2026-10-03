// The panel controller: one local owner for registered workspaces, observed and
// launched runs, lifecycle actions, and review records.
//
// It reuses the existing pieces rather than inventing new ones:
//   - launch and resume spawn the existing `lead.mjs` CLI with a fixed argv
//     built from trusted configuration (never from request strings);
//   - cancellation uses the adapter's authenticated control channel, and only
//     for child processes this controller spawned;
//   - run state, activity, and usage come from the replay bridge and reducer,
//     fed from a bounded, verified snapshot of the run's files (the bridge
//     itself never opens anything inside a registered run directory);
//   - at most one run per launch profile is active, enforced by a lease file in
//     the shared state directory, so launch and resume in this process, and in
//     any other panel process using the same state, cannot both start one.
// The public snapshot is an allowlist: labels, codes, counters, and the
// already-redacted activity text. No paths, prompts, transcripts, pid files,
// control tokens, or raw summaries leave this module.
import crypto from 'node:crypto';
import {SessionObserver} from './sessions.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  EXTERNAL_LEAD_MODEL, LEAD_ROUTE, cancelRun, canonicalPathSync, leadDoctor,
} from '../../plugins/codex-on-crack/skills/crack/scripts/lib/external-lead.mjs';
import { isInsideRoot, validateLeadRequest } from '../../plugins/codex-on-crack/skills/crack/scripts/lib/lead-protocol.mjs';
import { bridgeRun } from '../../plugins/codex-on-crack/skills/crack/viewer/bridge.mjs';
import { clean } from '../../plugins/codex-on-crack/skills/crack/viewer/src/adapter.mjs';
import { reduceEvents, safeModelLabel } from '../../plugins/codex-on-crack/skills/crack/viewer/src/model.mjs';
import { ID_RE } from './config.mjs';
import { ProfileLeases } from './lease.mjs';
import {
  MAX_TEXT_BYTES, PanelError, appendPrivateLine, ensurePrivateDir, readImage, readVerifiedSync, resolveInside, sha256,
  writeExclusiveSync,
} from './paths.mjs';
import { REVIEW_STATES, ReviewStore } from './reviews.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Source layout: the adapter CLI lives in the sibling plugin. A built bundle
// passes its own bundled copy instead.
export const SOURCE_LEAD_CLI = path.resolve(here, '../../plugins/codex-on-crack/skills/crack/scripts/lead.mjs');
const MAX_ACTIVITY = 60;
const MAX_CHILD_OUTPUT = 256 * 1024;
const PHASE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_RUN_JSON_BYTES = 1024 * 1024;
const MAX_EVENTS_BYTES = 16 * 1024 * 1024;
const MAX_HISTORY_BYTES = 5 * 1024 * 1024;
// The only run files the controller reads, with their limits. pid.json,
// stdout.jsonl, and the control files are never opened.
const RUN_INPUTS = Object.freeze([
  ['run.json', MAX_RUN_JSON_BYTES],
  ['summary.json', MAX_RUN_JSON_BYTES],
  ['resume-delta.json', MAX_RUN_JSON_BYTES],
  ['events.public.jsonl', MAX_EVENTS_BYTES],
]);
// The bridge falls back to the raw event stream only when no public stream exists.
const RAW_EVENTS = ['events.jsonl', MAX_EVENTS_BYTES];
const STATE_SUBDIRS = ['inputs', 'leases', 'scratch'];

function parseJson(buffer) {
  if (!buffer) return null;
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}

function parseJsonl(buffer, limit = 20_000) {
  const text = buffer ? buffer.toString('utf8') : '';
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* malformed lines are skipped */ }
    if (out.length >= limit) break;
  }
  return out;
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function stamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

// Prepare the controller-owned state directory: absolute, not a symlink, 0700,
// owned by this user, with private subdirectories for confirmed launch inputs,
// profile leases, and bridge scratch space.
export function prepareStateDir(dir) {
  if (!path.isAbsolute(dir)) throw new PanelError('state_invalid', 'stateDir must be absolute.', 500);
  let stat = null;
  try { stat = fs.lstatSync(dir); } catch { stat = null; }
  if (stat?.isSymbolicLink()) throw new PanelError('state_invalid', 'stateDir must not be a symlink.', 500);
  if (stat && !stat.isDirectory()) throw new PanelError('state_invalid', 'stateDir is not a directory.', 500);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const real = fs.realpathSync(dir);
  ensurePrivateDir(real, { create: false });
  for (const sub of STATE_SUBDIRS) ensurePrivateDir(path.join(real, sub));
  return real;
}

export class PanelController {
  constructor({
    config, provenance = 'real', leadCli = SOURCE_LEAD_CLI, clock = () => new Date(),
    spawnImpl = spawn, doctor = leadDoctor, env = process.env, demo = null,
  }) {
    if (!['real', 'demo'].includes(provenance)) throw new Error('provenance must be real or demo');
    this.config = config;
    this.sessionObserver = new SessionObserver();
    this.observationConfig = config;
    this.observedSessions = config.sessions ?? [];
    this.sessionWorkspaces = config.workspaces;
    this.provenance = provenance;
    this.leadCli = leadCli;
    this.clock = clock;
    this.spawnImpl = spawnImpl;
    this.doctor = doctor;
    this.env = env;
    // Demo hooks (generated evidence) exist only for a demo controller.
    this.demo = provenance === 'demo' ? demo : null;
    this.session = crypto.randomBytes(4).toString('hex');
    this.stateDir = prepareStateDir(config.stateDir);
    this.roots = config.workspaces.map((w) => w.root);
    this.workspaces = new Map(config.workspaces.map((w) => [w.id, w]));
    this.profiles = new Map(config.launch.profiles.map((p) => [p.id, p]));
    this.reviews = new ReviewStore({ stateDir: this.stateDir, reviews: config.reviews, roots: this.roots, demo: provenance === 'demo', clock });
    this.launchFile = path.join(this.stateDir, 'launches.jsonl');
    this.leases = new ProfileLeases({ dir: path.join(this.stateDir, 'leases'), session: this.session, clock });
    // runId -> { child, dir, profileId, startedAt, exited, exitCode, output, lease }
    this.owned = new Map();
    // runId -> { key, bridged }: bridge results for unchanged run inputs.
    this.bridgeCache = new Map();
  }

  // Re-checked before every state write: the state directory and its private
  // subdirectories are still plain directories at their canonical location.
  checkState() {
    if (canonicalPathSync(this.stateDir) !== this.stateDir) throw new PanelError('state_invalid', 'The panel state directory moved or was replaced.', 500);
    ensurePrivateDir(this.stateDir, { create: false });
    for (const sub of STATE_SUBDIRS) ensurePrivateDir(path.join(this.stateDir, sub), { create: false });
  }

  readHistory() {
    try {
      return parseJsonl(readVerifiedSync([this.stateDir], this.launchFile, { exact: this.launchFile, maxBytes: MAX_HISTORY_BYTES }).data);
    } catch {
      // Missing is empty; an unsafe or oversized history is not trusted at all.
      return [];
    }
  }

  // Read one run's inputs through the verified reader, each pinned to its
  // exact canonical path under the registered run directory. A run directory
  // swapped for a symlink, or a symlinked, oversized, or non-regular input,
  // marks the run unreadable instead of being followed.
  readRunInputs(run) {
    const files = {};
    let dirStat = null;
    try { dirStat = fs.lstatSync(run.dir); } catch { dirStat = null; }
    if (dirStat === null) return { files, problem: null, missing: true };
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || canonicalPathSync(run.dir) !== run.dir) {
      return { files, problem: 'The run directory is no longer a plain directory at its registered location.' };
    }
    const read = ([name, maxBytes]) => {
      const file = path.join(run.dir, name);
      try {
        files[name] = readVerifiedSync(this.roots, file, { exact: file, maxBytes }).data;
        return null;
      } catch (error) {
        files[name] = null;
        if (error.code === 'artifact_missing') return null;
        return error.code === 'artifact_too_large' ? `${name} exceeds its size limit` : `${name} is not a safe regular file`;
      }
    };
    const problems = RUN_INPUTS.map(read).filter(Boolean);
    if (!files['events.public.jsonl']?.length) {
      const problem = read(RAW_EVENTS);
      if (problem) problems.push(problem);
    }
    return { files, problem: problems.length ? `Run files could not be read safely: ${problems.join('; ')}.` : null };
  }

  // Run the existing bridge over a private copy of the verified bytes. The
  // copy mirrors the last path components so the bridge derives the same
  // display label; it lives in a fresh 0700 scratch directory that is removed
  // straight after.
  bridgeSnapshot(run, index, files) {
    const names = Object.keys(files).filter((name) => files[name] !== null).sort();
    const key = sha256(JSON.stringify([index, run.dir, ...names.map((name) => [name, sha256(files[name])])]));
    const cached = this.bridgeCache.get(run.id);
    if (cached?.key === key) return cached.bridged;
    const scratchRoot = path.join(this.stateDir, 'scratch');
    ensurePrivateDir(scratchRoot, { create: false });
    const scratch = fs.mkdtempSync(path.join(scratchRoot, 'b-'));
    try {
      const dir = path.join(scratch, ...run.dir.split(path.sep).filter(Boolean).slice(-3));
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const name of names) writeExclusiveSync(path.join(dir, name), files[name]);
      let bridged = null;
      try {
        bridged = bridgeRun(dir, index, { clock: this.clock });
      } catch {
        bridged = null;
      }
      this.bridgeCache.set(run.id, { key, bridged });
      return bridged;
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------- runs

  // Every run the controller knows: configured observed runs plus runs this
  // controller (in this or an earlier session) launched. Keys are ids only.
  knownRuns() {
    const runs = new Map();
    for (const run of this.config.runs) runs.set(run.id, { ...run });
    for (const record of this.readHistory()) {
      if (!ID_RE.test(record?.runId ?? '') || typeof record.dir !== 'string' || !this.profiles.has(record.profileId)) continue;
      // A history entry names the canonical directory chosen at launch. It is
      // kept only while that path is normalised and inside a registered root;
      // every read is pinned to it, so a later swap makes the run unreadable.
      const dir = record.dir;
      if (!path.isAbsolute(dir) || path.normalize(dir) !== dir || !this.roots.some((root) => isInsideRoot(root, dir))) continue;
      const profile = this.profiles.get(record.profileId);
      runs.set(record.runId, {
        id: record.runId, dir, label: `${profile.label}${record.kind === 'resume' ? ' · resumed' : ''}`,
        workspace: profile.workspace, origin: 'controller', profileId: record.profileId, kind: record.kind, from: record.from ?? null,
      });
    }
    return runs;
  }

  getRun(runId) {
    if (typeof runId !== 'string' || !ID_RE.test(runId)) throw new PanelError('invalid_run', 'Unknown run.', 400);
    const run = this.knownRuns().get(runId);
    if (!run) throw new PanelError('unknown_run', 'Unknown run.', 404);
    return run;
  }

  describeRun(run, index, reviewSnapshot) {
    const owned = this.owned.get(run.id) ?? null;
    const inputs = this.readRunInputs(run);
    const { files } = inputs;
    const profile = parseJson(files['run.json']);
    const summary = parseJson(files['summary.json']);
    const bridged = inputs.problem === null && (files['run.json'] || files['summary.json'])
      ? this.bridgeSnapshot(run, index, files) : null;
    const startedAt = bridged?.run.startedAt ?? owned?.startedAt ?? null;
    const endedAt = bridged?.run.endedAt ?? null;
    let state = inputs.problem ? 'unreadable' : bridged?.run.state ?? (owned ? 'starting' : 'unavailable');
    if (state === 'running' && owned?.exited) state = 'failed';
    if (state === 'running' && !owned) state = 'running-observed';
    const now = this.clock().getTime();
    const elapsedMs = isCount(bridged?.run.wallDurationMs) ? bridged.run.wallDurationMs
      : startedAt && !endedAt && Number.isFinite(Date.parse(startedAt)) ? Math.max(0, now - Date.parse(startedAt)) : null;
    const activeMs = isCount(summary?.result?.durationApiMs) ? summary.result.durationApiMs : null;
    const phaseRaw = summary?.phase ?? profile?.identity?.phase ?? null;
    const phase = typeof phaseRaw === 'string' && PHASE_RE.test(phaseRaw) ? phaseRaw : null;
    const agents = bridged ? reduceEvents(bridged.events).map((agent) => ({
      id: agent.id,
      parent: agent.parent,
      title: agent.title,
      model: agent.model,
      status: agent.status,
      steps: { total: agent.steps.length, done: agent.steps.filter((s) => s.status === 'completed').length },
      verification: agent.verification,
      activity: agent.activity ?? null,
      first: agent.firstActivity ?? agent.created,
      last: agent.last,
    })) : [];
    const activity = bridged ? bridged.events
      .filter((event) => event.type !== 'usage.recorded')
      .slice(-MAX_ACTIVITY)
      .reverse()
      .map((event) => ({ at: event.at, type: event.type, text: event.data?.text ?? event.type.replaceAll('.', ' · '), agent: event.agentId })) : [];
    const usageModels = Object.entries(bridged?.usage.models ?? {}).map(([model, entry]) => ({
      model: safeModelLabel(model),
      inputTokens: entry.inputTokens, outputTokens: entry.outputTokens,
      cacheReadInputTokens: entry.cacheReadInputTokens, cacheCreationInputTokens: entry.cacheCreationInputTokens,
      equivalentUsd: typeof entry.equivalentUsd === 'number' ? entry.equivalentUsd : null,
      billedUsd: typeof entry.billedUsd === 'number' ? entry.billedUsd : null,
    }));
    const resumeDelta = bridged ? parseJson(files['resume-delta.json']) : null;
    const publicEvents = bridged ? parseJsonl(files['events.public.jsonl']) : [];
    const hostRequests = publicEvents
      .filter((event) => event?.type === 'request.validated' && typeof event.data?.action === 'string')
      .map((event) => ({
        at: typeof event.at === 'string' ? event.at : null,
        kind: clean(event.data.kind ?? ''),
        action: clean(event.data.action),
        executed: false,
        note: event.data.action === 'native_worker_dispatch'
          ? 'Native worker dispatch is a Codex host action. The panel cannot dispatch it; ask the host.'
          : 'A host action. The panel records it but does not perform it.',
      }));
    const workers = publicEvents
      .filter((event) => event?.type === 'worker.result' && typeof event.agentId === 'string')
      .map((event) => ({
        id: clean(event.agentId).slice(0, 64),
        model: safeModelLabel(event.observedModel ?? event.data?.observedModel),
        status: clean(String(event.status ?? 'recorded')).slice(0, 40),
        at: typeof event.at === 'string' ? event.at : null,
        source: 'recorded worker result',
      }));
    const errors = inputs.problem ? [inputs.problem]
      : Array.isArray(summary?.errors) ? summary.errors.slice(0, 5).map((e) => clean(String(e))) : [];
    return {
      id: run.id,
      label: run.label,
      origin: run.origin,
      kind: run.kind ?? null,
      from: run.from ?? null,
      workspace: this.workspaces.get(run.workspace)?.label ?? null,
      workspaceId: run.workspace,
      phase,
      owned: owned !== null,
      state,
      mode: bridged?.run.mode ?? null,
      toolProfile: bridged?.run.toolProfile ?? null,
      failureKind: bridged?.run.failureKind ?? null,
      errors,
      model: bridged?.run.model ?? null,
      startedAt,
      endedAt,
      timing: {
        elapsedMs,
        elapsedBasis: endedAt ? 'wall clock, start to end' : elapsedMs === null ? 'unknown' : 'wall clock so far',
        activeMs,
        activeBasis: activeMs === null ? 'not reported' : 'API time reported by the CLI',
      },
      usage: {
        models: usageModels,
        note: clean(bridged?.usage.note ?? 'No usage recorded.'),
        resumeDelta: resumeDelta?.delta?.counterKind ? { counterKind: String(resumeDelta.delta.counterKind) } : null,
        billing: 'Subscription runs report a list-price equivalent, not a bill. Account quota is not observable here.',
      },
      agents,
      workers,
      activity,
      hostRequests,
      actions: this.runActions(run, inputs.problem ? null : summary, owned, reviewSnapshot),
    };
  }

  // `reviewSnapshot` decides the gate. Enforcement paths pass a fresh one.
  runActions(run, summary, owned, reviewSnapshot, { ignoreLease = null } = {}) {
    const demo = this.provenance === 'demo';
    const running = owned !== null && !owned.exited;
    const cancel = demo ? { allowed: false, reason: 'Demo: no real process exists to cancel.' }
      : running ? { allowed: true, reason: null }
        : owned ? { allowed: false, reason: 'This run has already finished.' }
          : { allowed: false, reason: 'Observed only: this panel session did not start this run, so it cannot cancel it.' };
    let resume;
    if (demo) resume = { allowed: false, reason: 'Demo: resuming would start paid work, so it is disabled.' };
    else if (run.origin !== 'controller') resume = { allowed: false, reason: 'Observed only: resume runs the panel did not launch from their own CLI.' };
    else if (!this.config.launch.enabled) resume = { allowed: false, reason: 'Launching is off in the panel configuration.' };
    else if (running) resume = { allowed: false, reason: 'Still running.' };
    else if (summary?.ok !== true) resume = { allowed: false, reason: 'Only a successfully completed run can be resumed; the adapter refuses otherwise.' };
    else if (!this.profiles.get(run.profileId)?.resumePrompt) resume = { allowed: false, reason: 'No resume prompt is registered for this profile.' };
    else if (this.activeForProfile(run.profileId, { ignoreLease })) resume = { allowed: false, reason: 'Another run of this profile is active or starting.' };
    else {
      // Resuming continues the gated work, so the profile's approval gate
      // applies exactly as it does to a first launch. Corrections that should
      // run without that approval need their own registered profile.
      const gate = this.gateFor(this.profiles.get(run.profileId), reviewSnapshot);
      resume = gate.satisfied ? { allowed: true, reason: null }
        : { allowed: false, reason: `Waiting for approval of “${gate.title}” for the current evidence. The gate applies to resuming too.` };
    }
    return { cancel, resume };
  }

  // The active or starting run of a profile: one this controller owns, or a
  // live lease held by any panel process sharing the state directory.
  activeForProfile(profileId, { ignoreLease = null } = {}) {
    for (const [runId, owned] of this.owned) if (owned.profileId === profileId && !owned.exited) return runId;
    const holder = this.leases.holder(profileId);
    if (holder?.live && (ignoreLease === null || holder.token !== ignoreLease.token)) return holder.runId ?? 'starting';
    return null;
  }

  // ---------------------------------------------------------------- routes

  leadAvailability() {
    if (this.config.launch.claudeBin) {
      try {
        const stat = fs.statSync(this.config.launch.claudeBin);
        return stat.isFile() && (stat.mode & 0o111) ? { status: 'available-unverified', detail: 'Configured CLI path (test hook).' } : { status: 'unavailable', detail: 'The configured CLI path is not executable.' };
      } catch {
        return { status: 'unavailable', detail: 'The configured CLI path does not exist.' };
      }
    }
    const doctor = this.doctor({ baseEnv: this.env });
    const claude = doctor.dependencies?.find((d) => d.name === 'claude');
    return claude?.status === 'unavailable'
      ? { status: 'unavailable', detail: 'Official Claude Code CLI not found on PATH.' }
      : { status: 'available-unverified', detail: 'CLI found; login and serving model are only verified by a run.' };
  }

  routes(runs) {
    const out = [];
    const host = this.config.routes.host ?? null;
    out.push({
      role: 'host', label: host?.label ?? 'Codex host', model: host?.model ?? null, route: host?.route ?? 'host',
      configured: host !== null,
      status: host === null ? 'not-configured' : this.provenance === 'demo' ? 'demo' : 'unverified',
      detail: 'The host model is chosen in Codex. The panel cannot observe which model serves the host.',
    });
    const lead = this.provenance === 'demo' ? { status: 'demo', detail: 'Demo: no CLI is consulted.' } : this.leadAvailability();
    const leadRuns = runs.filter((r) => ['completed', 'failed'].includes(r.state));
    const verifiedBy = leadRuns.find((r) => r.state === 'completed' && r.model === EXTERNAL_LEAD_MODEL);
    const failedBy = leadRuns.find((r) => ['model_mismatch', 'authentication_required'].includes(r.failureKind));
    let status = lead.status;
    let detail = lead.detail;
    if (this.provenance === 'demo') status = 'demo';
    else if (lead.status === 'unavailable') status = 'unavailable';
    else if (verifiedBy) { status = 'verified'; detail = `Observed ${EXTERNAL_LEAD_MODEL} on the subscription route in a completed run (${verifiedBy.label}).`; }
    else if (failedBy) { status = 'failed'; detail = `A run failed with ${failedBy.failureKind}.`; }
    out.push({ role: 'lead', label: 'External project lead', model: EXTERNAL_LEAD_MODEL, route: LEAD_ROUTE, configured: true, status, detail });
    const worker = this.config.routes.worker ?? null;
    let workerStatus = worker === null ? 'not-configured' : 'unverified';
    let workerDetail = 'Configured in the panel only. A recorded worker result with this model would verify it.';
    if (worker?.model) {
      const observed = runs.some((r) => r.workerModels?.includes(worker.model));
      if (observed) { workerStatus = 'verified'; workerDetail = 'A recorded worker result reported this model.'; }
    }
    if (this.provenance === 'demo' && worker !== null) { workerStatus = 'demo'; workerDetail = 'Demo data: a synthetic worker result, not a verification.'; }
    out.push({ role: 'worker', label: worker?.label ?? 'Native worker', model: worker?.model ?? null, route: worker?.route ?? 'unknown', configured: worker !== null, status: workerStatus, detail: workerDetail });
    out.push({
      role: 'dispatch', label: 'Native worker dispatch', model: null, route: 'host', configured: false, status: 'host-only',
      detail: 'Dispatch is performed by the Codex host. The panel shows requests; it never fakes execution.',
    });
    return out;
  }

  // ---------------------------------------------------------------- profiles

  readRequest(profile) {
    const workspace = this.workspaces.get(profile.workspace);
    let bytes;
    try {
      const { data } = readContainedSync(this.roots, profile.request);
      bytes = data;
    } catch {
      return { ok: false, problems: ['The registered request file is not readable inside the workspace.'], sha256: null, request: null };
    }
    let doc;
    try {
      doc = JSON.parse(bytes.toString('utf8'));
    } catch {
      return { ok: false, problems: ['The registered request is not valid JSON.'], sha256: sha256(bytes), request: null };
    }
    const validation = validateLeadRequest(doc, { workspace: workspace.root, mode: profile.mode, canonicalize: canonicalPathSync });
    return { ok: validation.ok, problems: validation.problems.map((p) => clean(p)), sha256: sha256(bytes), request: validation.request, bytes };
  }

  readPrompt(file) {
    try {
      const { data } = readContainedSync(this.roots, file);
      return { ok: true, sha256: sha256(data), bytes: data.length, text: data.toString('utf8'), data };
    } catch {
      return { ok: false, sha256: null, bytes: 0, text: '' };
    }
  }

  gateFor(profile, reviewSnapshot) {
    if (!profile?.requiresApproval) return { reviewId: null, title: null, satisfied: true, enforcement: 'none' };
    const review = reviewSnapshot.find((r) => r.id === profile.requiresApproval);
    return {
      reviewId: review.id,
      title: review.title,
      gate: review.gate,
      satisfied: review.state === REVIEW_STATES.approved,
      state: review.state,
      enforcement: 'controller-enforced',
      appliesTo: 'launch and resume',
    };
  }

  async profileState(profile, reviewSnapshot, { ignoreLease = null } = {}) {
    const gate = this.gateFor(profile, reviewSnapshot);
    const request = this.readRequest(profile);
    const reasons = [];
    if (this.provenance === 'demo') reasons.push('Demo: launching is disabled; demo runs never start paid work.');
    else {
      if (!this.config.launch.enabled) reasons.push('Launching is off in the panel configuration (launch.enabled is false).');
      const lead = this.leadAvailability();
      if (lead.status === 'unavailable') reasons.push(lead.detail);
      if (!request.ok) reasons.push(`The registered request does not validate (${request.problems.length} problem(s)).`);
      if (!this.readPrompt(profile.prompt).ok) reasons.push('The registered prompt is not readable.');
      if (this.activeForProfile(profile.id, { ignoreLease })) reasons.push('A run of this profile is already active or starting.');
      if (!gate.satisfied) reasons.push(`Waiting for approval of “${gate.title}”.`);
    }
    return {
      id: profile.id,
      label: profile.label,
      workspace: this.workspaces.get(profile.workspace)?.label ?? null,
      workspaceId: profile.workspace,
      mode: profile.mode,
      toolProfile: profile.toolProfile,
      model: EXTERNAL_LEAD_MODEL,
      route: LEAD_ROUTE,
      gate,
      activeRun: this.activeForProfile(profile.id, { ignoreLease }),
      requestProblems: request.ok ? [] : request.problems.slice(0, 8),
      launch: { allowed: reasons.length === 0, reasons },
    };
  }

  // What the confirmation dialog shows. The launch call must echo both hashes,
  // so a request or prompt edited after the dialog opened cannot be launched.
  async launchPreview(profileId) {
    const profile = this.getProfile(profileId);
    const reviewSnapshot = await this.reviews.snapshot();
    const state = await this.profileState(profile, reviewSnapshot);
    const request = this.readRequest(profile);
    const prompt = this.readPrompt(profile.prompt);
    return {
      profile: state,
      request: request.ok ? {
        sha256: request.sha256,
        kind: request.request.kind,
        objective: clean(request.request.objective, true).slice(0, 600),
        acceptanceChecks: request.request.acceptanceChecks.length,
        budgetUsd: request.request.budget.usd,
      } : { sha256: request.sha256, problems: request.problems.slice(0, 8) },
      prompt: { sha256: prompt.sha256, bytes: prompt.bytes },
      deadlineSeconds: profile.deadlineSeconds,
      notice: 'Starts one official Claude Code session on your subscription login. The reported cost is a list-price equivalent, not a bill; account quota is not visible here.',
    };
  }

  getProfile(profileId) {
    if (typeof profileId !== 'string' || !this.profiles.has(profileId)) throw new PanelError('unknown_profile', 'Unknown launch profile.', 404);
    return this.profiles.get(profileId);
  }

  newRunDir(profile, suffix = '') {
    const root = this.workspaces.get(profile.workspace).root;
    fs.mkdirSync(profile.runsDir, { recursive: true, mode: 0o700 });
    // Re-check after creation: a symlink planted under the runs directory
    // cannot redirect the run outside the workspace.
    const runsDir = resolveInside([root], profile.runsDir);
    if (runsDir === null || fs.realpathSync(profile.runsDir) !== runsDir) throw new PanelError('outside_roots', 'The runs directory is not inside its workspace.', 403);
    const runId = `${profile.id}${suffix}-${stamp(this.clock())}-${crypto.randomBytes(2).toString('hex')}`.slice(0, 64);
    return { runId, dir: path.join(runsDir, runId), root };
  }

  // Spawn the adapter while holding the profile lease. The lease is released
  // when the child exits (or fails to start), never earlier.
  spawnLead(runId, profile, args, lease) {
    const root = this.workspaces.get(profile.workspace).root;
    const argv = [this.leadCli, ...args];
    if (this.config.launch.claudeBin) argv.push('--claude-bin', this.config.launch.claudeBin);
    const child = this.spawnImpl(process.execPath, argv, { cwd: root, env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const owned = { child, dir: null, profileId: profile.id, startedAt: this.clock().toISOString(), exited: false, exitCode: null, output: '', lease };
    child.stdout?.on('data', (chunk) => { if (owned.output.length < MAX_CHILD_OUTPUT) owned.output += chunk; });
    child.stderr?.on('data', () => {});
    child.on('error', () => { owned.exited = true; this.leases.release(lease); });
    child.on('close', (code) => { owned.exited = true; owned.exitCode = code; this.leases.release(lease); });
    this.owned.set(runId, owned);
    try {
      this.leases.attach(lease, { childPid: child.pid, runId });
    } catch {
      // The lease still names this live controller process, so it stays held.
    }
    return owned;
  }

  recordLaunch(record) {
    this.checkState();
    appendPrivateLine(this.launchFile, `${JSON.stringify({ schemaVersion: 1, at: this.clock().toISOString(), ...record })}\n`);
  }

  // Store the exact confirmed bytes in a new controller-owned directory for
  // this run. The adapter reads these copies, so editing the registered files
  // after confirmation cannot change what runs.
  writeInputs(runId, files) {
    this.checkState();
    const dir = path.join(this.stateDir, 'inputs', runId);
    fs.mkdirSync(dir, { mode: 0o700 });
    ensurePrivateDir(dir, { create: false });
    const out = {};
    for (const [name, data] of Object.entries(files)) {
      out[name] = path.join(dir, name);
      writeExclusiveSync(out[name], data);
    }
    return out;
  }

  async launch({ profileId, confirm, requestSha256, promptSha256 }) {
    if (this.provenance === 'demo') throw new PanelError('demo_readonly', 'Demo runs never launch paid work.', 403);
    const profile = this.getProfile(profileId);
    if (confirm !== true) throw new PanelError('confirmation_required', 'Launching requires explicit confirmation.', 400);
    // Taken synchronously before any await: a second launch or resume of this
    // profile, here or in another panel process, is refused from now on.
    const lease = this.leases.acquire(profile.id, { kind: 'run' });
    try {
      // Gate evidence is hashed from disk now, not taken from a cache.
      const state = await this.profileState(profile, await this.reviews.snapshot({ fresh: true }), { ignoreLease: lease });
      if (!state.launch.allowed) throw new PanelError('launch_refused', state.launch.reasons.join(' '), 403);
      // One read of each file: these bytes are validated, compared with the
      // confirmed hashes, and copied for the adapter. Nothing awaits between
      // here and the spawn.
      const request = this.readRequest(profile);
      const prompt = this.readPrompt(profile.prompt);
      if (!request.ok || !prompt.ok) throw new PanelError('launch_refused', 'The registered request or prompt is not valid now.', 403);
      if (requestSha256 !== request.sha256 || promptSha256 !== prompt.sha256) {
        throw new PanelError('stale_confirmation', 'The request or prompt changed after confirmation. Review it again.', 409);
      }
      const { runId, dir } = this.newRunDir(profile);
      const inputs = this.writeInputs(runId, { 'request.json': request.bytes, 'prompt.txt': prompt.data });
      this.recordLaunch({ runId, profileId: profile.id, dir, kind: 'run' });
      this.spawnLead(runId, profile, [
        'run', '--request', inputs['request.json'], '--prompt', inputs['prompt.txt'], '--out', dir,
        '--mode', profile.mode, '--tool-profile', profile.toolProfile,
        '--workspace', this.workspaces.get(profile.workspace).root,
        '--deadline-seconds', String(profile.deadlineSeconds),
      ], lease);
      return { launched: true, runId };
    } catch (error) {
      this.leases.release(lease);
      throw error;
    }
  }

  // True while the run directory is still the plain directory registered for it.
  runDirIntact(run) {
    try {
      const stat = fs.lstatSync(run.dir);
      return stat.isDirectory() && !stat.isSymbolicLink() && canonicalPathSync(run.dir) === run.dir;
    } catch {
      return false;
    }
  }

  async cancel({ runId }) {
    const run = this.getRun(runId);
    const owned = this.owned.get(run.id);
    if (this.provenance === 'demo') throw new PanelError('demo_readonly', 'Demo runs have no process to cancel.', 403);
    if (!owned) throw new PanelError('not_owned', 'This panel session did not start this run, so it will not cancel it.', 403);
    if (owned.exited) return { cancelled: false, status: 'already-finished' };
    // The control channel lives in the run directory; it is used only while
    // that directory is still the one this controller created.
    const result = this.runDirIntact(run) ? await cancelRun({ runDir: run.dir, waitMs: 8000 }) : { ok: false, status: 'run-dir-changed', reason: 'run directory changed' };
    if (result.ok) return { cancelled: true, status: result.status, via: 'authenticated control channel' };
    // The runner may not have published its control channel yet. The child is
    // this controller's own process handle (never a pid from a file or a
    // request); SIGINT makes lead.mjs abort and stop its own process group.
    if (!owned.exited) {
      owned.child.kill('SIGINT');
      return { cancelled: true, status: 'interrupt-sent', via: 'own child process', detail: clean(result.reason ?? '') };
    }
    return { cancelled: false, status: result.status };
  }

  // Resume eligibility, decided from the run's verified files and a review
  // snapshot hashed from disk now.
  async resumeActions(run, { ignoreLease = null } = {}) {
    const inputs = this.readRunInputs(run);
    const summary = inputs.problem ? null : parseJson(inputs.files['summary.json']);
    const reviews = await this.reviews.snapshot({ fresh: true });
    return this.runActions(run, summary, this.owned.get(run.id) ?? null, reviews, { ignoreLease }).resume;
  }

  async resumePreview(runId) {
    const run = this.getRun(runId);
    const resume = await this.resumeActions(run);
    if (!resume.allowed) return { allowed: false, reason: resume.reason };
    const profile = this.getProfile(run.profileId);
    const composed = await this.composeResumePrompt(profile);
    return {
      allowed: true,
      run: run.id,
      profile: profile.label,
      prompt: { sha256: sha256(composed.text), bytes: Buffer.byteLength(composed.text) },
      feedback: composed.feedback,
      notice: 'Resumes the same Claude session into a new run directory with the stored tool profile. The previous run is never rewritten.',
    };
  }

  async composeResumePrompt(profile) {
    const base = this.readPrompt(profile.resumePrompt);
    if (!base.ok) throw new PanelError('prompt_unreadable', 'The registered resume prompt is not readable.', 409);
    const feedback = profile.feedbackFrom ? await this.reviews.latestFeedback(profile.feedbackFrom) : null;
    const text = feedback
      ? `${base.text.trimEnd()}\n\n## Reviewer feedback recorded in the build panel (revision ${feedback.revision})\n\n${feedback.feedback}\n`
      : base.text;
    return { text, feedback: feedback ? { text: feedback.feedback, revision: feedback.revision } : null };
  }

  async resume({ runId, confirm, promptSha256 }) {
    if (this.provenance === 'demo') throw new PanelError('demo_readonly', 'Demo runs never resume paid work.', 403);
    if (confirm !== true) throw new PanelError('confirmation_required', 'Resuming requires explicit confirmation.', 400);
    const run = this.getRun(runId);
    if (run.origin !== 'controller' || !this.profiles.has(run.profileId)) {
      throw new PanelError('resume_refused', 'Observed only: resume runs the panel did not launch from their own CLI.', 403);
    }
    const profile = this.getProfile(run.profileId);
    // The same lease as launch: a resume and a launch of one profile (here or
    // in another panel process) cannot both start.
    const lease = this.leases.acquire(profile.id, { kind: 'resume' });
    try {
      let resume = await this.resumeActions(run, { ignoreLease: lease });
      if (!resume.allowed) throw new PanelError('resume_refused', resume.reason, 403);
      const composed = await this.composeResumePrompt(profile);
      if (promptSha256 !== sha256(composed.text)) throw new PanelError('stale_confirmation', 'The resume prompt changed after confirmation. Review it again.', 409);
      // Re-decide after the last await, from evidence hashed now: an approval
      // that went stale while the prompt was composed still blocks.
      resume = await this.resumeActions(run, { ignoreLease: lease });
      if (!resume.allowed) throw new PanelError('resume_refused', resume.reason, 403);
      const { runId: next, dir } = this.newRunDir(profile, '-r');
      const inputs = this.writeInputs(next, { 'prompt.txt': Buffer.from(composed.text, 'utf8') });
      this.recordLaunch({ runId: next, profileId: profile.id, dir, kind: 'resume', from: run.id });
      this.spawnLead(next, profile, [
        'resume', '--run', run.dir, '--prompt', inputs['prompt.txt'], '--out', dir,
        '--deadline-seconds', String(profile.deadlineSeconds),
      ], lease);
      return { resumed: true, runId: next, from: run.id };
    } catch (error) {
      this.leases.release(lease);
      throw error;
    }
  }

  // ---------------------------------------------------------------- reviews

  // `expectSha256` (the hash the view's snapshot showed for this side) makes
  // the served image the same revision the evidence hash, and so any decision,
  // refers to.
  async artifact(reviewId, side, expectSha256 = null) {
    const file = await this.reviews.artifactPath(reviewId, side);
    const image = await readImage(this.reviews.roots, file, { exact: file });
    if (expectSha256 !== null && expectSha256 !== undefined && expectSha256 !== image.sha256) {
      throw new PanelError('stale_evidence', 'The image changed since this view loaded. Showing the current revision.', 409);
    }
    return { data: image.data, type: image.type, sha256: image.sha256 };
  }

  async decide({ reviewId, decision, feedback, expectedHash, channel }) {
    if(this.reloadSources)this.refreshSources(this.reloadSources());
    if (this.provenance === 'demo' && channel !== 'demo-ui') throw new PanelError('provenance_mismatch', 'Demo decisions use the demo channel.', 403);
    if (this.provenance === 'real' && channel === 'demo-ui') throw new PanelError('provenance_mismatch', 'Demo decisions cannot touch a real review.', 403);
    return this.reviews.decide({ reviewId, decision, feedback, expectedHash, channel });
  }

  async submitEvidence({ reviewId, actual, note, submittedBy }) {
    if (this.provenance === 'demo' && submittedBy !== 'demo') throw new PanelError('provenance_mismatch', 'Demo evidence is demo-only.', 403);
    if (this.provenance === 'real' && submittedBy === 'demo') throw new PanelError('provenance_mismatch', 'Demo evidence cannot touch a real review.', 403);
    return this.reviews.submitEvidence({ reviewId, actual, note, submittedBy });
  }

  async demoRevise(reviewId) {
    if (this.provenance !== 'demo' || this.demo === null) throw new PanelError('demo_only', 'Only the demo can submit generated evidence.', 403);
    this.reviews.get(reviewId);
    const next = this.demo.nextEvidence(reviewId);
    if (next === null) throw new PanelError('no_demo_revision', 'This demo review has no further revision.', 409);
    return this.reviews.submitEvidence({ reviewId, actual: next, note: 'Demo: generated revision with the card spacing and accent fixed.', submittedBy: 'demo' });
  }

  // ---------------------------------------------------------------- snapshot

  refreshSources(config) {
    if(config.stateDir!==this.config.stateDir)throw new PanelError('state_changed','Reopen the panel to change its state directory.',409);
    this.observationConfig=config;
    this.observedSessions=config.sessions??[];
    this.sessionWorkspaces=config.workspaces;
    this.reviews.reviews=new Map(config.reviews.map(r=>[r.id,r]));
    this.reviews.roots=config.workspaces.map(w=>w.root);
  }

  async snapshot() {
    if(this.reloadSources)this.refreshSources(this.reloadSources());
    const registered=new Map(this.observationConfig.runs.map(r=>[r.id,r]));
    for(const run of this.knownRuns().values())if(run.origin==='controller')registered.set(run.id,run);
    const known=[...registered.values()];
    // A read-only view can follow new registrations without replacing the live
    // controller, owned children, launch profiles or review authorization roots.
    const observer=Object.create(this);
    observer.roots=this.observationConfig.workspaces.map(w=>w.root);
    observer.workspaces=new Map(this.observationConfig.workspaces.map(w=>[w.id,w]));

    const reviews = await this.reviews.snapshot();
    const runs = known.map((run, index) => {
      const described = (run.origin==='controller'?this:observer).describeRun(run, index, reviews);
      described.workerModels = described.workers.map((w) => w.model);
      return described;
    });
    runs.unshift(...await this.sessionObserver.snapshot(this.observedSessions,this.sessionWorkspaces,this.clock));
    const profiles = await Promise.all([...this.profiles.values()].map((p) => this.profileState(p, reviews)));
    const routes = this.routes(runs);
    const workspaceRoutes = Object.fromEntries(this.sessionWorkspaces.map(w => [w.id, this.routes(runs.filter(r => r.workspaceId === w.id))]));
    for (const run of runs) delete run.workerModels;
    const phases = [];
    for (const run of runs) {
      const name = run.phase ?? 'unphased';
      let phase = phases.find((p) => p.name === name);
      if (!phase) phases.push(phase = { name, runs: [] });
      phase.runs.push(run.id);
    }
    return {
      schemaVersion: 1,
      provenance: this.provenance,
      generatedAt: this.clock().toISOString(),
      session: this.session,
      launchEnabled: this.provenance === 'real' && this.config.launch.enabled,
      workspaces: this.sessionWorkspaces.map((w) => ({ id: w.id, label: w.label })),
      routes,
      workspaceRoutes,
      phases,
      runs,
      profiles,
      reviews: reviews.map((review) => ({
        ...review,
        demoRevisionAvailable: this.demo?.hasNextEvidence(review.id) === true,
        gateEnforcement: [...this.profiles.values()].some((p) => p.requiresApproval === review.id)
          ? 'controller-enforced: a registered launch or resume waits for this approval'
          : review.run && this.config.runs.some((r) => r.id === review.run)
            ? 'monitored: the linked run was not started by this panel, so the gate is advisory'
            : 'recorded: no launch depends on this review',
      })),
      coverage: 'Shows explicitly registered sessions, runs, and evidence. Session tool metadata, messages and plans depend on the source log; hidden reasoning and tool-output bodies are excluded. Usage is recorded counters; unknown stays unknown. Subscription list-price equivalents are not bills, and quota is not inferred.',
    };
  }

  close() {
    for (const owned of this.owned.values()) {
      if (!owned.exited) owned.child.kill('SIGINT');
    }
  }
}

// Bounded read for registered text files (request, prompt), pinned to the
// canonical path validated at startup.
function readContainedSync(roots, file) {
  return readVerifiedSync(roots, file, { exact: file, maxBytes: MAX_TEXT_BYTES });
}
