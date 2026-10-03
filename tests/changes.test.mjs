import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHome } from './helpers.mjs';
import {
  POLICY_BEGIN, POLICY_END, applyChanges, isManagedPath, ledger, managedPaths, managedPolicy, planChanges,
  policyBlock, undoReceipt,
} from '../plugins/codex-on-crack/skills/crack/scripts/lib/changes.mjs';
import { sha256 } from '../plugins/codex-on-crack/skills/crack/scripts/lib/io.mjs';
import { MARKER } from '../plugins/codex-on-crack/skills/crack/scripts/lib/roles.mjs';

const agentText = (body) => `${MARKER} test\n${body}\n`;
const builderFile = (h) => path.join(h.codexHome, 'agents', 'crack_builder.toml');

test('isManagedPath allows only crack.toml, crack_* agent files, and the AGENTS policy files', (t) => {
  const { codexHome } = makeHome(t);
  const at = (rel) => path.join(codexHome, rel);
  assert.equal(isManagedPath(codexHome, at('crack/crack.toml')), true);
  assert.equal(isManagedPath(codexHome, at('agents/crack_builder.toml')), true);
  assert.equal(isManagedPath(codexHome, at('AGENTS.md')), true);
  assert.equal(isManagedPath(codexHome, at('AGENTS.override.md')), true);
  assert.equal(isManagedPath(codexHome, at('config.toml')), false);
  assert.equal(isManagedPath(codexHome, at('agents/router-model-x.toml')), false);
  assert.equal(isManagedPath(codexHome, at('agents/astra_flash_builder.toml')), false);
  assert.equal(isManagedPath(codexHome, at('agents/sub/crack_x.toml')), false);
});

test('planChanges refuses config.toml even when asked', (t) => {
  const h = makeHome(t);
  assert.throws(() => planChanges(h.codexHome, new Map([[path.join(h.codexHome, 'config.toml'), 'x = 1\n']])),
    { code: 'unmanaged_path' });
});

test('applyChanges creates files with a receipt, and a repeat is a no-op', (t) => {
  const h = makeHome(t);
  const requested = new Map([[builderFile(h), agentText('model = "a"')]]);
  const changes = planChanges(h.codexHome, requested);
  assert.deepEqual(changes.map((c) => c.action), ['create']);
  const receipt = applyChanges(h.codexHome, changes);
  assert.equal(fs.readFileSync(builderFile(h), 'utf8'), agentText('model = "a"'));
  const record = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  assert.equal(record.status, 'applied');
  assert.equal(record.kind, 'codex-on-crack');
  assert.deepEqual(planChanges(h.codexHome, requested), []);
  assert.equal(applyChanges(h.codexHome, []), null);
});

test('planChanges updates or deletes our own unedited agent files', (t) => {
  const h = makeHome(t);
  applyChanges(h.codexHome, planChanges(h.codexHome, new Map([[builderFile(h), agentText('model = "a"')]])));
  assert.deepEqual(planChanges(h.codexHome, new Map([[builderFile(h), agentText('model = "b"')]])).map((c) => c.action), ['update']);
  assert.deepEqual(planChanges(h.codexHome, new Map([[builderFile(h), null]])).map((c) => c.action), ['delete']);
  assert.deepEqual(planChanges(h.codexHome, new Map([[path.join(h.codexHome, 'agents', 'crack_gone.toml'), null]])), []);
});

test('planChanges refuses a foreign or edited agent file, and a foreign crack.toml', (t) => {
  const h = makeHome(t);
  h.write('agents/crack_builder.toml', 'name = "mine"\n');
  assert.throws(() => planChanges(h.codexHome, new Map([[builderFile(h), agentText('x = 1')]])), { code: 'foreign_file' });
  fs.rmSync(builderFile(h));
  applyChanges(h.codexHome, planChanges(h.codexHome, new Map([[builderFile(h), agentText('model = "a"')]])));
  fs.appendFileSync(builderFile(h), '# my edit\n');
  assert.throws(() => planChanges(h.codexHome, new Map([[builderFile(h), agentText('model = "b"')]])), { code: 'edited_file' });
  h.write('crack/crack.toml', 'schema_version = 1\n');
  assert.throws(() => planChanges(h.codexHome, new Map([[managedPaths(h.codexHome).crackToml, `${MARKER}\n`]])),
    { code: 'foreign_file' });
});

test('applyChanges checks inputs, then rolls back earlier writes when a later one fails', (t) => {
  const h = makeHome(t);
  const config = path.join(h.codexHome, 'config.toml');
  assert.throws(() => applyChanges(h.codexHome, planChanges(h.codexHome, new Map([[builderFile(h), agentText('a')]])),
    { [config]: 'stale-hash' }), { code: 'inputs_changed' });
  const good = path.join(h.codexHome, 'agents', 'crack_a.toml');
  h.write('blocker', 'a regular file');
  const bad = path.join(h.codexHome, 'blocker', 'crack_b.toml');
  const changes = [
    { path: good, action: 'create', before: null, after: Buffer.from('a'), mode: 0o600 },
    { path: bad, action: 'create', before: null, after: Buffer.from('b'), mode: 0o600 },
  ];
  assert.throws(() => applyChanges(h.codexHome, changes));
  assert.equal(fs.existsSync(good), false);
  const dirs = fs.readdirSync(path.join(h.codexHome, 'crack-backups'));
  const statuses = dirs.map((d) => JSON.parse(fs.readFileSync(path.join(h.codexHome, 'crack-backups', d, 'receipt.json'), 'utf8')).status);
  assert.deepEqual(statuses, ['rolled-back']);
});

test('undoReceipt previews, then restores and removes exactly what apply changed', (t) => {
  const h = makeHome(t);
  const policyFile = h.write('AGENTS.md', '# mine\n');
  const requested = new Map([[builderFile(h), agentText('model = "a"')], [policyFile, managedPolicy('# mine\n', policyBlock())]]);
  const receipt = applyChanges(h.codexHome, planChanges(h.codexHome, requested));
  const preview = undoReceipt(h.codexHome, receipt);
  assert.equal(preview.applied, false);
  assert.deepEqual(preview.actions.map((a) => a.action).sort(), ['remove', 'restore']);
  assert.equal(fs.existsSync(builderFile(h)), true);
  undoReceipt(h.codexHome, receipt, { apply: true });
  assert.equal(fs.existsSync(builderFile(h)), false);
  assert.equal(h.read('AGENTS.md'), '# mine\n');
  assert.throws(() => undoReceipt(h.codexHome, receipt, { apply: true }), { code: 'receipt_not_undoable' });
});

test('undoReceipt refuses edits made after apply, and receipts outside crack-backups', (t) => {
  const h = makeHome(t);
  const receipt = applyChanges(h.codexHome, planChanges(h.codexHome, new Map([[builderFile(h), agentText('model = "a"')]])));
  fs.appendFileSync(builderFile(h), '# edit\n');
  assert.throws(() => undoReceipt(h.codexHome, receipt, { apply: true }), { code: 'edited_since' });
  const outside = h.write('receipt.json', '{}');
  assert.throws(() => undoReceipt(h.codexHome, outside), { code: 'receipt_outside' });
});

test('ledger tracks what we last wrote, and what an undo restored', (t) => {
  const h = makeHome(t);
  const receipt = applyChanges(h.codexHome, planChanges(h.codexHome, new Map([[builderFile(h), agentText('model = "a"')]])));
  assert.equal(ledger(h.codexHome).get(builderFile(h)), sha256(Buffer.from(agentText('model = "a"'))));
  undoReceipt(h.codexHome, receipt, { apply: true });
  assert.equal(ledger(h.codexHome).get(builderFile(h)), null);
});

test('managedPolicy appends once, replaces in place, keeps CRLF, and refuses broken markers', () => {
  const block = policyBlock();
  assert.ok(block.trim().startsWith(POLICY_BEGIN) && block.trim().endsWith(POLICY_END));
  const once = managedPolicy('# mine\n', block);
  assert.ok(once.startsWith('# mine\n\n<!-- BEGIN'));
  assert.equal(managedPolicy(once, block), once);
  assert.equal(managedPolicy('', block), `${block.trimEnd()}\n`);
  assert.ok(managedPolicy('# mine\r\n', block).includes('\r\n<!-- BEGIN'));
  assert.throws(() => managedPolicy(`${POLICY_BEGIN}\n`, block), { code: 'policy_markers_malformed' });
});
