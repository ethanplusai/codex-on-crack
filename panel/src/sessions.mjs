// Exact, locally registered Codex session sources. Never discovers account logs.
import crypto from 'node:crypto';
import {Tail} from '../../plugins/codex-on-crack/skills/crack/viewer/src/tail.mjs';
import {reduceEvents,safeModelLabel} from '../../plugins/codex-on-crack/skills/crack/viewer/src/model.mjs';
const alias=id=>id?`session-${crypto.createHash('sha256').update(id).digest('hex').slice(0,16)}`:null;
export class SessionObserver {
 constructor(){this.tails=new Map();this.pending=null;}
 async snapshot(entries,workspaces,clock){
  // HTTP/MCP polls may overlap; serialize incremental reads of the same log.
  const work=(this.pending??Promise.resolve()).catch(()=>{}).then(()=>this.read(entries,workspaces,clock));this.pending=work;
  try{return await work;}finally{if(this.pending===work)this.pending=null;}
 }
 async read(entries,workspaces,clock){
  const keep=new Set(entries.map(e=>`${e.file}:${e.details}`));
  for(const key of this.tails.keys())if(!keep.has(key))this.tails.delete(key);
  const result=[];
  for(const entry of entries){
   const key=`${entry.file}:${entry.details}`;
   if(!this.tails.has(key))this.tails.set(key,new Tail(entry.file,alias(entry.file),entry.details));
   const tail=this.tails.get(key);await tail.poll();
   const all=reduceEvents(tail.adapter.events);const a=all.find(a=>a.id===tail.adapter.id);
   const events=a?.history??[];const unavailable=tail.status==='Unavailable';
   const state=unavailable?'unavailable':a?.status==='Working'?'running-observed':a?.status==='Failed'?'failed':['Turn complete','Cancelled'].includes(a?.status)?'idle':'observed';
   const start=a?.firstActivity??a?.created??null;const last=a?.last??null;
   const problems=[];if(unavailable)problems.push('Session log is unavailable. Retained events may be stale.');
   if(tail.status==='Loading')problems.push('Loading earlier session history.');
   if(tail.adapter.errors)problems.push(`${tail.adapter.errors} source records could not be parsed.`);
   if(tail.pending.length)problems.push('Waiting for an incomplete source record.');
   const model=safeModelLabel(a?.model);const usage=a?.usage;
   const models=usage?(usage.models.length?usage.models:[{model:'Unknown',usage:usage.usage}]).map(m=>({model:safeModelLabel(m.model),...m.usage,equivalentUsd:null,billedUsd:null})):[];
   const agent=x=>({id:alias(x.id),parent:alias(x.parent),title:x.id===a?.id?entry.label:x.title,model:safeModelLabel(x.model),status:x.status,steps:{total:x.steps.length,done:x.steps.filter(s=>s.status==='completed').length},verification:x.verification,activity:x.activity??null,first:x.firstActivity??x.created,last:x.last});
   const reason='Observed session: manage this conversation in Codex.';
   result.push({id:entry.id,label:entry.label,origin:'observed',kind:'session',from:null,workspaceId:entry.workspace,workspace:workspaces.find(w=>w.id===entry.workspace)?.label??null,phase:'session',owned:false,state,mode:null,toolProfile:null,failureKind:null,errors:problems,model,startedAt:start,endedAt:null,
    timing:{elapsedMs:start?Math.max(0,Date.parse(last??start)-Date.parse(start)):null,elapsedBasis:'Recorded session span, including time between turns; not active model time',activeMs:null,activeBasis:'not reported'},
    usage:{models,note:`Whole-session counter; model attribution may span changes. ${usage?.completeness??'No usage recorded'}.`,resumeDelta:null,billing:'Token counters only. Account allowance and billed costs are separate observations.'},
    agents:all.map(agent),workers:[],hostRequests:[],plan:a?.steps??[],activity:events.filter(e=>e.type!=='usage.recorded').map(e=>({at:e.at,type:e.type,text:e.data.text??e.type.replaceAll('.',' · '),agent:alias(e.agentId)})).reverse(),actions:{cancel:{allowed:false,reason},resume:{allowed:false,reason}}});
  }
  return result;
 }
}
