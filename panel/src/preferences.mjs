// View preferences for the panel: harmless display choices only. They are
// never credentials, models, workspaces, roots, launch permissions, or review
// decisions, and nothing outside the view reads them.
//
// Stored as one small JSON file in the controller's private state directory,
// read through the same verified path as every other state file and replaced
// atomically (exclusive temporary file, then rename) after the state
// directory is re-checked.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PanelError, readVerifiedSync, writeExclusiveSync } from './paths.mjs';

export const PREFERENCE_VIEWS = Object.freeze(['overview', 'review', 'usage']);
export const PREFERENCE_COMPARE = Object.freeze(['side-by-side', 'overlay']);
export const DEFAULT_PREFERENCES = Object.freeze({ defaultView: 'overview', showCompletedRuns: true, compareMode: 'side-by-side' });
const VALID = {
  defaultView: (value) => PREFERENCE_VIEWS.includes(value),
  showCompletedRuns: (value) => typeof value === 'boolean',
  compareMode: (value) => PREFERENCE_COMPARE.includes(value),
};
const FILE = 'preferences.json';
const MAX_BYTES = 4096;

// Defaults with every valid known field of `doc` applied; anything else is ignored.
export function normalizePreferences(doc) {
  const out = { ...DEFAULT_PREFERENCES };
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return out;
  for (const [key, valid] of Object.entries(VALID)) if (Object.hasOwn(doc, key) && valid(doc[key])) out[key] = doc[key];
  return out;
}

// A requested change must name only known fields with valid values.
export function checkPreferenceSet(set) {
  if (set === null || typeof set !== 'object' || Array.isArray(set) || Object.keys(set).length === 0) {
    throw new PanelError('preferences_invalid', 'Set at least one view preference.', 400);
  }
  for (const [key, value] of Object.entries(set)) {
    if (!Object.hasOwn(VALID, key)) throw new PanelError('preferences_invalid', 'That is not a view preference.', 400);
    if (!VALID[key](value)) throw new PanelError('preferences_invalid', `The value for ${key} is not allowed.`, 400);
  }
  return set;
}

// Missing, unreadable, unsafe (symlink, oversized, not a file), or malformed
// files all read as defaults: a view preference is never worth an error.
export function readPreferences(stateDir) {
  const file = path.join(stateDir, FILE);
  try {
    const { data } = readVerifiedSync([stateDir], file, { exact: file, maxBytes: MAX_BYTES });
    return normalizePreferences(JSON.parse(data.toString('utf8')));
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

// Apply `set` to the stored preferences for a configured controller and
// return every effective value. Synchronous, so two updates in one process
// cannot interleave between read and replace.
export function writePreferences(controller, set) {
  checkPreferenceSet(set);
  controller.checkState();
  const dir = controller.stateDir;
  const next = { ...readPreferences(dir), ...set };
  const tmp = path.join(dir, `.${FILE}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    writeExclusiveSync(tmp, `${JSON.stringify({ schemaVersion: 1, ...next })}\n`);
    fs.renameSync(tmp, path.join(dir, FILE));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return readPreferences(dir);
}
