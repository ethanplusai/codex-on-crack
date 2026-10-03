import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.mjs';
import { inventory, selected, buildArchive, isEntrypoint } from '../scripts/release.mjs';

function tree(t, files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crack-release-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test('selected ships plugin, marketplace, and vendored LICENSE files, and skips private ones', (t) => {
  const root = tree(t, {
    'README.md': 'r',
    'VERSION': '2.0.0\n',
    'plugins/codex-on-crack/.codex-plugin/plugin.json': '{}',
    'plugins/codex-on-crack/skills/crack/scripts/lib/vendor/smol-toml/LICENSE': 'bsd',
    'plugins/codex-on-crack/skills/crack/scripts/lib/vendor/smol-toml/index.js': 'x',
    '.agents/plugins/marketplace.json': '{}',
    '.agents/sessions/2026-09-21-note.md': 'private',
    '.agents/memory.md': 'private',
    'docs/superpowers/plans/plan.md': 'internal',
    'docs/BENCHMARK.md': 'b',
    'experimental/skills/crack-review/SKILL.md': 'preserved, not shipped',
    'tests/x.test.mjs': 't',
    'plugins/codex-on-crack/receipt.json': '{}',
    'plugins/codex-on-crack/notes.before-edit.md': 'backup',
    'plugins/codex-on-crack/.DS_Store': 'junk',
  });
  assert.deepEqual(selected(root), [
    '.agents/plugins/marketplace.json',
    'README.md',
    'VERSION',
    'docs/BENCHMARK.md',
    'plugins/codex-on-crack/.codex-plugin/plugin.json',
    'plugins/codex-on-crack/skills/crack/scripts/lib/vendor/smol-toml/LICENSE',
    'plugins/codex-on-crack/skills/crack/scripts/lib/vendor/smol-toml/index.js',
    'tests/x.test.mjs',
  ]);
});

test('inventory hashes content, so any change makes it stale', (t) => {
  const root = tree(t, { 'README.md': 'one' });
  const before = inventory(root);
  assert.match(before, /^[0-9a-f]{64} {2}README\.md\n$/);
  fs.writeFileSync(path.join(root, 'README.md'), 'two');
  assert.notEqual(inventory(root), before);
});

test('selected refuses a symlink inside the distribution', (t) => {
  const root = tree(t, { 'docs/real.md': 'r' });
  fs.symlinkSync(path.join(root, 'docs', 'real.md'), path.join(root, 'docs', 'link.md'));
  assert.throws(() => selected(root), /Symlink in distribution: docs\/link\.md/);
});


test('built archive contains exactly the inventory plus manifest, never internal tracked notes', (t) => {
  const root = tree(t, { 'README.md':'public', 'docs/superpowers/private.md':'internal', 'VERSION':'2.0.0' });
  fs.writeFileSync(path.join(root,'MANIFEST.sha256'),inventory(root));
  const output=path.join(root,'dist/test.tar.gz');
  buildArchive(root,output);
  const files=execFileSync('tar',['-tzf',output],{encoding:'utf8'}).trim().split('\n').sort();
  assert.deepEqual(files,[...selected(root),'MANIFEST.sha256'].sort());
  fs.appendFileSync(path.join(root,'README.md'),'changed');
  assert.throws(()=>buildArchive(root,output),/stale/);
});

// Regression: `node --input-type=module -` sets argv[1] to "-", which sent the
// old realpathSync guard into ENOENT and crashed every such import. Importing
// the module must stay side-effect free for stdin, real, and absent argv paths.
test('importing release.mjs runs no CLI and tolerates stdin, missing, or other argv paths', (t) => {
  const moduleUrl = pathToFileURL(path.join(ROOT, 'scripts', 'release.mjs')).href;
  const source = `import { inventory } from ${JSON.stringify(moduleUrl)};\nprocess.stdout.write(typeof inventory);\n`;
  const manifest = path.join(ROOT, 'MANIFEST.sha256');
  const before = fs.readFileSync(manifest);
  const missing = path.join(os.tmpdir(), 'crack-not-a-real-entrypoint.mjs');

  // argv[1] === '-' from stdin input.
  const viaStdin = spawnSync(process.execPath, ['--input-type=module', '-'], { input: source, encoding: 'utf8' });
  assert.equal(viaStdin.status, 0, viaStdin.stderr);
  assert.equal(viaStdin.stdout, 'function');
  assert.equal(viaStdin.stderr, '');

  // argv[1] names a path that does not exist (positional args after -e land in argv).
  const viaMissing = spawnSync(process.execPath, ['--input-type=module', '-e', source, missing], { encoding: 'utf8' });
  assert.equal(viaMissing.status, 0, viaMissing.stderr);
  assert.equal(viaMissing.stdout, 'function');

  // The guard itself: only this file, resolved through a real path, is the entrypoint.
  assert.equal(isEntrypoint(['node', missing], moduleUrl), false);
  assert.equal(isEntrypoint(['node', '-'], moduleUrl), false);
  assert.equal(isEntrypoint(['node'], moduleUrl), false);
  assert.equal(isEntrypoint(['node', path.join(ROOT, 'scripts', 'release.mjs')], moduleUrl), true);

  // argv[1] names a different real file.
  const wrapper = tree(t, { 'wrapper.mjs': source });
  const viaFile = spawnSync(process.execPath, [path.join(wrapper, 'wrapper.mjs')], { encoding: 'utf8' });
  assert.equal(viaFile.status, 0, viaFile.stderr);
  assert.equal(viaFile.stdout, 'function');

  assert.deepEqual(fs.readFileSync(manifest), before, 'an import must not rewrite the release inventory');
});


test('approved README animation is included in the release inventory', t => {
 const root=tree(t,{'docs/media/panel-demo.gif':'GIF89a','docs/media/panel-review.jpg':'synthetic image','docs/capture.webm':'private source recording'});
 assert.deepEqual(selected(root),['docs/media/panel-demo.gif','docs/media/panel-review.jpg']);
});

// Legacy installers must survive the root archive without shipping runtime caches.
test('release inventory retains the relocated legacy installer and its manifest', (t) => {
  const root = tree(t, {
    'legacy/astra-flash-orchestrator/install.py': '# installer',
    'legacy/astra-flash-orchestrator/install_opencode.py': '# opencode',
    'legacy/astra-flash-orchestrator/VERSION': '1.2.0',
    'legacy/astra-flash-orchestrator/MANIFEST.sha256': 'inventory',
    'legacy/astra-flash-orchestrator/.gitignore': '__pycache__/',
    'legacy/astra-flash-orchestrator/tests/test_opencode.py': '# regression',
    'legacy/astra-flash-orchestrator/__pycache__/temp.pyc': 'cache',
  });
  const files = selected(root);
  assert.equal(files.length, 6);
  assert.ok(files.includes('legacy/astra-flash-orchestrator/install_opencode.py'));
  assert.ok(files.includes('legacy/astra-flash-orchestrator/MANIFEST.sha256'));
});
