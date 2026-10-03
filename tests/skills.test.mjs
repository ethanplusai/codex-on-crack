import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';
import { validatePlan } from '../plugins/codex-on-crack/skills/crack/scripts/lib/plan.mjs';

const SKILLS = path.join(ROOT, 'plugins', 'codex-on-crack', 'skills');
const NAMES = ['crack', 'crack-plan', 'crack-setup'];

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, 'SKILL.md needs YAML frontmatter');
  return Object.fromEntries(match[1].split('\n').map((line) => {
    const at = line.indexOf(': ');
    return [line.slice(0, at), line.slice(at + 2)];
  }));
}

test('the plugin ships exactly the two pilot skills', () => {
  assert.deepEqual(fs.readdirSync(SKILLS).sort(), [...NAMES].sort());
});

// A skill that links to a moved or wrongly nested file is broken for the reader
// who follows it. Check every relative markdown link resolves on disk instead of
// asserting that particular prose appears.
test('every relative link in a skill file resolves', () => {
  for (const name of NAMES) {
    const dir = path.join(SKILLS, name);
    for (const file of fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.md'))) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const [, target] of text.matchAll(/\]\(([^)\s#]+\.(?:md|mjs|json|yaml|js))\)/g)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const resolved = path.resolve(path.dirname(path.join(dir, file)), target);
        assert.ok(fs.existsSync(resolved), `${name}/${file} links to missing ${target}`);
      }
    }
  }
});

// Reference integrity: a skill may only point at a sibling that actually ships,
// so renaming or dropping a skill cannot leave a dangling handoff behind.
test('every $codex-on-crack:<skill> reference names a shipped skill', () => {
  for (const name of NAMES) {
    const dir = path.join(SKILLS, name);
    const files = fs.readdirSync(dir, { recursive: true }).filter((f) => /\.(md|yaml)$/.test(f));
    for (const file of files) {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const [ref, target] of text.matchAll(/\$codex-on-crack:([a-z-]+)/g)) {
        assert.ok(NAMES.includes(target), `${name}/${file} points at missing skill ${ref}`);
      }
    }
  }
});

for (const name of NAMES) {
  test(`${name}: frontmatter, metadata, and every referenced file exist`, () => {
    const dir = path.join(SKILLS, name);
    const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const meta = frontmatter(text);
    assert.equal(meta.name, name);
    assert.ok(meta.description.length > 40 && meta.description.length <= 1024, 'description length');
    const yaml = fs.readFileSync(path.join(dir, 'agents', 'openai.yaml'), 'utf8');
    assert.match(yaml, /display_name: "/);
    assert.match(yaml, /allow_implicit_invocation: (true|false)/);
    for (const [ref] of text.matchAll(/(?:\.\.\/crack\/)?(?:scripts|templates)\/[\w./-]+\.(?:mjs|md|json)/g)) {
      assert.ok(fs.existsSync(path.join(dir, ref)), `${name} references missing ${ref}`);
    }
    assert.doesNotMatch(text, /\bAstra\b|\bFlash\b|DeepSeek/);
  });
}

// Codex omits a skill with allow_implicit_invocation: false from the model's
// skill list, so asking in plain words never finds it (observed with codex-cli
// 0.155 via `codex debug prompt-input`). Setup is safe to surface: it writes
// nothing until the user confirms.
test('every skill allows implicit invocation, so Codex lists it for the model', () => {
  for (const name of NAMES) {
    assert.match(fs.readFileSync(path.join(SKILLS, name, 'agents', 'openai.yaml'), 'utf8'), /allow_implicit_invocation: true/, name);
  }
});

// Codex namespaces plugin skills as <plugin>:<skill>, so a bare "$crack-plan"
// is not the name the model or the picker sees.
test('skills refer to each other by their namespaced plugin names', () => {
  for (const name of NAMES) {
    const text = fs.readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8');
    const yaml = fs.readFileSync(path.join(SKILLS, name, 'agents', 'openai.yaml'), 'utf8');
    for (const [ref] of `${text}\n${yaml}`.matchAll(/(?<![\w:])\$crack[\w-]*/g)) {
      assert.fail(`${name} uses bare ${ref}; write $codex-on-crack:${ref.slice(1)}`);
    }
  }
});

test('the plan template is schema 2 and fails only on its placeholders', () => {
  const dir = path.join(SKILLS, 'crack', 'templates');
  const template = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  assert.equal(template.schema_version, 2);
  assert.equal(template.tasks[0].role, 'builder');
  assert.throws(() => validatePlan(template, dir, new Map([['builder', { writes: true }]])), /placeholder|existing document/);
});
