// Explicit-source, local-only capture. No model calls, scanning or lifecycle actions.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PanelController } from './controller.mjs';
import { loadPanelConfig } from './config.mjs';
import { viewerState } from '../../plugins/codex-on-crack/skills/crack/viewer/serve.mjs';
import { Tail } from '../../plugins/codex-on-crack/skills/crack/viewer/src/tail.mjs';
import { safeReplay, safeModelLabel } from '../../plugins/codex-on-crack/skills/crack/viewer/src/model.mjs';

const MAX = 128 * 1024 * 1024;
const json = x => JSON.stringify(x, null, 2) + '\n';
function read(file, max=MAX) {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>max)throw Error('Recording input is not a bounded regular file');return fs.readFileSync(fd,'utf8');}finally{fs.closeSync(fd);}
}
function root(dir) {const p=path.resolve(dir);if(fs.realpathSync(p)!==p||!fs.statSync(p).isDirectory())throw Error('Recording directory must be a real directory, not a symlink');return p;}
function write(dir,name,data) {const file=path.join(dir,name);const tmp=file+'.'+crypto.randomBytes(5).toString('hex');fs.writeFileSync(tmp,data,{flag:'wx',mode:0o600});fs.renameSync(tmp,file);}
function append(dir,name,value) {const file=path.join(dir,name);if(fs.existsSync(file)&&fs.lstatSync(file).size>MAX)throw Error('Recording reached its size limit; finish this segment');const fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_APPEND|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);try{fs.writeSync(fd,JSON.stringify(value)+'\n');}finally{fs.closeSync(fd);}}
const COVERAGE = 'Explicitly registered sources only. Panel snapshots are sampled, not a video. Session events retain their own timestamps. Missing agents and counters remain unknown. Whole-session counters can include work before capture. Overlapping panel and session usage must not be added together. Account allowance is a separate observation, not a token conversion.';

export function sourcesFrom(file) {
  if(!file)return {sessions:[],runs:[]};
  const s=JSON.parse(read(file,1024*1024));
  if(!s||Array.isArray(s)||Object.keys(s).some(k=>!['sessions','runs','root'].includes(k)))throw Error('Sources accepts only sessions, runs and an optional root session id');
  for(const key of ['sessions','runs']) {
    s[key]??=[];
    if(!Array.isArray(s[key])||s[key].length>100||s[key].some(p=>typeof p!=='string'||!path.isAbsolute(p)))throw Error('Source paths must be explicit absolute paths (at most 100 per kind)');
    s[key]=[...new Set(s[key])];
  }
  if(s.root!==undefined&&(typeof s.root!=='string'||s.root.length>200))throw Error('Invalid root session id');
  return s;
}

export function createRecording({out,configPath=null,sourcesPath=null,details=false,intervalMs=2000,clock=()=>new Date()}) {
  if(!Number.isSafeInteger(intervalMs)||intervalMs<500||intervalMs>60000)throw Error('Interval must be 500–60000 ms');
  if(!configPath&&!sourcesPath)throw Error('Register a panel config or session sources before recording');
  const dir=path.resolve(out);fs.mkdirSync(dir,{mode:0o700});root(dir);
  fs.mkdirSync(path.join(dir,'images'),{mode:0o700});
  const meta={schemaVersion:1,startedAt:clock().toISOString(),endedAt:null,state:'recording',details,intervalMs,configPath,sourcesPath,coverage:COVERAGE};
  write(dir,'recording.json',json(meta));
  const tails=new Map();const history=new Map();const configVersions=[];let frames=0;let stopped=false;let sessionObserver=null;
  async function sample() {
    if(stopped)throw Error('Recording already stopped');
    if(frames>=50000)throw Error('Recording reached 50,000 frames; start a new segment');
    const at=clock().toISOString();const problems=[];let snapshot=null;let registeredRuns=[];let registeredSessions=[];
    // Fresh read-only observer sees registrations added during the build. It
    // never replaces the interactive panel's controller or owns its children.
    if(configPath) {
      let controller;
      try {
        const config=loadPanelConfig(configPath);registeredRuns=config.runs.map(r=>r.dir);registeredSessions=(config.sessions??[]).map(s=>s.file);
        const digest=crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
        if(configVersions.at(-1)?.sha256!==digest){configVersions.push({at,sha256:digest,config});write(dir,'config-history.json',json(configVersions));}
        controller=new PanelController({config,clock});if(sessionObserver)controller.sessionObserver=sessionObserver;else sessionObserver=controller.sessionObserver;snapshot=await controller.snapshot();
        for(const review of snapshot.reviews)for(const side of ['reference','actual']) {
          const hash=review[side]?.sha256;if(!hash)continue;
          const target=path.join(dir,'images',hash+'.json');if(fs.existsSync(target))continue;
          try {const image=await controller.artifact(review.id,side,hash);fs.writeFileSync(target,json({type:image.type,base64:image.data.toString('base64')}),{flag:'wx',mode:0o600});}
          catch {problems.push(`Evidence unavailable at capture: ${review.id}/${side}`);}
        }
      } catch {problems.push('Panel configuration or snapshot unavailable at this sample');}
      finally {controller?.close();}
    }
    try {
      const sources=sourcesFrom(sourcesPath);sources.sessions=[...new Set([...registeredSessions,...sources.sessions])];sources.runs=[...new Set([...registeredRuns,...sources.runs])];
      write(dir,'sources.json',json(sources));
      if(sources.sessions.length||sources.runs.length) {
        const current=sources.sessions.map((file,index)=>{if(!tails.has(file))tails.set(file,new Tail(file,index,details,false));return tails.get(file);});
        const state=await viewerState({...sources,clock,details,tailsState:current});
        // Preserve events when an explicitly registered source later vanishes.
        // viewerState renumbers event ids; use content identity for stable union.
        for(const event of state.events){const {eventId,...body}=event;const key=crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');history.set(key,{...body,eventId:key});}
        const events=[...history.values()].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
        write(dir,'events.json',json({schemaVersion:1,mode:'Recorded',events,coverage:COVERAGE}));
        write(dir,'source-status.json',json({at,sources:state.sources}));
        if(state.sources.some(s=>s.errors||s.partialLine||s.status==='Unavailable'))problems.push('One or more session sources are incomplete; inspect source-status.json');
      }
    }catch {problems.push('Registered event sources unavailable at this sample');}
    append(dir,'frames.jsonl',{at,snapshot,problems});frames++;
    return {at,frames,problems};
  }
  function finish(state='finished') {if(stopped)return;stopped=true;meta.state=state;meta.endedAt=clock().toISOString();meta.frames=frames;write(dir,'recording.json',json(meta));}
  return {dir,sample,finish};
}

export function addCheckpoint(dir,file) {
  dir=root(dir);const data=JSON.parse(read(file,64*1024));
  const kinds=['plan','milestone','quality','usage','allowance','context','interruption'];
  if(!data||!kinds.includes(data.kind)||typeof data.label!=='string'||!data.label.trim()||data.label.length>200)throw Error('Checkpoint requires a supported kind and a label (1–200 characters)');
  if(!fs.existsSync(path.join(dir,'recording.json')))throw Error('Not a recording directory');
  append(dir,'checkpoints.jsonl',{...data,at:new Date().toISOString(),observedAt:data.observedAt??null});
}

function lines(file) {if(!fs.existsSync(file))return [];return read(file).split('\n').filter(Boolean).flatMap((line,index,all)=>{try{return [JSON.parse(line)];}catch{if(index===all.length-1)return [];throw Error('Malformed recording frame');}});}

// Conservative default: free text and ids are replaced, not regex-scrubbed.
export function privacyProject(value) {
  const ids=new Map();const alias=v=>{if(!ids.has(v))ids.set(v,`item-${ids.size+1}`);return ids.get(v);};
  const codes=new Set(['feedback','feedback_received','idle','session','real','demo','unconfigured','completed','failed','running','running-observed','starting','unavailable','unreadable','awaiting_evidence','ready_for_review','changes_requested','approved','host','router','subscription','api','unknown','solo','external-lead','files','terminal','observed','controller','verified','unverified','available-unverified','not-configured','host-only','early-design','visual','final','approve','request_changes','local-ui','mcp-app','demo-ui','controller-enforced','monitor-only','pending','in_progress','all']);
  const codeKeys=new Set(['kind','provenance','state','status','route','mode','toolProfile','origin','gate','decision','channel','approvedBy','enforcement','verification']);
  function clean(v,key='') {
    if(v===null||typeof v==='boolean'||typeof v==='number')return v;
    if(Array.isArray(v))return v.map(x=>clean(x,key));
    if(typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,clean(x,k)]));
    if(typeof v!=='string')return null;
    if(['workspaceId','id','run','runId','agentId','parent','reviewId','profileId','activeRun','runs','from'].includes(key))return v?alias(v):v;
    if(key==='model')return safeModelLabel(v);
    if(['at','generatedAt','startedAt','endedAt','submittedAt','first','last'].includes(key)&&/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v))return v;
    if(['sha256','evidenceHash','expectedHash'].includes(key)&&/^[a-f0-9]{64}$/.test(v))return v;
    if(codeKeys.has(key)&&codes.has(v))return v;
    if(key==='role'&&['host','lead','worker','dispatch'].includes(v))return v;
    if(key==='type'&&/^(tool|agent|activity|model)\.[a-z_]+$/.test(v))return v;
    if(key==='label'||key==='title')return 'Recorded item';
    if(key==='phase'||key==='name')return alias(v);
    if(key==='workspace')return 'Project';
    return v ? 'Details hidden' : '';
  }
  return clean(value);
}

export function exportRecording({recording,out,details=false,images=false,templatePath=null}) {
  const dir=root(recording);const meta=JSON.parse(read(path.join(dir,'recording.json'),1024*1024));
  const rawFrames=lines(path.join(dir,'frames.jsonl'));if(!rawFrames.length)throw Error('No frames captured');
  const frames=details?rawFrames:privacyProject(rawFrames);
  const eventFile=path.join(dir,'events.json');const rawEvents=fs.existsSync(eventFile)?JSON.parse(read(eventFile)).events:[];
  const events=details?rawEvents:safeReplay(rawEvents,'Recorded').events;
  const checkpoints=lines(path.join(dir,'checkpoints.jsonl'));
  const imageMap={};
  if(images)for(const frame of rawFrames)for(const review of frame.snapshot?.reviews??[])for(const side of ['reference','actual']) {
    const hash=review[side]?.sha256;if(!/^[a-f0-9]{64}$/.test(hash??'')||imageMap[hash])continue;
    const file=path.join(dir,'images',hash+'.json');if(fs.existsSync(file))imageMap[hash]=JSON.parse(read(file,24*1024*1024));
  }
  const data={schemaVersion:1,mode:'Recorded',startedAt:meta.startedAt,endedAt:meta.endedAt,state:meta.state,intervalMs:meta.intervalMs,coverage:COVERAGE,details,imagesIncluded:images,frames,events,checkpoints:details?checkpoints:checkpoints.map(c=>({at:c.at,kind:c.kind,label:'Private checkpoint omitted'})),images:imageMap};
  const base=path.dirname(fileURLToPath(import.meta.url));
  const template=templatePath??[path.join(base,'replay.html'),path.resolve(base,'../../plugins/codex-on-crack-panel/server/replay.html')].find(fs.existsSync);
  if(!template)throw Error('Replay template missing; rebuild the panel');
  const html=read(template);if(!html.includes('<!--RECORDING_DATA-->'))throw Error('Invalid replay template');
  const payload=JSON.stringify(data).replaceAll('<','\\u003c').replaceAll('&','\\u0026');
  const dest=path.resolve(out);fs.mkdirSync(dest,{mode:0o700});root(dest);
  fs.writeFileSync(path.join(dest,'index.html'),html.replace('<!--RECORDING_DATA-->',payload),{mode:0o600,flag:'wx'});
  fs.writeFileSync(path.join(dest,'recording.json'),json(data),{mode:0o600,flag:'wx'});
  fs.writeFileSync(path.join(dest,'README.txt'),`Offline build replay. Open index.html. No server or model account is needed.\n${COVERAGE}\n${details||images?'Contains opted-in private text or images. Review every frame before publishing.':'Default export replaces free text and omits images and checkpoint payloads. Inspect before publishing.'}\n`,{mode:0o600,flag:'wx'});
  return {out:dest,frames:frames.length,events:events.length,details,images,coverage:COVERAGE};
}
