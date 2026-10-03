import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cli } from './helpers.mjs';
const makeDir = (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crack-trial-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const startArgs = (dir, id = 'first') => ['start', '--dir', dir, '--id', id, '--task', 'Build a fixture', '--mode', 'orchestrated',
  '--category', 'implementation', '--lead-model', 'lead-exact', '--worker-model', 'worker/one', '--worker-model', 'worker/two', '--acceptance', 'Fixture checks pass'];
const finishArgs = (dir, id = 'first') => ['finish', '--dir', dir, '--id', id, '--quality', 'usable', '--checks', 'passed', '--rework-minutes', '2.5', '--notes', 'Human inspected the result'];
const run = (args) => cli('trial.mjs', args);
const get = (dir, id = 'first') => run(['show', '--dir', dir, '--id', id]);
test('trial lifecycle is local, exclusive, readable and immutable after finalization', (t) => {
  const dir = path.join(makeDir(t), 'chosen', 'trials');
  const started = run(startArgs(dir));
  assert.equal(started.status, 0, started.stdout);
  const start = fs.readFileSync(path.join(dir, 'first/start.json'), 'utf8');
  assert.equal(started.json.record.status, 'started');
  assert.equal(started.json.record.finish, null);
  assert.deepEqual(started.json.record.declared_models, { lead: 'lead-exact', workers: ['worker/one', 'worker/two'] });
  assert.ok(started.json.record.package_version);
  assert.equal(run(startArgs(dir)).json.error, 'trial_exists');
  assert.equal(fs.readFileSync(path.join(dir, 'first/start.json'), 'utf8'), start);
  const finished = run(finishArgs(dir));
  assert.equal(finished.status, 0, finished.stdout);
  assert.equal(finished.json.record.finish.usage, null);
  assert.equal(finished.json.record.finish.human_quality, 'usable');
  assert.equal(finished.json.record.finish.rework_minutes, 2.5);
  assert.ok(finished.json.record.finish.elapsed_wall_ms >= 0);
  const end = fs.readFileSync(path.join(dir, 'first/finish.json'), 'utf8');
  assert.equal(run(finishArgs(dir)).json.error, 'trial_finalized');
  assert.equal(fs.readFileSync(path.join(dir, 'first/finish.json'), 'utf8'), end);
  assert.equal(fs.readFileSync(path.join(dir, 'first/start.json'), 'utf8'), start);
  assert.deepEqual(get(dir).json.record, finished.json.record);
  const markdown = run(['show', '--dir', dir, '--id', 'first', '--format', 'markdown']);
  assert.equal(markdown.status, 0); assert.match(markdown.stdout, /# Trial first/);
  assert.match(markdown.stdout, /includes pauses/); assert.match(markdown.stdout, /human reports, not automated/);
  const second = startArgs(dir, 'plain');
  second[second.indexOf('orchestrated')] = 'plain';
  second.splice(second.indexOf('--worker-model'), 4);
  assert.equal(run(second).status, 0);
  const listed = run(['list', '--dir', dir]);
  assert.equal(listed.json.rows.length, 2);
  assert.equal(listed.json.rows[1].observed_usage, null);
  assert.match(listed.json.markdown, /no aggregate savings/);
});
test('trial imports only explicit session files; raw log text is never stored', (t) => {
  const dir = makeDir(t);
  const jsonl = [
    { type: 'session_meta', payload: { id: 'root', model_provider: 'local-route' } },
    { type: 'turn_context', payload: { model: 'observed-other' } },
    { type: 'response_item', payload: { text: 'RAW_PRIVATE_MARKER' } },
    { type: 'event_msg', payload: { type: 'token_usage_record', response_id: 'response', usage: { input_tokens: 12, cached_input_tokens: 2, output_tokens: 3 } } },
  ].map(JSON.stringify).join('\n');
  const log = path.join(dir, 'explicit.jsonl'); fs.writeFileSync(log, jsonl);
  assert.equal(run(startArgs(dir)).status, 0);
  const result = run([...finishArgs(dir), '--root-session', 'root', '--session-log', log, '--session-log', log]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.json.record.finish.usage.totals.input_tokens, 12);
  assert.equal(result.json.record.declared_models.lead, 'lead-exact');
  assert.equal(result.json.record.finish.usage.sessions[0].by_model[0].model, 'observed-other');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'first/finish.json'), 'utf8'), /RAW_PRIVATE_MARKER|explicit.jsonl/);
  assert.doesNotMatch(result.stdout, /RAW_PRIVATE_MARKER/);
});
test('missing imported usage stays unknown and invalid usage does not finalize', (t) => {
  const dir = makeDir(t); run(startArgs(dir));
  const log = path.join(dir, 'log.jsonl');
  fs.writeFileSync(log, JSON.stringify({ type: 'session_meta', payload: { id: 'root' } }));
  assert.equal(run([...finishArgs(dir), '--root-session', 'root']).status, 2);
  assert.equal(run([...finishArgs(dir), '--session-log', log]).status, 2);
  assert.equal(fs.existsSync(path.join(dir, 'first/finish.json')), false);
  const result = run([...finishArgs(dir), '--root-session', 'root', '--session-log', log]);
  assert.equal(result.status, 0, result.stdout); assert.equal(result.json.record.finish.usage.totals, null);
  run(startArgs(dir, 'second'));
  fs.writeFileSync(log, 'INVALID_PRIVATE_CONTENT');
  const invalid = run([...finishArgs(dir, 'second'), '--root-session', 'root', '--session-log', log]);
  assert.equal(invalid.json.error, 'invalid_session_log');
  assert.doesNotMatch(invalid.stdout, /INVALID_PRIVATE_CONTENT/);
  assert.equal(fs.existsSync(path.join(dir, 'second/finish.json')), false);
});
test('trial invalid inputs preserve records and refuse path traversal and inappropriate options', (t) => {
  const dir = makeDir(t);
  const replacements = [['--id', '../escape'], ['--mode', 'auto'], ['--category', 'anything'], ['--lead-model', 'space model'], ['--task', ''], ['--acceptance', '']];
  for (const [key, value] of replacements) {
    const args = startArgs(dir); args[args.indexOf(key) + 1] = value;
    assert.equal(run(args).status, 2, JSON.stringify(args));
  }
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(run([...startArgs(dir), '--quality', 'usable']).json.error, 'usage');
  assert.equal(run([...startArgs(dir), '--format', 'xml']).json.error, 'usage');
  assert.equal(run(startArgs(dir)).status, 0);
  for (const [key, value] of [['--quality', 'great'], ['--checks', 'probably'], ['--rework-minutes', '-1'], ['--rework-minutes', 'NaN'], ['--rework-minutes', 'Infinity']]) {
    const args = finishArgs(dir); args[args.indexOf(key) + 1] = value;
    assert.equal(run(args).status, 2);
    assert.equal(fs.existsSync(path.join(dir, 'first/finish.json')), false);
  }
  assert.equal(run(['finish', '--dir', dir, '--id', 'first']).status, 2);
  assert.equal(get(dir, 'missing').json.error, 'trial_missing');
  assert.equal(run(['list', '--dir', path.join(dir, 'absent')]).json.rows.length, 0);
});
test('trial refuses symlink directories/files and validates finalized linkage', (t) => {
  const dir = makeDir(t); const outside = makeDir(t);
  fs.symlinkSync(outside, path.join(dir, 'linked'));
  assert.equal(run(startArgs(path.join(dir, 'linked'))).json.error, 'symlink_refused');
  assert.equal(run(startArgs(dir, 'linked')).json.error, 'symlink_refused');
  run(startArgs(dir));
  const target = path.join(outside, 'keep'); fs.writeFileSync(target, 'PRESERVE');
  fs.symlinkSync(target, path.join(dir, 'first/finish.json'));
  assert.equal(run(finishArgs(dir)).json.error, 'symlink_refused');
  assert.equal(fs.readFileSync(target, 'utf8'), 'PRESERVE');
  fs.unlinkSync(path.join(dir, 'first/finish.json'));
  assert.equal(run(finishArgs(dir)).status, 0);
  const file = path.join(dir, 'first/start.json');
  const start = JSON.parse(fs.readFileSync(file, 'utf8')); start.task = 'Tampered'; fs.writeFileSync(file, JSON.stringify(start));
  assert.equal(get(dir).json.error, 'invalid_trial');
});
test('system temporary directory aliases are accepted without following user symlinks', (t) => {
  const dir = makeDir(t);
  const alias = process.platform === 'darwin' ? dir.replace(/^\/private\/var\//, '/var/').replace(/^\/private\/tmp\//, '/tmp/') : dir;
  assert.equal(run(startArgs(alias)).status, 0);
});

test('intended efforts remain optional declarations and repeated worker efforts must align', (t) => {
  const dir = makeDir(t);
  const defaulted = run(startArgs(dir));
  assert.deepEqual(defaulted.json.record.declared_efforts, { lead: null, workers: [null, null] });
  const explicit = run([...startArgs(dir, 'efforts'), '--lead-effort', 'xhigh', '--worker-effort', 'high', '--worker-effort', 'low']);
  assert.equal(explicit.status, 0, explicit.stdout);
  assert.deepEqual(explicit.json.record.declared_efforts, { lead: 'xhigh', workers: ['high', 'low'] });
  assert.match(explicit.json.markdown, /worker\/one \(effort: high\)/);
  const listed = run(['list', '--dir', dir]);
  assert.equal(listed.json.rows.find((row) => row.id === 'efforts').declared_efforts.lead, 'xhigh');
  assert.match(listed.json.markdown, /effort: xhigh/);
  assert.equal(run([...startArgs(dir, 'mismatch'), '--worker-effort', 'high']).json.error, 'invalid_trial');
  assert.equal(run([...startArgs(dir, 'invalid'), '--lead-effort', 'HIGH']).json.error, 'invalid_trial');
  assert.equal(fs.existsSync(path.join(dir, 'mismatch')), false);
});
