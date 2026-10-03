#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { CrackError, failure } from './lib/io.mjs';
import { trial } from './lib/trial.mjs';
const COMMON = ['dir', 'format'];
const ALLOWED = {
  start: [...COMMON, 'id', 'task', 'mode', 'category', 'lead-model', 'worker-model', 'lead-effort', 'worker-effort', 'acceptance'],
  finish: [...COMMON, 'id', 'quality', 'checks', 'rework-minutes', 'notes', 'root-session', 'session-log'],
  show: [...COMMON, 'id'], list: COMMON,
};
const USAGE = 'Usage: trial.mjs <start|finish|show|list> --dir DIR [--id ID] [--format json|markdown]. Start: --task TEXT --mode plain|orchestrated --category CATEGORY --lead-model MODEL [--lead-effort EFFORT] [--worker-model MODEL ...] [--worker-effort EFFORT ...] --acceptance TEXT. Finish: --quality usable|needs-fixes|unusable --checks passed|failed|not-run --rework-minutes N [--notes TEXT] [--root-session ID --session-log PATH ...].';
let result; let format = 'json';
try {
  const [command, ...args] = process.argv.slice(2);
  if (!ALLOWED[command]) throw new CrackError('usage', 'Choose start, finish, show, or list.', USAGE);
  let values;
  try { ({ values } = parseArgs({ args, strict: true, options: Object.fromEntries(ALLOWED[command].map((key) => [key,
    { type: 'string', ...(['worker-model', 'worker-effort', 'session-log'].includes(key) ? { multiple: true } : {}) }])) })); }
  catch { throw new CrackError('usage', 'Invalid trial arguments.', USAGE); }
  format = values.format ?? 'json';
  if (!['json', 'markdown'].includes(format)) throw new CrackError('usage', '--format must be json or markdown.', USAGE);
  result = trial(command, values);
} catch (error) { result = failure(error); }
process.stdout.write(result.ok && format === 'markdown' ? `${result.markdown}\n` : `${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.ok ? 0 : 2;
