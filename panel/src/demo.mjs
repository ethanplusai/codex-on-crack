// A permanently labelled demo: synthetic run directories and generated
// wireframes in a private temporary directory. They flow through the same
// bridge, reducer, and review store as real runs, but under a separate state
// directory with provenance "demo", launching disabled, and a demo-only
// decision channel. Nothing here reads a real project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXTERNAL_LEAD_MODEL } from '../../plugins/codex-on-crack/skills/crack/scripts/lib/external-lead.mjs';
import { validatePanelConfig } from './config.mjs';
import { Canvas } from './png.mjs';

const VIOLET = [124, 92, 214];
const INK = [44, 46, 54];
const MUTED = [214, 216, 224];
const SURFACE = [246, 246, 250];
const WORKER_MODEL = 'deepseek/deepseek-v4.1-flash';

// A small dashboard wireframe. `variant` shifts the parts a reviewer should notice.
function wireframe(variant) {
  const c = new Canvas(640, 400, [255, 255, 255]);
  c.rect(0, 0, 640, 52, SURFACE);
  c.rect(20, 18, 96, 16, INK, 4);
  c.rect(520, 14, 100, 24, variant === 'drift' ? [222, 92, 74] : VIOLET, 8);
  c.rect(0, 52, 150, 348, SURFACE);
  for (let i = 0; i < 5; i += 1) c.rect(20, 80 + i * 36, i === 0 ? 110 : 90, 14, i === 0 ? VIOLET : MUTED, 4);
  const cardY = variant === 'drift' ? 92 : 80;
  const gap = variant === 'drift' ? 8 : 20;
  for (let i = 0; i < 3; i += 1) {
    const x = 172 + i * (140 + gap);
    c.rect(x, cardY, 140, 96, [250, 250, 253], 10);
    c.rect(x + 14, cardY + 16, 70, 10, MUTED, 3);
    c.rect(x + 14, cardY + 40, 50, 22, INK, 4);
  }
  c.rect(172, 200, 448, 176, [250, 250, 253], 12);
  for (let i = 0; i < 4; i += 1) c.rect(192, 222 + i * 36, variant === 'drift' && i === 2 ? 240 : 400, 14, MUTED, 4);
  return c.png();
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, data, { mode: 0o600 });
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const jsonl = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

function event(base, type, at, extra = {}) {
  return { schemaVersion: 1, eventId: `demo-${type}-${at}`, ...base, type, at, atSource: 'receive-time', ...extra };
}

function makeRun(dir, { agentId, parentAgentId = null, phase, mode, startedAt, endedAt = null, sessionId, tools, ok = true, usage = null, durationApiMs = null, extraEvents = [] }) {
  const ids = { runId: `demo-${phase}`, agentId, parentAgentId, phase, mode, requestedModel: EXTERNAL_LEAD_MODEL, route: 'subscription' };
  write(path.join(dir, 'run.json'), json({
    schemaVersion: 3, mode, model: EXTERNAL_LEAD_MODEL, route: 'subscription', toolProfile: 'files',
    identity: { runId: ids.runId, agentId, parentAgentId, requestId: `demo-req-${phase}`, phase, mode, toolProfile: 'files' },
    startedAt,
  }));
  const t = (offsetSeconds) => new Date(Date.parse(startedAt) + offsetSeconds * 1000).toISOString();
  const events = [
    event(ids, 'agent.created', t(0), { data: { sessionId } }),
    event(ids, 'agent.started', t(1), { data: {} }),
    event(ids, 'model.observed', t(2), { observedModel: EXTERNAL_LEAD_MODEL, data: {} }),
  ];
  tools.forEach((name, index) => {
    events.push(event(ids, 'tool.started', t(20 + index * 45), { data: { toolName: name } }));
    events.push(event(ids, 'tool.finished', t(30 + index * 45), { data: { toolName: name, isError: false } }));
  });
  events.push(...extraEvents.map((e) => event(ids, e.type, t(e.offset), e.extra)));
  if (!endedAt && usage) events.push(event(ids, 'usage.recorded', t(25 + tools.length * 45), { data: { usageScope: 'session' }, usage: { [EXTERNAL_LEAD_MODEL]: usage } }));
  if (endedAt) events.push(event(ids, ok ? 'agent.returned' : 'agent.failed', endedAt, { data: {} }));
  write(path.join(dir, 'events.public.jsonl'), jsonl(events));
  if (endedAt) {
    write(path.join(dir, 'summary.json'), json({
      schemaVersion: 1, ok, mode, toolProfile: 'files', failureKind: ok ? null : 'run_failed', sessionId,
      runId: ids.runId, agentId, parentAgentId, phase, startedAt, endedAt,
      wallDurationMs: Date.parse(endedAt) - Date.parse(startedAt),
      result: { durationApiMs },
      modelUsage: usage ? { [EXTERNAL_LEAD_MODEL]: { ...usage, costUSD: 1.84 } } : null,
      usage: { billing: 'not-billed-via-api', billedUsd: null, equivalentUsd: 1.84, accountQuota: null },
      errors: [],
    }));
  }
}

export function createDemo({ clock = () => new Date(), base = os.tmpdir() } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(base, 'crack-panel-demo-')));
  const workspace = path.join(root, 'workspace');
  const now = clock().getTime();
  const iso = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();

  write(path.join(workspace, 'evidence', 'design-reference.png'), wireframe('reference'));
  write(path.join(workspace, 'evidence', 'design-actual-r1.png'), wireframe('drift'));
  write(path.join(workspace, 'evidence', 'design-actual-r2.png'), wireframe('reference'));
  write(path.join(workspace, 'evidence', 'final-reference.png'), wireframe('reference'));

  const designDir = path.join(workspace, 'runs', 'design-lead');
  makeRun(designDir, {
    agentId: 'design-lead', phase: 'design', mode: 'solo', startedAt: iso(58), endedAt: iso(41), sessionId: 'demo-session-design',
    tools: ['Read', 'Read', 'Grep', 'Write', 'Edit'],
    usage: { inputTokens: 18_420, outputTokens: 6_310, cacheReadInputTokens: 212_800, cacheCreationInputTokens: 24_100 },
    durationApiMs: 412_000,
  });
  const implDir = path.join(workspace, 'runs', 'implementation-lead');
  makeRun(implDir, {
    agentId: 'implementation-lead', phase: 'implementation', mode: 'external-lead', startedAt: iso(14), sessionId: 'demo-session-impl',
    tools: ['Read', 'Glob', 'Edit', 'Edit', 'Write'],
    usage: { inputTokens: 9_870, outputTokens: 2_940, cacheReadInputTokens: 96_300 },
    extraEvents: [
      { type: 'request.validated', offset: 260, extra: { status: 'pending', data: { kind: 'worker_assignment', action: 'native_worker_dispatch', executor: 'codex-host' } } },
      { type: 'worker.result', offset: 420, extra: { agentId: 'builder', status: 'completed', observedModel: WORKER_MODEL, data: { observedModel: WORKER_MODEL } } },
    ],
  });

  write(path.join(workspace, 'requests', 'implementation.json'), json({
    schemaVersion: 1, requestId: 'demo-req-impl', runId: 'demo-implementation', phase: 'implementation', kind: 'host_validation',
    agentId: 'implementation-lead', parentAgentId: null, objective: 'Demo: implement the approved dashboard layout.',
    workspace, acceptanceChecks: ['Layout matches the approved design'], checks: ['Layout matches the approved design'],
    budget: { authorized: true, usd: 0 }, lead: { id: 'implementation-lead', model: EXTERNAL_LEAD_MODEL, route: 'subscription' },
  }));
  write(path.join(workspace, 'requests', 'implementation.txt'), 'Demo prompt. This file is never sent anywhere.\n');

  const doc = {
    schemaVersion: 1,
    stateDir: path.join(root, 'state'),
    workspaces: [{ id: 'demo', root: workspace, label: 'Demo workspace' }],
    runs: [
      { id: 'design-lead', dir: designDir, label: 'Design lead', workspace: 'demo' },
      { id: 'implementation-lead', dir: implDir, label: 'Implementation lead', workspace: 'demo' },
    ],
    routes: {
      host: { label: 'Codex host', model: 'gpt-6-astra', route: 'host' },
      worker: { label: 'Builder', model: WORKER_MODEL, route: 'router' },
    },
    reviews: [
      {
        id: 'design', title: 'Dashboard layout', gate: 'early-design', workspace: 'demo', run: 'design-lead',
        reference: path.join(workspace, 'evidence', 'design-reference.png'),
        actual: path.join(workspace, 'evidence', 'design-actual-r1.png'),
        checks: ['Three summary cards share one row with even spacing', 'Primary action uses the violet accent', 'List rows span the content width'],
      },
      {
        id: 'final', title: 'Final build', gate: 'final', workspace: 'demo', run: 'implementation-lead',
        reference: path.join(workspace, 'evidence', 'final-reference.png'), actual: null,
        checks: ['Matches the approved layout in the running app'],
      },
    ],
    launch: {
      enabled: false,
      profiles: [{
        id: 'implementation', label: 'Implementation lead', workspace: 'demo',
        request: path.join(workspace, 'requests', 'implementation.json'),
        prompt: path.join(workspace, 'requests', 'implementation.txt'),
        runsDir: path.join(workspace, 'runs', 'launched'), mode: 'solo', requiresApproval: 'design',
      }],
    },
  };
  let revised = false;
  const result = validatePanelConfig(doc);
  if (!result.ok) throw new Error(`demo configuration invalid: ${result.problems.join('; ')}`);
  return {
    root,
    config: result.config,
    // The only demo mutation besides decisions: submit the next generated
    // revision, so the stale-approval path can be exercised without real work.
    hasNextEvidence(reviewId) {
      return reviewId === 'design' && !revised;
    },
    nextEvidence(reviewId) {
      if (!this.hasNextEvidence(reviewId)) return null;
      revised = true;
      return path.join(workspace, 'evidence', 'design-actual-r2.png');
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
