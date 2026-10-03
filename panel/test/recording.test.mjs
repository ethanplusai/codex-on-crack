import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createDemo} from '../src/demo.mjs';
import {createRecording,addCheckpoint,exportRecording,privacyProject,sourcesFrom} from '../src/recording.mjs';

function fixture(t) {
 const demo=createDemo();t.after(()=>demo.cleanup());
 const config=path.join(demo.root,'panel.json');const input=structuredClone(demo.config);for(const run of input.runs)delete run.origin;input.launch={enabled:false,profiles:[]};fs.writeFileSync(config,JSON.stringify(input));
 const dir=path.join(demo.root,'capture');
 return {demo,config,dir};
}

test('capture preserves frames, changed evidence and events without launching or deciding',async t=>{
 const {demo,config,dir}=fixture(t);const r=createRecording({out:dir,configPath:config});
 await r.sample();
 const doc=JSON.parse(fs.readFileSync(config));doc.reviews[0].actual=demo.nextEvidence('design');fs.writeFileSync(config,JSON.stringify(doc));
 await r.sample();r.finish();
 const frames=fs.readFileSync(path.join(dir,'frames.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(frames.length,2);assert.notEqual(frames[0].snapshot.reviews[0].evidenceHash,frames[1].snapshot.reviews[0].evidenceHash);
 assert.deepEqual(frames[1].snapshot.reviews[0].decisions,[]);
 assert.ok(fs.readdirSync(path.join(dir,'images')).length>=2);
 const events=JSON.parse(fs.readFileSync(path.join(dir,'events.json'))).events;
 assert.ok(events.length>10);assert.equal(new Set(events.map(e=>e.eventId)).size,events.length);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'recording.json'))).state,'finished');
 assert.throws(()=>createRecording({out:dir,configPath:config}),/EEXIST/);
 assert.equal(fs.existsSync(path.join(demo.config.stateDir,'launches.jsonl')),false);
});

test('default export removes free text, paths, images and checkpoint payloads; detailed export is opt-in',async t=>{
 const {demo,config,dir}=fixture(t);const secret='PRIVATE PROJECT SECRET';
 const doc=JSON.parse(fs.readFileSync(config));doc.runs[0].label=secret;fs.writeFileSync(config,JSON.stringify(doc));
 const r=createRecording({out:dir,configPath:config});await r.sample();r.finish();
 const note=path.join(demo.root,'note.json');fs.writeFileSync(note,JSON.stringify({kind:'allowance',label:secret,provider:'Codex',plan:'20x',usedPercent:42,concurrentSessions:'unknown'}));addCheckpoint(dir,note);
 const dest=path.join(demo.root,'share');exportRecording({recording:dir,out:dest});
 const payload=fs.readFileSync(path.join(dest,'recording.json'),'utf8');
 assert.ok(!payload.includes(secret));assert.ok(!payload.includes(demo.root));assert.deepEqual(JSON.parse(payload).images,{});
 assert.ok(JSON.parse(payload).events.length>0);
 const detail=path.join(demo.root,'private');exportRecording({recording:dir,out:detail,details:true,images:true});
 const full=JSON.parse(fs.readFileSync(path.join(detail,'recording.json')));
 assert.ok(JSON.stringify(full).includes(secret));assert.ok(Object.keys(full.images).length>0);assert.equal(full.checkpoints[0].usedPercent,42);
 assert.throws(()=>exportRecording({recording:dir,out:dest}),/EEXIST/);
});

test('missing source becomes a visible capture gap; interrupted recordings remain exportable',async t=>{
 const {demo,dir}=fixture(t);const r=createRecording({out:dir,configPath:path.join(demo.root,'missing')});
 const result=await r.sample();assert.ok(result.problems.length);const dest=path.join(demo.root,'incomplete');exportRecording({recording:dir,out:dest});
 assert.equal(JSON.parse(fs.readFileSync(path.join(dest,'recording.json'))).state,'recording');
 r.finish('failed');
});

test('source declarations and private checkpoint writes reject unsafe shapes and symlink targets',t=>{
 const {demo,dir,config}=fixture(t);const file=path.join(demo.root,'sources.json');fs.writeFileSync(file,JSON.stringify({sessions:['relative/log.jsonl']}));assert.throws(()=>sourcesFrom(file),/absolute/);
 fs.writeFileSync(file,JSON.stringify({scan:'/'}));assert.throws(()=>sourcesFrom(file),/accepts only/);
 const r=createRecording({out:dir,configPath:config});const outside=path.join(demo.root,'outside');fs.writeFileSync(outside,'untouched');fs.symlinkSync(outside,path.join(dir,'checkpoints.jsonl'));
 const note=path.join(demo.root,'note.json');fs.writeFileSync(note,JSON.stringify({kind:'plan',label:'Plan'}));assert.throws(()=>addCheckpoint(dir,note));assert.equal(fs.readFileSync(outside,'utf8'),'untouched');r.finish();
});

test('privacy mapping keeps relationships and numeric counters across frames',()=>{
 const result=privacyProject([{at:'2026-10-01T12:00:00.000Z',snapshot:{runs:[{id:'secret-run',phase:'secret-phase',model:'claude-opus-5-5',state:'completed',label:'private',usage:{outputTokens:20}}],phases:[{name:'secret-phase',runs:['secret-run']}],profiles:[]}}]);
 const s=result[0].snapshot;assert.equal(s.runs[0].id,s.phases[0].runs[0]);assert.equal(s.runs[0].phase,s.phases[0].name);assert.equal(s.runs[0].usage.outputTokens,20);assert.equal(s.runs[0].model,'claude-opus-5-5');assert.ok(!JSON.stringify(s).includes('secret'));
});
