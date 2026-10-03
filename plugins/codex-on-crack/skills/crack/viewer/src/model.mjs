export const TYPES = new Set(['tool.started','tool.finished','agent.created','agent.started','agent.returned','agent.cancelled','agent.failed','activity.reported','plan.updated','review.accepted','review.changes_requested','verification.reported','model.observed','usage.recorded']);
export const USAGE_KEYS=['inputTokens','outputTokens','cacheReadInputTokens','cacheCreationInputTokens'];
export const USAGE_SCOPES=['message','session'];
export const USAGE_COUNTERS=['per-message-snapshot','authoritative-total','cumulative-snapshot'];
export const USAGE_COMPLETENESS=['provisional','final','incomplete'];
const MAX_TOKENS=1e13;
// Envelope only: typed payload checks live in validateEvent so adapters can project raw metadata first.
export function validateEnvelope(e) {
  if(!e || e.schemaVersion!==1 || !TYPES.has(e.type) || typeof e.eventId!=='string' || !e.eventId || typeof e.agentId!=='string' || !e.agentId || !Number.isFinite(Date.parse(e.at)) || !e.data || typeof e.data!=='object' || Array.isArray(e.data)) throw Error('Invalid viewer event');
  if(e.parentAgentId!=null && typeof e.parentAgentId!=='string')throw Error('Invalid parent');
  return e;
}
export function validateUsage(u) {
  if(!u || typeof u!=='object' || Array.isArray(u))throw Error('Invalid usage');
  const keys=Object.keys(u);if(!keys.length||keys.some(k=>!USAGE_KEYS.includes(k)))throw Error('Invalid usage field');
  for(const k of keys)if(!Number.isSafeInteger(u[k])||u[k]<0||u[k]>MAX_TOKENS)throw Error('Invalid usage number');
  return u;
}
export function validateEvent(e) {
  validateEnvelope(e);
  if(e.type==='plan.updated' && (!Array.isArray(e.data.steps)||e.data.steps.some(s=>!s||typeof s.step!=='string'||!['pending','in_progress','completed'].includes(s.status))))throw Error('Invalid plan');
  if(e.type==='verification.reported' && !['passed','failed','not-run'].includes(e.data.status))throw Error('Invalid verification');
  if(e.type==='usage.recorded'){const d=e.data;
    if(!USAGE_SCOPES.includes(d.scope)||!USAGE_COUNTERS.includes(d.counterKind)||!USAGE_COMPLETENESS.includes(d.completeness))throw Error('Invalid usage kind');
    if(d.scope==='message'&&(typeof d.messageId!=='string'||!d.messageId||d.messageId.length>200))throw Error('Usage message ID required');
    validateUsage(d.usage);
  }
  for(const [key,value] of Object.entries(e.data))if(!(key==='steps'&&e.type==='plan.updated')&&!(key==='usage'&&e.type==='usage.recorded') && typeof value!=='string')throw Error('Invalid display field');
  return e;
}
// Model labels survive safe export only when they look like model identifiers, never paths or credentials.
export function safeModelLabel(value) {
  if(typeof value!=='string')return 'Unknown';const v=value.trim();
  if(!/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._:+-]{0,63})?$/.test(v))return 'Unknown';
  if(/^(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[a-z])[-_]|^(?:AKIA|AIza)[A-Z0-9_-]{8}/i.test(v)||/bearer/i.test(v)||/[A-Za-z0-9]{24,}/.test(v)||/^(?:Users|home|root|tmp|var|private|Volumes|mnt|opt|etc)\//i.test(v))return 'Unknown';
  return v;
}
const zero=()=>({inputTokens:0,outputTokens:0,cacheReadInputTokens:0,cacheCreationInputTokens:0});
const add=(a,b)=>Object.fromEntries(USAGE_KEYS.map(k=>[k,a[k]+(b[k]||0)]));
const max=(a,b)=>Object.fromEntries(USAGE_KEYS.map(k=>[k,Math.max(a[k]||0,b[k]||0)]));
// Message snapshots repeat as responses stream: keep the per-field maximum per message, never a sum.
// Session records supersede message sums: final totals replace, running cumulative records take the maximum.
function recordUsage(a,d,n) {
  const s=a.usageState||={messages:new Map(),finals:new Map(),running:new Map(),incomplete:new Set()};const u=max(zero(),d.usage);
  if(d.scope==='message'){const key=d.model||'Unknown';let m=s.messages.get(key);if(!m)s.messages.set(key,m=new Map());const prev=m.get(d.messageId);m.set(d.messageId,{usage:prev?max(prev.usage,u):u,first:prev?prev.first:n});return}
  const key=d.model||null;
  if(d.completeness==='final')s.finals.set(key,{usage:u,at:n});
  else{const prev=s.running.get(key);s.running.set(key,{usage:prev?max(prev.usage,u):u,at:n});if(d.completeness==='incomplete')s.incomplete.add(key)}
}
function settle(messages,final,running,incomplete) {
  let sum=zero(),after=zero(),later=false;
  for(const m of messages){sum=add(sum,m.usage);if(final&&m.first>final.at){after=add(after,m.usage);later=true}}
  if(final){let usage=add(final.usage,after);const newer=running&&running.at>final.at;if(newer)usage=max(usage,running.usage);return {usage,completeness:later||newer?(incomplete?'incomplete':'provisional'):'final',basis:later||newer?'Session total plus later records':'Session total'}}
  return {usage:running?max(sum,running.usage):sum,completeness:incomplete?'incomplete':'provisional',basis:running?'Running session counter':'Message snapshots'};
}
export function summarizeUsage(s) {
  const keys=new Set([...s.messages.keys(),...[...s.finals.keys(),...s.running.keys()].filter(k=>k!==null)]);
  const models=[...keys].map(model=>({model,...settle(s.messages.get(model)?.values()||[],s.finals.get(model),s.running.get(model),s.incomplete.has(model))}));
  let total;
  if(s.finals.has(null))total=settle([...s.messages.values()].flatMap(m=>[...m.values()]),s.finals.get(null),s.running.get(null),s.incomplete.has(null));
  else{const running=s.running.get(null);const usage=models.reduce((t,m)=>add(t,m.usage),zero());
    const completeness=s.incomplete.has(null)||models.some(m=>m.completeness==='incomplete')?'incomplete':!running&&models.length&&models.every(m=>m.completeness==='final')?'final':'provisional';
    total={usage:running?max(usage,running.usage):usage,completeness,basis:running?'Running session counter':models.length>1?'Sum of model segments':models[0]?.basis||'Message snapshots'}}
  return {...total,models};
}
// Callers pass only the events at or before the selected replay position; nothing here looks ahead.
export function reduceEvents(events) {
  const agents=new Map(),seen=new Set();let n=0;
  for(const e of events){if(seen.has(e.eventId))continue;seen.add(e.eventId);n++;
    let a=agents.get(e.agentId);if(!a){a={id:e.agentId,parent:e.parentAgentId||null,title:e.parentAgentId?'Worker':'Lead',model:'Unknown',status:'Observed',steps:[],history:[],verification:'not-run',created:e.at,last:e.at};agents.set(e.agentId,a)}
    if(e.parentAgentId)a.parent=e.parentAgentId;
    a.last=e.at;a.history.push(e);if(!['agent.created','model.observed'].includes(e.type)&&!a.firstActivity)a.firstActivity=e.at;
    if(e.type==='agent.created'){a.title=(e.data.title&&(!['Worker','Lead'].includes(e.data.title)||['Worker','Lead'].includes(a.title)))?e.data.title:a.title;a.assignment=e.data.assignment||a.assignment;if(a.status==='Observed')a.status='Queued'}
    if(e.type==='model.observed')a.model=e.data.model||'Unknown';
    if(e.type==='agent.started')a.status='Working';
    if(e.type==='agent.returned')a.status=a.parent?'Returned · awaiting review':'Turn complete';
    if(e.type==='agent.cancelled')a.status='Cancelled';
    if(e.type==='agent.failed')a.status='Failed';
    if(e.type==='review.accepted')a.status='Accepted';
    if(e.type==='review.changes_requested')a.status='Needs correction';
    if(e.type==='plan.updated')a.steps=e.data.steps;
    if(e.type==='verification.reported')a.verification=e.data.status;
    if(e.type==='usage.recorded'){recordUsage(a,e.data,n);if(a.model==='Unknown'&&e.data.model)a.model=e.data.model}
    if(e.data.text)a.activity=e.data.text;
  }
  return [...agents.values()].map(({usageState,...a})=>({...a,usage:usageState?summarizeUsage(usageState):null}));
}
// Shareable replay: opaque agent and message IDs, model labels, allowlisted usage numbers. No free text.
export function safeReplay(events,mode) {
  const ids=new Map(),messages=new Map();for(const e of events)if(!ids.has(e.agentId))ids.set(e.agentId,`agent-${ids.size+1}`);
  const out=[];
  for(const e of events)try{let d={};
    if(e.type==='agent.created')d={title:e.parentAgentId?'Worker':'Lead'};
    if(e.type==='model.observed')d={model:safeModelLabel(e.data.model)};
    if(e.type==='plan.updated')d={steps:e.data.steps.map((s,j)=>({step:`Plan step ${j+1}`,status:s.status}))};
    if(e.type==='verification.reported')d={status:e.data.status};
    if(e.type==='usage.recorded'){const u=e.data.usage||{};d={scope:e.data.scope,counterKind:e.data.counterKind,completeness:e.data.completeness,usage:Object.fromEntries(USAGE_KEYS.filter(k=>k in u).map(k=>[k,u[k]]))};
      if(typeof e.data.messageId==='string'){const key=`${e.agentId}\n${e.data.messageId}`;if(!messages.has(key))messages.set(key,`message-${messages.size+1}`);d.messageId=messages.get(key)}
      if(e.data.model)d.model=safeModelLabel(e.data.model)}
    out.push(validateEvent({schemaVersion:1,eventId:`event-${out.length+1}`,agentId:ids.get(e.agentId),parentAgentId:ids.get(e.parentAgentId)||null,at:e.at,type:e.type,data:d}));
  }catch{}
  return {schemaVersion:1,mode:mode==='Sample'?'Sample':'Recorded',redacted:true,events:out};
}
