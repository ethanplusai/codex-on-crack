import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHome, cli, catalogEntry, ROLES_TOML, DEFAULT_CONFIG } from './helpers.mjs';
import { applyChanges, planChanges, undoReceipt } from '../plugins/codex-on-crack/skills/crack/scripts/lib/changes.mjs';
import { MARKER } from '../plugins/codex-on-crack/skills/crack/scripts/lib/roles.mjs';
const nativeDraft = 'schema_version=1\n[roles.builder]\nmodel="gpt-6-sol"\nwrites=true\nbrief="Fixture"\n';
const setup = (h,...a) => cli('setup.mjs',[...a,...h.args]);

test('native routes reject incompatible parent, endpoint and metadata without writing', (t) => {
  for (const config of [
    'model_provider="custom"\nmodel_catalog_json="catalog.json"\n',
    'openai_base_url="https://example.invalid/v1"\nmodel_catalog_json="catalog.json"\n',
    'model_catalog_json="catalog.json"\n[model_providers.openai]\nbase_url="https://example.invalid/v1"\n',
  ]) {
    const h=makeHome(t,{config,catalog:{models:[catalogEntry('gpt-6-sol')]},routerAgents:false});
    const draft=h.write('draft.toml',nativeDraft); const before=h.snapshot();
    assert.equal(setup(h,'apply','--roles',draft).json.error,'provider_incompatible');
    assert.deepEqual(h.snapshot(),before);
  }
});
test('doctor catches inline role conflicts after installation', (t) => {
  const h=makeHome(t); assert.equal(setup(h,'apply','--roles',h.write('draft.toml',ROLES_TOML)).status,0);
  h.write('config.toml',DEFAULT_CONFIG+'\n[agents.crack_builder]\nconfig_file="other.toml"\n');
  const r=cli('doctor.mjs',h.args);
  assert.equal(r.status,2); assert.ok(r.json.problems.some(p=>p.code==='role_conflict'));
});
test('legacy migration is explicit, keeps unrelated rules and reverses exactly', (t) => {
  const h=makeHome(t); const old='User rules\n<!-- BEGIN astra-flash-orchestrator managed policy -->\nold\n<!-- END astra-flash-orchestrator managed policy -->\n';
  h.write('AGENTS.md',old); const draft=h.write('draft.toml',ROLES_TOML);
  assert.equal(setup(h,'apply','--roles',draft).json.error,'legacy_policy_active');
  assert.equal(h.read('AGENTS.md'),old);
  const r=setup(h,'apply','--roles',draft,'--migrate-legacy'); assert.equal(r.status,0,r.stdout);
  assert.equal(h.read('AGENTS.md'),'User rules\n');
  assert.equal(setup(h,'undo','--receipt',r.json.receipt,'--apply').status,0);
  assert.equal(h.read('AGENTS.md'),old);
});
test('multiple same-second updates and reverse undos preserve ownership', (t) => {
  const h=makeHome(t); const file=path.join(h.codexHome,'agents/crack_builder.toml');
  const text=m=>`${MARKER}\nmodel="${m}"\n`;
  const receipts=['a','b','c'].map(m=>applyChanges(h.codexHome,planChanges(h.codexHome,new Map([[file,text(m)]]))));
  undoReceipt(h.codexHome,receipts[2],{apply:true});undoReceipt(h.codexHome,receipts[1],{apply:true});
  assert.equal(fs.readFileSync(file,'utf8'),text('a'));
  const next=applyChanges(h.codexHome,planChanges(h.codexHome,new Map([[file,text('d')]])));
  assert.ok(next);assert.equal(fs.readFileSync(file,'utf8'),text('d'));
});
test('native setup supports missing config and retains offline export for doctor', (t) => {
  const h=makeHome(t,{config:null,catalog:null,routerAgents:false});
  const exported=h.write('export.json',JSON.stringify({models:[catalogEntry('gpt-6-sol')]}));
  const r=setup(h,'apply','--roles',h.write('draft.toml',nativeDraft),'--model-catalog',exported);
  assert.equal(r.status,0,r.stdout);assert.equal(h.exists('config.toml'),false);
  h.write('models_cache.json','{"models":[]}');
  assert.equal(cli('doctor.mjs',h.args).status,0);
  assert.equal(setup(h,'apply').status,0);
});
test('chosen profile survives optionless regeneration', (t) => {
  const h=makeHome(t,{config:'model_provider="incompatible"\nmodel_catalog_json="catalog.json"\n',catalog:{models:[catalogEntry('gpt-6-sol')]},routerAgents:false});
  h.write('native.config.toml','model_provider="openai"\n');
  const r=setup(h,'apply','--roles',h.write('draft.toml',nativeDraft),'--profile','native');
  assert.equal(r.status,0,r.stdout);assert.equal(setup(h,'apply').status,0);
  assert.equal(cli('doctor.mjs',h.args).json.profile,'native');
});

test('a setup lock refuses concurrent mutation and preserves files', (t) => {
  const h=makeHome(t);const draft=h.write('draft.toml',ROLES_TOML);
  fs.mkdirSync(path.join(h.codexHome,'crack-backups/.lock'),{recursive:true});
  const before=h.snapshot();const r=setup(h,'apply','--roles',draft);
  assert.equal(r.json.error,'setup_locked');assert.deepEqual(h.snapshot(),before);
});
test('migration moves the new policy to the active override without duplication', (t) => {
  const h=makeHome(t);const draft=h.write('draft.toml',ROLES_TOML);
  assert.equal(setup(h,'apply','--roles',draft,'--policy').status,0);
  h.write('AGENTS.override.md','Override rules\n');
  const r=setup(h,'apply','--policy');assert.equal(r.status,0,r.stdout);
  assert.doesNotMatch(h.read('AGENTS.md'),/BEGIN codex-on-crack/);
  assert.match(h.read('AGENTS.override.md'),/^Override rules\n/);
  assert.match(h.read('AGENTS.override.md'),/BEGIN codex-on-crack/);
});
test('read-only symlinked native configuration remains supported', (t) => {
  const h=makeHome(t,{config:'model_catalog_json="catalog.json"\n',catalog:{models:[catalogEntry('gpt-6-sol')]},routerAgents:false});
  fs.renameSync(path.join(h.codexHome,'config.toml'),path.join(h.codexHome,'actual.toml'));
  fs.symlinkSync('actual.toml',path.join(h.codexHome,'config.toml'));
  const r=setup(h,'apply','--roles',h.write('draft.toml',nativeDraft));assert.equal(r.status,0,r.stdout);
  assert.ok(fs.lstatSync(path.join(h.codexHome,'config.toml')).isSymbolicLink());
});
test('failed undo restores already-processed files and leaves receipt retryable', (t) => {
  const h=makeHome(t);const a=path.join(h.codexHome,'agents/crack_a.toml');const b=path.join(h.codexHome,'agents/crack_b.toml');
  const text=v=>`${MARKER}\nmodel="${v}"\n`;
  applyChanges(h.codexHome,planChanges(h.codexHome,new Map([[a,text('old')],[b,text('old')]])));
  const receipt=applyChanges(h.codexHome,planChanges(h.codexHome,new Map([[a,text('new')],[b,text('new')]])));
  const original=fs.renameSync;
  const mocked=t.mock.method(fs,'renameSync',(from,to)=>{if(to===b)throw new Error('fixture write failure');return original(from,to);});
  assert.throws(()=>undoReceipt(h.codexHome,receipt,{apply:true}),/fixture write failure/);
  mocked.mock.restore();
  assert.equal(fs.readFileSync(a,'utf8'),text('new'));assert.equal(fs.readFileSync(b,'utf8'),text('new'));
  assert.equal(JSON.parse(fs.readFileSync(receipt)).status,'applied');
  assert.doesNotThrow(()=>undoReceipt(h.codexHome,receipt,{apply:true}));
});
