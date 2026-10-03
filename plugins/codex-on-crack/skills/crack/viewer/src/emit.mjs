import fs from 'node:fs/promises';import path from 'node:path';import {randomUUID} from 'node:crypto';import {parseArgs} from 'node:util';import {validateEvent} from './model.mjs';
const {values:v}=parseArgs({options:{file:{type:'string'},agent:{type:'string'},parent:{type:'string'},type:{type:'string'},data:{type:'string',default:'{}'},help:{type:'boolean'}}});
if(v.help){console.log('node src/emit.mjs --file .local/run.jsonl --agent lead --type agent.started [--parent lead] [--data JSON]\nWrites one explicit viewer event. No model calls or Codex configuration changes.');process.exit(0)}
if(!v.file)throw Error('--file is required');const event=validateEvent({schemaVersion:1,eventId:randomUUID(),agentId:v.agent,parentAgentId:v.parent||null,at:new Date().toISOString(),type:v.type,data:JSON.parse(v.data)});
await fs.mkdir(path.dirname(path.resolve(v.file)),{recursive:true});await fs.appendFile(v.file,JSON.stringify(event)+'\n',{mode:0o600});console.log(`Recorded ${event.type}`);
