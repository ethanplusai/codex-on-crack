// TOML via the vendored smol-toml parser, plus string escaping for files we write.
import { parse } from './vendor/smol-toml/index.js';
import { CrackError } from './io.mjs';

const DEL = new RegExp(String.fromCharCode(127), 'g');

export function parseToml(text, label) {
  try {
    return parse(text);
  } catch {
    // Parser errors quote source lines, which can hold secrets. Never echo them.
    throw new CrackError('invalid_toml', `Cannot read valid TOML from ${label}.`,
      `Fix the TOML syntax in ${label}, then retry.`);
  }
}

// JSON string escaping is valid TOML basic-string escaping, except that TOML
// forbids a raw DEL character, which JSON leaves unescaped.
export function tomlString(value) {
  return JSON.stringify(String(value)).replace(DEL, '\\u007F');
}
