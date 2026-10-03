// Local, append-only pilot records. No session discovery or provider calls.
import fs from 'node:fs';
import path from 'node:path';
import { CrackError, readIfExists, readInput, refuseSymlinks, sha256 } from './io.mjs';
import { TASK_CATEGORIES } from './roles.mjs';
import { sessionUsage } from './report.mjs';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,255}$/;
const bad = (message) => new CrackError('invalid_trial', message, 'Check the trial arguments or inspect the local record.');
const requireText = (value, label, max = 10000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\x00/.test(value)) throw bad(`${label} must be nonempty text of at most ${max} characters.`);
  return value;
};
const member = (value, choices, label) => {
  if (!choices.includes(value)) throw bad(`${label} must be one of: ${choices.join(', ')}.`);
  return value;
};
const model = (value) => {
  if (typeof value !== 'string' || !MODEL.test(value)) throw bad('Supply an exact model identifier without whitespace.');
  return value;
};
function effort(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[a-z][a-z_]{0,31}$/.test(value)) throw bad('Intended effort must be a lowercase effort name.');
  return value;
}
function intendedEfforts(values, workers) {
  const declared = values['worker-effort'];
  if (declared !== undefined && declared.length !== workers.length) throw bad('--worker-effort values must align one-for-one with --worker-model values.');
  return { lead: effort(values['lead-effort']), workers: workers.map((_, index) => effort(declared?.[index])) };
}
function minutes(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) > Number.MAX_SAFE_INTEGER) {
    throw bad('--rework-minutes must be a nonnegative finite number.');
  }
  return Number(value);
}
function directory(value) {
  requireText(value, '--dir', 4096);
  let target = path.resolve(value);
  // Only macOS's system aliases are resolved. User-planted symlinks, including
  // the chosen directory itself and record files, remain forbidden.
  if (process.platform === 'darwin') for (const prefix of ['/tmp', '/var']) {
    if (target === prefix || target.startsWith(`${prefix}/`)) target = path.join(fs.realpathSync(prefix), target.slice(prefix.length));
  }
  refuseSymlinks(target);
  return target;
}
function recordPath(dir, id) {
  if (typeof id !== 'string' || !ID.test(id)) throw bad('--id must be 1-80 letters, digits, underscores, or hyphens, starting with a letter or digit.');
  const result = path.join(dir, id);
  refuseSymlinks(result);
  return result;
}
function exclusive(file, object) {
  refuseSymlinks(file);
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new CrackError('trial_exists', 'The trial record already exists or is finalized.', 'Existing records are never overwritten. Choose a new trial ID.');
    throw error;
  }
  try { fs.writeFileSync(fd, `${JSON.stringify(object, null, 2)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function decode(data) {
  try { return JSON.parse(data.toString('utf8')); } catch { throw bad('A trial record is not valid JSON.'); }
}
function readRecord(dir, id) {
  const folder = recordPath(dir, id);
  const startData = readIfExists(path.join(folder, 'start.json'));
  if (!startData) throw new CrackError('trial_missing', 'The requested trial does not exist.', 'Use trial.mjs list to see saved trials.');
  const start = decode(startData);
  if (start.schema_version !== 1 || start.id !== id || !Number.isFinite(Date.parse(start.started_at))) throw bad('Invalid start record identity, schema, or timestamp.');
  requireText(start.task, 'task'); requireText(start.acceptance, 'acceptance'); requireText(start.package_version, 'package_version', 100);
  member(start.mode, ['plain', 'orchestrated'], 'mode'); member(start.category, TASK_CATEGORIES, 'category');
  model(start.declared_models?.lead);
  if (!Array.isArray(start.declared_models.workers)) throw bad('Invalid declared worker models.');
  start.declared_models.workers.forEach(model);
  const declaredEfforts = start.declared_efforts ?? { lead: null, workers: start.declared_models.workers.map(() => null) };
  effort(declaredEfforts.lead);
  if (!Array.isArray(declaredEfforts.workers) || declaredEfforts.workers.length !== start.declared_models.workers.length) throw bad('Invalid declared worker efforts.');
  declaredEfforts.workers.forEach(effort);
  const finishData = readIfExists(path.join(folder, 'finish.json'));
  const finish = finishData === null ? null : decode(finishData);
  if (finish) {
    if (finish.schema_version !== 1 || finish.start_sha256 !== sha256(startData) || finish.id !== id
        || !Number.isFinite(Date.parse(finish.finished_at)) || Date.parse(finish.finished_at) < Date.parse(start.started_at)
        || finish.elapsed_wall_ms !== Date.parse(finish.finished_at) - Date.parse(start.started_at)) throw bad('The finalized record does not match its start record.');
    member(finish.human_quality, ['usable', 'needs-fixes', 'unusable'], 'quality');
    member(finish.checks, ['passed', 'failed', 'not-run'], 'checks');
    if (!Number.isFinite(finish.rework_minutes) || finish.rework_minutes < 0) throw bad('Invalid rework minutes.');
    if (typeof finish.notes !== 'string' || finish.notes.length > 10000) throw bad('Invalid notes.');
    if (finish.usage !== null && (typeof finish.usage !== 'object' || finish.usage?.source !== 'Codex session JSONL')) throw bad('Invalid imported usage.');
  }
  return { ...start, declared_efforts: declaredEfforts, status: finish ? 'finished' : 'started', finish };
}
const escape = (value) => String(value ?? 'unknown').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '\\|').replaceAll('\n', ' ');
function markdown(record) {
  const end = record.finish;
  return [`# Trial ${escape(record.id)}`, '', `Task: ${escape(record.task)}`, '',
    `Mode: ${record.mode}; category: ${record.category}; status: ${record.status}.`,
    `Declared lead: ${escape(record.declared_models.lead)} (effort: ${escape(record.declared_efforts.lead)}). Declared workers: ${record.declared_models.workers.map((value, index) => `${escape(value)} (effort: ${escape(record.declared_efforts.workers[index])})`).join(', ') || 'none'}.`, '',
    `Acceptance: ${escape(record.acceptance)}`, '', `Started: ${record.started_at}. Package version: ${escape(record.package_version)}.`,
    ...(end ? [`Finished: ${end.finished_at}. Elapsed wall time: ${(end.elapsed_wall_ms / 60000).toFixed(2)} minutes (includes pauses).`,
      `Human quality: ${end.human_quality}. Checks reported: ${end.checks}. Rework: ${end.rework_minutes} minutes.`,
      `Notes: ${escape(end.notes)}`, `Observed client usage: ${end.usage?.totals ? JSON.stringify(end.usage.totals) : 'unknown'}.`] : []), '',
    'Quality and checks are human reports, not automated verification. Declared models and efforts are intended choices, not capability or configuration proof; imported client labels are observations, not serving identity proof.',
    'Missing usage stays unknown. Supplied exports may omit descendants. Wall time and token counts do not establish savings, cost, or causal quality differences.', ''].join('\n');
}
export function trial(command, values) {
  const dir = directory(values.dir);
  if (command === 'start') {
    const folder = recordPath(dir, values.id);
    const version = JSON.parse(fs.readFileSync(new URL('../../../../.codex-plugin/plugin.json', import.meta.url), 'utf8')).version;
    const record = { schema_version: 1, id: values.id, package_version: version,
      task: requireText(values.task, '--task'), mode: member(values.mode, ['plain', 'orchestrated'], '--mode'),
      category: member(values.category, TASK_CATEGORIES, '--category'),
      declared_models: { lead: model(values['lead-model']), workers: (values['worker-model'] ?? []).map(model) },
      acceptance: requireText(values.acceptance, '--acceptance'), started_at: new Date().toISOString() };
    record.declared_efforts = intendedEfforts(values, record.declared_models.workers);
    if (record.mode === 'plain' && record.declared_models.workers.length) throw bad('Plain mode cannot declare worker models.');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    refuseSymlinks(dir);
    try { fs.mkdirSync(folder, { mode: 0o700 }); }
    catch (error) {
      if (error.code === 'EEXIST') throw new CrackError('trial_exists', 'This trial ID already exists.', 'Choose a new ID; existing records are preserved.');
      throw error;
    }
    exclusive(path.join(folder, 'start.json'), record);
  } else if (command === 'finish') {
    const existing = readRecord(dir, values.id);
    if (existing.finish) throw new CrackError('trial_finalized', 'This trial is already finalized.', 'Finalized records cannot be changed by this tool.');
    const logs = values['session-log'] ?? [];
    if (Boolean(values['root-session']) !== Boolean(logs.length)) throw bad('--root-session and at least one --session-log must be supplied together.');
    const usage = logs.length ? sessionUsage(logs.map((file) => {
      const data = readInput(file);
      if (!data) throw new CrackError('session_missing', 'A supplied session export is missing.', 'Check the input path.');
      return data.toString('utf8');
    }), values['root-session']) : null;
    const finished = new Date().toISOString();
    const record = { schema_version: 1, id: values.id,
      start_sha256: sha256(readIfExists(path.join(recordPath(dir, values.id), 'start.json'))),
      finished_at: finished, elapsed_wall_ms: Date.parse(finished) - Date.parse(existing.started_at),
      human_quality: member(values.quality, ['usable', 'needs-fixes', 'unusable'], '--quality'),
      checks: member(values.checks, ['passed', 'failed', 'not-run'], '--checks'), rework_minutes: minutes(values['rework-minutes']),
      notes: values.notes === undefined ? '' : requireText(values.notes, '--notes'), usage };
    if (record.elapsed_wall_ms < 0) throw bad('The clock precedes the start time; cannot finalize.');
    exclusive(path.join(recordPath(dir, values.id), 'finish.json'), record);
  } else if (command !== 'show' && command !== 'list') throw bad('Unknown trial command.');
  if (command === 'list') {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') entries = []; else throw error; }
    const records = entries.filter((entry) => ID.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
      if (entry.isSymbolicLink()) throw bad('A symlink exists in the trial directory.');
      if (!entry.isDirectory()) return [];
      if (readIfExists(path.join(dir, entry.name, 'start.json')) === null) return [];
      return [readRecord(dir, entry.name)];
    });
    const rows = records.map((record) => ({ id: record.id, task: record.task, category: record.category, mode: record.mode,
      declared_models: record.declared_models, declared_efforts: record.declared_efforts, status: record.status, human_quality: record.finish?.human_quality ?? null,
      checks: record.finish?.checks ?? null, elapsed_wall_minutes: record.finish ? record.finish.elapsed_wall_ms / 60000 : null,
      rework_minutes: record.finish?.rework_minutes ?? null, observed_usage: record.finish?.usage?.totals ?? null }));
    return { ok: true, rows, markdown: ['| ID | Task | Category | Mode | Declared lead | Declared workers | Quality (human) | Checks (reported) | Wall minutes | Rework minutes | Usage |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...rows.map((row) => `| ${[row.id, row.task, row.category, row.mode, `${row.declared_models.lead} (effort: ${row.declared_efforts.lead ?? 'unknown'})`, row.declared_models.workers.map((value, index) => `${value} (effort: ${row.declared_efforts.workers[index] ?? 'unknown'})`).join(', ') || 'none', row.human_quality, row.checks,
        row.elapsed_wall_minutes === null ? null : row.elapsed_wall_minutes.toFixed(2), row.rework_minutes,
        row.observed_usage ? JSON.stringify(row.observed_usage) : null].map(escape).join(' | ')} |`), '',
      'Human reports are not automated evidence. Wall time includes pauses; no aggregate savings or quality ranking is inferred.'].join('\n') };
  }
  const record = readRecord(dir, values.id);
  return { ok: true, record, markdown: markdown(record) };
}
