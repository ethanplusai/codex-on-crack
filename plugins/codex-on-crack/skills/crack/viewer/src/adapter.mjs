import {createHash} from 'node:crypto';
import {validateEvent,validateEnvelope,USAGE_KEYS} from './model.mjs';
// A display allowlist, not a transcript exporter. Detailed text is explicitly opt-in.
export function clean(value, details=false) {
  if(typeof value!=='string')return '';
  return value.replace(/(?:Bearer\s+|(?:sk|pk|ghp|github_pat)[-_])[A-Za-z0-9_\-.]{12,}/gi,'[credential removed]').replace(/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s"'<>]+/g,'[local path]').replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'[email]').slice(0,details?1200:160);
}
function json(s){try{return typeof s==='string'?JSON.parse(s):s}catch{return null}}
// Message IDs are only needed for equality, so keep a digest rather than the source identifier.
const digest=s=>createHash('sha256').update(s).digest('hex').slice(0,20);
// Project only supported usage fields; numbers are passed through untouched so validation rejects bad ones.
function projectUsage(src,details) {
  const usage={};if(src.usage&&typeof src.usage==='object'&&!Array.isArray(src.usage))for(const k of USAGE_KEYS)if(src.usage[k]!==undefined)usage[k]=src.usage[k];
  const data={scope:src.scope,counterKind:src.counterKind,completeness:src.completeness,usage};
  if(typeof src.messageId==='string'&&src.messageId)data.messageId=`msg-${digest(src.messageId)}`;
  const model=clean(src.model);if(model)data.model=model;
  if(details)for(const k of ['note','provenance'])if(typeof src[k]==='string'&&src[k])data[k]=clean(src[k]);
  return data;
}
export class Adapter {
  constructor({source,details=false,normalized=false}){this.normalized=normalized;this.source=source;this.details=details;this.id=null;this.parent=null;this.calls=new Map();this.completed=new Set();this.seq=0;this.events=[];this.errors=0;this.unknown=0;this.lastTimestamp=null}
  ingest(r,line){
    // Incoming metadata may be typed; validate the envelope, project the supported fields, then validate the projection.
    if(this.normalized){try{validateEnvelope(r);
      const src=r.data,data={};if(r.type==='agent.created'){data.title=this.details?clean(src.title,true):(r.parentAgentId?'Worker':'Lead');if(this.details&&typeof src.assignment==='string'&&src.assignment)data.assignment=clean(src.assignment,true)}
      if(r.type==='model.observed')data.model=clean(src.model);
      if(r.type==='plan.updated'){if(!Array.isArray(src.steps))throw Error('Invalid plan');data.steps=src.steps.map((s,i)=>({step:this.details?clean(s?.step,true):`Plan step ${i+1}`,status:s?.status}))}
      if(r.type==='verification.reported')data.status=src.status;
      if(r.type==='tool.started'||r.type==='tool.finished')data.text=`${clean(src.toolName)||'Tool'} ${r.type==='tool.started'?'started':src.isError?'failed':'finished'}`;
      if(r.type==='usage.recorded')Object.assign(data,projectUsage(src,this.details));
      if(typeof src.text==='string'&&src.text)data.text=this.details?clean(src.text,true):r.type.replaceAll('.',' · ');
      this.events.push(validateEvent({schemaVersion:1,eventId:r.eventId,agentId:r.agentId,parentAgentId:r.parentAgentId||null,at:r.at,type:r.type,data}));this.id ||= r.agentId;
    }catch{this.errors++}return}
    const p=r?.payload||{};this.seq=line;const at=r.timestamp||p.timestamp;this.lastTimestamp=at||this.lastTimestamp;
    if(r.type==='session_meta'){
      this.id=p.id||p.session_id;
      const sub=p.source?.subagent;this.agentPath=sub?.thread_spawn?.agent_path||sub?.spawn?.agent_path;this.parent=p.parent_session_id||sub?.thread_spawn?.parent_thread_id||sub?.spawn?.parent_thread_id||null;
      if(typeof this.id!=='string'){this.errors++;return}
      this.emit('agent.created',{title:this.parent?'Worker':'Lead'},at);
      return;
    }
    if(!this.id)return;
    if(r.type==='turn_context'){if(p.model){this.model=clean(p.model);this.emit('model.observed',{model:this.model},at)}return}
    if(r.type==='token_usage_record'){
      // Desktop records supply cumulative thread totals; the same reducer
      // handles repeated response records without counting them twice.
      this.tokenCount(p.thread_token_usage,at);return;
    }
    if(r.type==='event_msg'){
      const item=p.item;
      if(p.type==='item_completed'&&item&&['CommandExecution','McpToolCall','Extension','FileChange'].includes(item.type)&&!this.completed.has(item.id)){
        this.completed.add(item.id);
        const label=item.type==='CommandExecution'?'Shell command':item.type==='McpToolCall'?`Tool ${clean(item.tool)||'MCP'}`:item.type==='FileChange'?'File change':`Activity ${clean(item.kind)||'extension'}`;
        this.emit('tool.finished',{text:`${label}: ${clean(String(item.status??'recorded'))}${Number.isInteger(item.exit_code)?` (exit ${item.exit_code})`:''}`},at);
      }

      const map={task_started:'agent.started',task_complete:'agent.returned',turn_aborted:'agent.cancelled'};
      if(map[p.type])this.emit(map[p.type],{},at);
      if(p.type==='token_count')this.tokenCount(p.info?.total_token_usage,at);
      return;
    }
    if(r.type!=='response_item')return;
    // No reasoning, prompts, tool arguments, tool output bodies or transcript history.
    if(['function_call','custom_tool_call'].includes(p.type)){
      const name=(p.name||'').split(/[.:]/).at(-1);
      this.calls.set(p.call_id,{name,args:name==='spawn_agent'?(json(p.arguments)||{}):{}});
      if(name==='update_plan'){
        const args=json(p.arguments);if(Array.isArray(args?.plan))this.emit('plan.updated',{steps:args.plan.map((s,i)=>({step:this.details?clean(s.step,true):`Plan step ${i+1}`,status:s.status}))},at);
      }
      const label=name==='exec'?'Tool batch':name==='exec_command'?'Shell command':name==='apply_patch'?'File edit':name.replace(/[^a-zA-Z0-9_ -]/g,'').slice(0,80)||'Tool';
      this.emit('tool.started',{text:`${label} started`},at);
      return;
    }
    if(['function_call_output','custom_tool_call_output'].includes(p.type)&&this.calls.has(p.call_id)){
      const call=this.calls.get(p.call_id);this.calls.delete(p.call_id);if(!this.completed.has(p.call_id)){this.completed.add(p.call_id);this.emit('tool.finished',{text:`${clean(call.name)||'Tool'} finished`},at);}if(call.name!=='spawn_agent')return;const out=json(p.output);const id=out?.agent_id||out?.agentId||(typeof out?.task_name==='string'?`task:${out.task_name}`:null);
      if(typeof id==='string')this.emit('agent.created',{title:this.details?clean(call.args.task_name)||'Worker':'Worker',...(this.details?{assignment:clean(call.args.message,true)}:{})},at,id,this.id);
      return;
    }
    if(p.type==='message'&&['assistant','user'].includes(p.role)){
      const text=(p.content||[]).filter(c=>['output_text','input_text'].includes(c.type)).map(c=>c.text).join('\n');if(text)this.emit('activity.reported',{text:this.details?clean(text,true):`${p.role==='user'?'User':'Assistant'} message recorded`},at);
    }
  }
  // Codex token_count carries a cumulative session counter; info is null on rate-limit-only updates.
  // OpenAI cached input is a subset of input, so split it out rather than adding it on top.
  // Reasoning output is likewise already inside output_tokens.
  tokenCount(t,at){
    if(t==null)return;
    const n=k=>t[k]===undefined?0:t[k];const input=n('input_tokens'),cached=n('cached_input_tokens'),output=n('output_tokens');
    if(![input,cached,output].every(v=>Number.isSafeInteger(v)&&v>=0)||cached>input){this.errors++;return}
    const total={inputTokens:input-cached,outputTokens:output,cacheReadInputTokens:cached,cacheCreationInputTokens:0};const prev=this.usageTotal;
    if(prev&&USAGE_KEYS.every(k=>total[k]===prev[k]))return; // Repeated cumulative record: nothing new to count.
    if(!Number.isFinite(Date.parse(at))){this.errors++;return}
    this.usageTotal=total;this.emit('usage.recorded',{scope:'session',counterKind:'cumulative-snapshot',completeness:'provisional',usage:total},at,this.id,this.parent,'total');
    // The delta since the previous counter is attributed to the current model. A decreasing counter cannot be attributed.
    if(prev&&USAGE_KEYS.some(k=>total[k]<prev[k]))return;
    const delta=Object.fromEntries(USAGE_KEYS.map(k=>[k,total[k]-(prev?.[k]||0)]));
    this.emit('usage.recorded',{scope:'message',counterKind:'per-message-snapshot',completeness:'provisional',messageId:`response-${this.seq}`,...(this.model?{model:this.model}:{}),usage:delta},at,this.id,this.parent,'delta');
  }
  emit(type,data,at,id=this.id,parent=this.parent,key=''){
    if(!Number.isFinite(Date.parse(at))){this.errors++;return}
    const eventId=createHash('sha256').update(`${this.source}:${this.seq}:${id}:${type}${key?`:${key}`:''}`).digest('hex').slice(0,24);
    try{this.events.push(validateEvent({schemaVersion:1,eventId,agentId:id,parentAgentId:parent,at,type,data}))}catch{this.errors++}
  }
}
export function selectEvents(adapters,root,since){
 const aliases=new Map(adapters.filter(a=>a.agentPath&&a.id).map(a=>[`task:${a.agentPath}`,a.id]));
 const all=adapters.flatMap(a=>a.events).map(e=>({...e,agentId:aliases.get(e.agentId)||e.agentId,parentAgentId:aliases.get(e.parentAgentId)||e.parentAgentId}));const included=new Set([root]);let changed=true;
 while(changed){changed=false;for(const e of all)if(e.parentAgentId&&included.has(e.parentAgentId)&&!included.has(e.agentId)){included.add(e.agentId);changed=true}}
 const active=new Set(all.filter(e=>included.has(e.agentId)&&(!since||Date.parse(e.at)>=Date.parse(since))).map(e=>e.agentId));active.add(root);
 // Retain ancestor context, but never draw unrelated historical workers for a time-filtered run.
 let again=true;while(again){again=false;for(const e of all)if(active.has(e.agentId)&&e.parentAgentId&&!active.has(e.parentAgentId)){active.add(e.parentAgentId);again=true}}
 const latestMeta=new Map();const events=[];
 for(const e of all){if(!included.has(e.agentId)||!active.has(e.agentId))continue;if(since&&Date.parse(e.at)<Date.parse(since)){if(['agent.created','model.observed'].includes(e.type))latestMeta.set(`${e.agentId}:${e.type}`,e);continue}events.push(e)}
 return [...latestMeta.values(),...events].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
}
