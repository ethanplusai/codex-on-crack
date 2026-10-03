import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {connectSession} from '../src/connect.mjs';
import {loadPanelConfig,validatePanelConfig} from '../src/config.mjs';
import {PanelController} from '../src/controller.mjs';
const row=(type,payload,n=0)=>JSON.stringify({type,payload,timestamp:`2026-10-02T00:00:${String(n).padStart(2,'0')}.000Z`})+'\n';
function setup(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'panel-session-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const workspace=path.join(dir,'project');fs.mkdirSync(workspace);const file=path.join(dir,'session.jsonl');fs.writeFileSync(file,row('session_meta',{id:'private-thread',cwd:workspace}));return {dir,workspace,file,configPath:path.join(dir,'panel.json')};}
test('host-only session appears before delegation, tails activity and counters without double counting',async t=>{
 const f=setup(t);connectSession({...f,details:true,label:'Creative research'});
 fs.appendFileSync(f.file,row('turn_context',{model:'gpt-6-astra'},1)+row('event_msg',{type:'task_started'},2)+row('response_item',{type:'function_call',name:'update_plan',call_id:'plan',arguments:JSON.stringify({plan:[{step:'Study references',status:'in_progress'}]})},3)+row('response_item',{type:'function_call_output',call_id:'plan',output:'done'},4)+row('token_usage_record',{thread_token_usage:{input_tokens:100,cached_input_tokens:80,output_tokens:10}},5));
 const c=new PanelController({config:loadPanelConfig(f.configPath),doctor:()=>({})});t.after(()=>c.close());
 let s=await c.snapshot();assert.equal(s.runs.length,1);const r=s.runs[0];assert.equal(r.kind,'session');assert.equal(r.state,'running-observed');assert.equal(r.model,'gpt-6-astra');assert.equal(r.plan[0].step,'Study references');assert.equal(r.actions.cancel.allowed,false);assert.equal(r.usage.models[0].inputTokens,20);assert.equal(r.usage.models[0].cacheReadInputTokens,80);assert.ok(r.activity.some(a=>a.type==='tool.finished'));assert.ok(!JSON.stringify(s).includes(f.file));assert.ok(!JSON.stringify(s).includes('private-thread'));
 await Promise.all([c.snapshot(),c.snapshot()]);s=await c.snapshot();assert.equal(s.runs[0].usage.models[0].outputTokens,10);
 fs.appendFileSync(f.file,row('event_msg',{type:'item_completed',item:{type:'McpToolCall',id:'browser',tool:'browser',status:'completed',arguments:'SECRET',result:'SECRET'}},6)+row('event_msg',{type:'task_complete'},7));
 s=await c.snapshot();assert.equal(s.runs[0].state,'idle');assert.ok(s.runs[0].activity.some(e=>e.text.includes('browser')));assert.ok(!JSON.stringify(s).includes('SECRET'));
 fs.unlinkSync(f.file);fs.symlinkSync('/etc/passwd',f.file);s=await c.snapshot();assert.equal(s.runs[0].state,'unavailable');assert.ok(s.runs[0].errors.length);
});
test('connect preserves config, validates workspace identity and refuses symlink sources',t=>{
 const f=setup(t);connectSession(f);const before=loadPanelConfig(f.configPath);connectSession({...f,label:'Host'});const after=loadPanelConfig(f.configPath);assert.deepEqual(before.launch,after.launch);assert.equal(after.sessions.length,1);assert.ok(fs.readdirSync(f.dir).some(n=>n.includes('before-connect')));
 assert.throws(()=>connectSession({...f,workspace:f.dir}),/match/);
 const link=path.join(f.dir,'link.jsonl');fs.symlinkSync(f.file,link);assert.throws(()=>connectSession({...f,file:link}),/canonical/);
 const raw=JSON.parse(fs.readFileSync(f.configPath));raw.sessions[0].command='echo bad';assert.equal(validatePanelConfig(raw).ok,false);
});
