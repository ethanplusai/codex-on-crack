import test from 'node:test';import assert from 'node:assert/strict';
import {Adapter} from '../src/adapter.mjs';import {reduceEvents,validateEvent,safeReplay,safeModelLabel} from '../src/model.mjs';
const at='2026-09-28T12:00:00Z',later='2026-09-28T12:05:00Z',last='2026-09-28T12:09:00Z';
const u=(i,o,cr=0,cc=0)=>({inputTokens:i,outputTokens:o,cacheReadInputTokens:cr,cacheCreationInputTokens:cc});
const ev=(eventId,type,data,agentId='lead',time=at)=>({schemaVersion:1,eventId,agentId,parentAgentId:null,at:time,type,data});
const msg=(id,messageId,usage,model='claude-opus-4-1',time=at)=>ev(id,'usage.recorded',{scope:'message',counterKind:'per-message-snapshot',completeness:'provisional',messageId,model,usage,summary:'SECRET reasoning',note:'SECRET /Users/someone/x',provenance:'claude-jsonl'},'lead',time);
const final=(id,usage,model='claude-opus-4-1',time=later)=>ev(id,'usage.recorded',{scope:'session',counterKind:'authoritative-total',completeness:'final',model,usage},'lead',time);
function normalized(records,details=false){const a=new Adapter({source:'n',normalized:true,details});records.forEach((r,i)=>a.ingest(r,i+1));return a}
const record=(type,payload,timestamp=at)=>({type,payload,timestamp});
const tc=(input,cached,output)=>record('event_msg',{type:'token_count',info:{total_token_usage:{input_tokens:input,cached_input_tokens:cached,output_tokens:output,reasoning_output_tokens:5,total_tokens:input+output},last_token_usage:{input_tokens:1,output_tokens:1}},rate_limits:{}});

test('repeated message snapshots and duplicate events are not double counted',()=>{
  const a=normalized([msg('1','m1',u(10,1,100,5)),msg('2','m1',u(10,40,100,5)),msg('3','m1',u(10,40,100,5)),msg('4','m2',u(3,7))]);
  assert.equal(a.errors,0);const lead=reduceEvents([...a.events,...a.events])[0];
  assert.deepEqual(lead.usage.usage,u(13,47,100,5));assert.equal(lead.usage.completeness,'provisional');assert.equal(lead.model,'claude-opus-4-1');
  assert(!JSON.stringify(a.events).includes('SECRET'));assert(!JSON.stringify(a.events).includes('m1'));
});
test('session final total supersedes message totals and is never visible before its replay time',()=>{
  const a=normalized([ev('0','agent.started',{}),msg('1','m1',u(10,40,100,5)),final('2',u(20,60,150,5)),msg('3','m1',u(10,45,100,5),undefined,last),msg('4','m3',u(1,1),undefined,last)]);
  assert.equal(a.errors,0);
  const before=reduceEvents(a.events.slice(0,2))[0];
  assert.deepEqual(before.usage.usage,u(10,40,100,5));assert.equal(before.usage.completeness,'provisional');assert.equal(before.last,at);assert(!JSON.stringify(before.usage).includes('150'));
  const atFinal=reduceEvents(a.events.slice(0,3))[0];
  assert.deepEqual(atFinal.usage.usage,u(20,60,150,5));assert.equal(atFinal.usage.completeness,'final');
  // A later snapshot of an already counted message is not added; a genuinely new message is.
  const after=reduceEvents(a.events)[0];assert.deepEqual(after.usage.usage,u(21,61,150,5));assert.equal(after.usage.completeness,'provisional');
});
test('usage is segmented per model',()=>{
  const a=normalized([msg('1','m1',u(10,40)),msg('2','m2',u(5,5,50),'claude-haiku-4-5'),final('3',u(12,44,1))]);
  const usage=reduceEvents(a.events)[0].usage;
  assert.deepEqual(usage.models.find(m=>m.model==='claude-opus-4-1'),{model:'claude-opus-4-1',usage:u(12,44,1),completeness:'final',basis:'Session total'});
  assert.deepEqual(usage.models.find(m=>m.model==='claude-haiku-4-5').usage,u(5,5,50));
  assert.deepEqual(usage.usage,u(17,49,51));assert.equal(usage.completeness,'provisional');
});
test('Codex token_count splits cached input out of input and ignores repeated cumulative records',()=>{
  const a=new Adapter({source:'root'});a.ingest(record('session_meta',{id:'root',source:'cli'}),1);
  a.ingest(record('turn_context',{model:'gpt-5-codex'}),2);a.ingest(tc(1000,800,50),3);a.ingest(tc(1000,800,50),4);
  a.ingest(record('event_msg',{type:'token_count',info:null,rate_limits:{}}),5);
  a.ingest(record('turn_context',{model:'gpt-5'}),6);a.ingest(tc(2500,2000,90),7);
  assert.equal(a.errors,0);assert.equal(a.events.filter(e=>e.type==='usage.recorded').length,4);
  const usage=reduceEvents(a.events)[0].usage;
  // Total input (fresh + cache read) equals input_tokens; reasoning tokens are already inside output_tokens.
  assert.deepEqual(usage.usage,u(500,90,2000));assert.equal(usage.usage.inputTokens+usage.usage.cacheReadInputTokens,2500);
  assert.deepEqual(usage.models.find(m=>m.model==='gpt-5-codex').usage,u(200,50,800));
  assert.deepEqual(usage.models.find(m=>m.model==='gpt-5').usage,u(300,40,1200));
  a.ingest(tc(10,20,1),8);a.ingest(tc('3000',0,0),9);a.ingest(tc(3000.5,0,0),10);a.ingest(tc(-1,0,0),11);
  assert.equal(a.errors,4);assert.deepEqual(reduceEvents(a.events)[0].usage.usage,u(500,90,2000));
});
test('malformed usage payloads are rejected by the adapter and by import validation',()=>{
  const base={scope:'message',counterKind:'per-message-snapshot',completeness:'provisional',messageId:'m'};
  const bad=[{...base,usage:u(-1,0)},{...base,usage:u(1.5,0)},{...base,usage:{inputTokens:'10'}},{...base,usage:u(1e20,0)},{...base,usage:{}},{...base,usage:null},{...base,usage:[1]},
    {...base,scope:'turn',usage:u(1,1)},{...base,counterKind:'guess',usage:u(1,1)},{...base,completeness:'done',usage:u(1,1)},{...base,messageId:undefined,usage:u(1,1)},{...base,messageId:7,usage:u(1,1)}];
  const a=normalized(bad.map((d,i)=>ev(`b${i}`,'usage.recorded',d)));assert.equal(a.errors,bad.length);assert.equal(a.events.length,0);
  for(const d of [...bad,{...base,usage:{inputTokens:NaN}},{...base,usage:{inputTokens:Infinity}},{...base,usage:{...u(1,1),extra:2}},{...base,usage:u(1,1),model:5}])assert.throws(()=>validateEvent(ev('x','usage.recorded',d)));
  assert.doesNotThrow(()=>validateEvent(ev('ok','usage.recorded',{...base,usage:{outputTokens:0}})));
});
test('typed metadata on normalized events is projected rather than rejected',()=>{
  const a=normalized([ev('1','agent.created',{title:'SECRET',depth:2,tags:['x']}),ev('2','activity.reported',{text:'SECRET',durationMs:40}),ev('3','model.observed',{model:'claude-opus-4-1',contextWindow:200000}),ev('4','usage.recorded',{scope:'session',counterKind:'authoritative-total',completeness:'final',usage:{...u(1,2),serviceTier:'standard'},costUsd:0.1})]);
  assert.equal(a.errors,0);assert.equal(a.events.length,4);assert(!JSON.stringify(a.events).includes('SECRET'));assert(!JSON.stringify(a.events).includes('costUsd'));
  assert.deepEqual(reduceEvents(a.events)[0].usage.usage,u(1,2));
});
test('safe export keeps model labels and usage numbers but strips text, paths and credentials',()=>{
  const events=[ev('1','agent.created',{title:'SECRET',assignment:'SECRET /Users/someone/x'}),ev('2','model.observed',{model:'claude-opus-4-1'}),ev('3','activity.reported',{text:'SECRET'}),
    {...ev('4','agent.created',{title:'SECRET'},'w'),parentAgentId:'lead'},{...ev('5','model.observed',{model:'/Users/someone/SECRET'},'w'),parentAgentId:'lead'},
    {...ev('6','usage.recorded',{scope:'message',counterKind:'per-message-snapshot',completeness:'provisional',messageId:'msg_SECRET',model:'sk-SECRETSECRETSECRET',usage:u(1,2,3,4),note:'SECRET',provenance:'/Users/someone/SECRET.jsonl'},'w'),parentAgentId:'lead'},
    final('7',u(20,60,150,5)),ev('8','plan.updated',{steps:[{step:'SECRET',status:'completed'}]})];
  events.forEach(validateEvent);
  const out=JSON.parse(JSON.stringify(safeReplay(events,'Live')));const text=JSON.stringify(out);
  for(const leak of ['SECRET','/Users','someone','msg_','sk-'])assert(!text.includes(leak),leak);
  assert.equal(out.redacted,true);assert.equal(out.mode,'Recorded');assert.equal(out.events.length,events.length);out.events.forEach(validateEvent);
  const agents=reduceEvents(out.events),lead=agents.find(a=>a.id==='agent-1'),worker=agents.find(a=>a.id==='agent-2');
  assert.equal(lead.model,'claude-opus-4-1');assert.deepEqual(lead.usage.usage,u(20,60,150,5));assert.equal(lead.usage.completeness,'final');
  assert.equal(worker.model,'Unknown');assert.deepEqual(worker.usage.usage,u(1,2,3,4));assert.equal(worker.parent,'agent-1');
});
test('model labels are allowlisted for export',()=>{
  for(const ok of ['gpt-5-codex','claude-sonnet-4-5-20250929','openai/gpt-5','claude-haiku-4-5'])assert.equal(safeModelLabel(ok),ok);
  for(const bad of ['/Users/someone/model','Users/someone','sk-abcdefghijklmnop','ghp_abcdefghijklmnop','Bearer abc','a b','x@example.com','A'.repeat(30),'',null,7])assert.equal(safeModelLabel(bad),'Unknown');
});

test('desktop token_usage_record cumulative snapshots deduplicate',()=>{
 const a=new Adapter({source:'desktop'});a.ingest({type:'session_meta',timestamp:'2026-09-29T00:00:00Z',payload:{id:'fresh'}},0);
 a.ingest({type:'turn_context',timestamp:'2026-09-29T00:00:01Z',payload:{model:'gpt-6-astra'}},1);
 const r={type:'token_usage_record',timestamp:'2026-09-29T00:00:02Z',payload:{response_id:'response1',thread_token_usage:{input_tokens:100,cached_input_tokens:80,output_tokens:12}}};a.ingest(r,2);const before=a.events.length;a.ingest(r,3);assert.equal(a.events.length,before);assert.equal(a.errors,0);assert.ok(a.events.some(e=>e.type==='usage.recorded'&&e.data.usage.inputTokens===20));
});
