#!/usr/bin/env node
// Offline measurement only. Never starts inference or prints transcript text.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {sessionUsage} from '../plugins/codex-on-crack/skills/crack/scripts/lib/report.mjs';

export function summarizeRun(spec, logs, acceptance) {
  if (!spec.id || !spec.condition || !Array.isArray(spec.limitations)) throw new Error('Run needs id, condition and limitations.');
  if (!Number.isInteger(acceptance?.passed) || !Number.isInteger(acceptance.total)
      || acceptance.total < 1 || acceptance.passed < 0 || acceptance.passed > acceptance.total) throw new Error('Invalid acceptance counts.');
  const usage = sessionUsage(logs, spec.root_session);
  const included = new Set(usage.sessions.map(s => s.session_id));
  const seen = new Set();
  let toolCalls = 0;
  const responses = new Set();
  let rootStart = null, rootEnd = null, rootActiveMs = 0, timingComplete = true;
  for (const text of logs) {
    const records = text.split('\n').filter(s => s.trim()).map(JSON.parse);
    const id = records.find(r => r.type === 'session_meta')?.payload.id;
    if (!included.has(id) || seen.has(id)) continue;
    seen.add(id);
    let start = null;
    for (const r of records) {
      const p = r.payload ?? {};
      if (r.type === 'response_item' && ['function_call','custom_tool_call'].includes(p.type)) toolCalls++;
      if (r.type === 'token_usage_record' && p.response_id) responses.add(`${id}:${p.response_id}`);
      if (id !== spec.root_session || r.type !== 'event_msg') continue;
      const time = Date.parse(r.timestamp);
      if (p.type === 'task_started') {
        if (start !== null || !Number.isFinite(time)) timingComplete = false;
        start = time; rootStart ??= time;
      }
      if (['task_complete','turn_aborted'].includes(p.type)) {
        if (start === null || !Number.isFinite(time) || time < start) timingComplete = false;
        else rootActiveMs += time - start;
        rootEnd = time; start = null;
      }
    }
    if (id === spec.root_session && start !== null) timingComplete = false;
  }
  const timed = timingComplete && Number.isFinite(rootStart) && Number.isFinite(rootEnd);
  const totals = usage.totals;
  return {
    schema_version: 1, id: spec.id, condition: spec.condition,
    comparison_eligible: spec.comparison_eligible === true && spec.limitations.length === 0 && spec.descendants_confirmed === true && totals !== null,
    limitations: spec.limitations,
    quality: {functional_checks_passed: acceptance.passed, functional_checks_total: acceptance.total,
      functional_percent: 100 * acceptance.passed / acceptance.total,
      // These require separate, blinded evidence. A passing test suite is not overall quality.
      maintainability_review: spec.maintainability_review ?? null,
      test_mutation_score: spec.test_mutation_score ?? null,
      critical_defects: spec.critical_defects ?? null,
      overall_quality_score: null},
    resources: {...(totals ?? {input_tokens:null,cached_input_tokens:null,uncached_input_tokens:null,output_tokens:null}),
      total_tokens: totals ? totals.input_tokens + totals.output_tokens : null,
      root_elapsed_seconds: timed ? (rootEnd-rootStart)/1000 : null,
      root_active_turn_seconds: timed ? rootActiveMs/1000 : null,
      model_responses_with_usage: responses.size || null,
      tool_calls: toolCalls, delegated_sessions: usage.sessions.length - 1,
      human_interventions: spec.human_interventions ?? null,
      correction_cycles: spec.correction_cycles ?? null,
      billed_cost: null},
    attribution: {root_session:spec.root_session, descendants_confirmed:spec.descendants_confirmed === true,
      sessions:usage.sessions, excluded_unrelated_sessions:usage.excluded_unrelated_sessions,
      log_sha256:logs.map(text=>createHash('sha256').update(text).digest('hex')),
      usage_source:'Client session counters; not quota, billing or service identity verification.'},
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node scripts/study-report.mjs <run-spec.json> <output.json>');
  const spec = JSON.parse(fs.readFileSync(input,'utf8'));
  const logs = spec.session_logs.map(file=>fs.readFileSync(file,'utf8'));
  const acceptance = JSON.parse(fs.readFileSync(spec.acceptance_file,'utf8'));
  const result = summarizeRun(spec,logs,acceptance);
  fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({id:result.id,comparison_eligible:result.comparison_eligible,output:path.resolve(output)}));
}
