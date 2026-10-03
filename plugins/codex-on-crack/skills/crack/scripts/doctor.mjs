#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { CrackError, run } from './lib/io.mjs';
import { doctor } from './lib/readiness.mjs';

const OPTIONS = {
  home: { type: 'string' },
  'codex-home': { type: 'string' },
  profile: { type: 'string' },
};
const USAGE = 'Usage: doctor.mjs [--home dir] [--codex-home dir] [--profile name]';


run((argv) => {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false, strict: true });
  } catch (error) {
    throw new CrackError('usage', error.message, USAGE);
  }
  return doctor(parsed.values);
});
