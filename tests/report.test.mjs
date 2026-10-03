import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cli, makeHome } from './helpers.mjs';
import { routerUsage, summarizePlan } from '../plugins/codex-on-crack/skills/crack/scripts/lib/report.mjs';

const LOG = [
  '[codex-router] timing at=2026-09-21T04:37:45.165Z model=deepseek/deepseek-v4.1-flash provider=deepseek status=200 total_ms=5199 upstream_ms=3127 out_tokens=466 cached_tokens=320000',
  '[codex-router] timing at=2026-09-21T05:00:00.000Z model=deepseek/deepseek-v4.1-flash provider=deepseek status=500 total_ms=10 upstream_ms=5 out_tokens=0 cached_tokens=0',
  '[codex-router] Native catalog drift detected and republished automatically.',
  '[codex-router] timing at=2026-09-21T06:00:00.000Z model=anthropic-api/claude-opus-4.8 provider=anthropic status=200 total_ms=9 upstream_ms=8 out_tokens=100 cached_tokens=50',
].join('\n');

const PLAN = {
  tasks: [
    { id: 'T1', role: 'builder', state: 'accepted', review_cycles: 1 },
    { id: 'T2', role: 'builder', state: 'accepted', rung: 'fallback', review_cycles: 2 },
    { id: 'T3', role: 'designer', state: 'blocked', rung: 'orchestrator' },
  ],
};

test('summarizePlan counts outcomes, escalations, and review cycles', () => {
  assert.deepEqual(summarizePlan(PLAN).totals, {
    tasks: 3, accepted: 2, blocked: 1, escalated_to_fallback: 1, taken_over_by_orchestrator: 1, review_cycles: 3,
  });
  assert.equal(summarizePlan(PLAN).tasks[0].rung, 'primary');
});

test('routerUsage totals real requests per model, counts errors, and honors since', () => {
  assert.deepEqual(routerUsage(LOG), {
    'deepseek/deepseek-v4.1-flash': { provider: 'deepseek', requests: 2, errors: 1, out_tokens: 466, cached_tokens: 320000 },
    'anthropic-api/claude-opus-4.8': { provider: 'anthropic', requests: 1, errors: 0, out_tokens: 100, cached_tokens: 50 },
  });
  assert.deepEqual(Object.keys(routerUsage(LOG, '2026-09-21T05:30:00Z')), ['anthropic-api/claude-opus-4.8']);
  assert.throws(() => routerUsage(LOG, 'yesterday'), { code: 'usage' });
});

test('report CLI labels usage by source, and reports none without a router log', (t) => {
  const h = makeHome(t);
  const plan = h.write('plan.json', JSON.stringify(PLAN));
  const none = cli('report.mjs', ['--plan', plan, ...h.args]);
  assert.equal(none.status, 0, none.stdout);
  assert.equal(none.json.usage, null);
  h.write('codex-router/router.log', LOG);
  const r = cli('report.mjs', ['--plan', plan, '--since', '2026-09-21T05:30:00Z', '--router-log', path.join(h.codexHome, 'codex-router/router.log'), ...h.args]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.usage, null);
  assert.equal(r.json.diagnostic_router_usage.source, 'codex-router log');
  assert.deepEqual(Object.keys(r.json.diagnostic_router_usage.by_model), ['anthropic-api/claude-opus-4.8']);
  assert.equal(cli('report.mjs', [...h.args]).json.error, 'usage');
});

test('report CLI reads a plan reached through a symlinked directory', (t) => {
  const h = makeHome(t);
  const plan = h.write('runs/plan.json', JSON.stringify(PLAN));
  fs.symlinkSync(path.dirname(plan), path.join(h.home, 'runs-link'));
  const r = cli('report.mjs', ['--plan', path.join(h.home, 'runs-link', 'plan.json'), ...h.args]);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.totals.tasks, 3);
});
