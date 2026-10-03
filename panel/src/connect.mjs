import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {validatePanelConfig} from './config.mjs';
const id=(prefix,s)=>prefix+crypto.createHash('sha256').update(s).digest('hex').slice(0,16);
export function connectSession({configPath,file,workspace,label='Codex session',details=false}){
 if(!file||!workspace)throw Error('--session and --workspace are required');
 const root=fs.realpathSync(workspace);const canonical=fs.realpathSync(file);
 if(path.resolve(file)!==canonical)throw Error('Session source must be canonical, not a symlink');
 const fd=fs.openSync(canonical,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 let meta;
 try{if(!fs.fstatSync(fd).isFile())throw Error('Session must be a regular file');const b=Buffer.alloc(1024*1024);const n=fs.readSync(fd,b,0,b.length,0);meta=JSON.parse(b.subarray(0,n).toString().split('\n')[0]);}finally{fs.closeSync(fd);}
 if(meta.type!=='session_meta'||typeof meta.payload?.cwd!=='string'||fs.realpathSync(meta.payload.cwd)!==root)throw Error('Session metadata must match the selected workspace');
 const existed=fs.existsSync(configPath);if(existed&&fs.lstatSync(configPath).isSymbolicLink())throw Error('Refusing symlink configuration');
 const original=existed?fs.readFileSync(configPath,'utf8'):null;
 const doc=original?JSON.parse(original):{schemaVersion:1,stateDir:path.join(path.dirname(configPath),'panel-state'),workspaces:[],runs:[],reviews:[],launch:{enabled:false,profiles:[]}};
 let w=doc.workspaces.find(w=>fs.realpathSync(w.root)===root);
 if(!w){w={id:id('workspace-',root),root,label:path.basename(root)};doc.workspaces.push(w);}
 doc.sessions??=[];let session=doc.sessions.find(s=>s.file===canonical);
 if(!session){session={id:id('session-',canonical),file:canonical};doc.sessions.push(session);}
 Object.assign(session,{label,workspace:w.id,details});
 saveConfig(configPath,original,doc);
 return {connected:true,sessionId:session.id,workspace:w.id,details,modelCalls:0};
}

function saveConfig(configPath,original,doc){
 const result=validatePanelConfig(doc);if(!result.ok)throw Error(result.problems.join('; '));
 fs.mkdirSync(path.dirname(configPath),{recursive:true,mode:0o700});
 const lock=configPath+'.connect-lock';const lockFd=fs.openSync(lock,'wx',0o600);let temp;
 try{
  if((fs.existsSync(configPath)?fs.readFileSync(configPath,'utf8'):null)!==original)throw Error('Configuration changed concurrently; retry connection');
  if(original!==null)fs.writeFileSync(configPath+'.before-connect-'+crypto.randomBytes(6).toString('hex'),original,{flag:'wx',mode:0o600});
  temp=configPath+'.'+crypto.randomBytes(6).toString('hex');fs.writeFileSync(temp,JSON.stringify(doc,null,2)+'\n',{flag:'wx',mode:0o600});fs.renameSync(temp,configPath);temp=null;
 }finally{fs.closeSync(lockFd);fs.unlinkSync(lock);if(temp)fs.unlinkSync(temp);}
}

export function askQuestion({configPath,workspace,id:reviewId,label,question,file=null}){
 if(!reviewId||!question||!workspace)throw Error('--id, --question and --workspace are required');
 const root=fs.realpathSync(workspace);
 if(fs.lstatSync(configPath).isSymbolicLink())throw Error('Refusing symlink configuration');
 const original=fs.readFileSync(configPath,'utf8');const doc=JSON.parse(original);
 const w=doc.workspaces.find(w=>fs.realpathSync(w.root)===root);if(!w)throw Error('Connect this project first');
 let actual=null;
 if(file){actual=fs.realpathSync(file);if(!actual.startsWith(root+path.sep)||!fs.statSync(actual).isFile())throw Error('Visual material must be a file in this project');}
 doc.reviews??=[];const existing=doc.reviews.find(r=>r.id===reviewId);
 if(existing){
   const normalized=validatePanelConfig(doc);if(!normalized.ok)throw Error(normalized.problems.join('; '));
   if(normalized.config.reviews.find(r=>r.id===reviewId).workspace!==w.id)throw Error('Question id belongs to another project');
   if(actual&&actual!==existing.actual)throw Error('Submit revised visual material with the evidence tool so revision history is preserved');
   Object.assign(existing,{title:label??existing.title,question,workspace:w.id});
   if(actual)existing.actual=actual;
 }else doc.reviews.push({id:reviewId,title:label??reviewId,question,workspace:w.id,actual,checks:[],gate:'visual'});
 saveConfig(configPath,original,doc);
 return {registered:true,reviewId,workspace:w.id,modelCalls:0};
}
