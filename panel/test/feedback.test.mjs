import test from 'node:test';
import fs from 'node:fs';
import {askQuestion} from '../src/connect.mjs';
import assert from 'node:assert/strict';
import {createDemo} from '../src/demo.mjs';
import {PanelController} from '../src/controller.mjs';
import {validatePanelConfig} from '../src/config.mjs';
function fixture(t){const d=createDemo();t.after(()=>d.cleanup());const c=new PanelController({config:d.config,provenance:'demo',demo:d});t.after(()=>c.close());return {d,c};}
test('feedback is durable, revision-bound, and grants no approval or lifecycle action',async t=>{
 const {c}=fixture(t);const before=await c.snapshot();const r=before.reviews[0];
 const response=await c.decide({reviewId:r.id,decision:'feedback',feedback:'Prefer the warmer direction.',expectedHash:r.evidenceHash,channel:'demo-ui'});
 assert.equal(response.review.state,'feedback_received');assert.equal(response.review.approvedBy,null);assert.equal(response.review.decisions.at(-1).feedback,'Prefer the warmer direction.');assert.equal(response.review.decisions.at(-1).current,true);assert.equal(c.owned.size,0);
 await c.demoRevise(r.id);const after=(await c.snapshot()).reviews[0];assert.equal(after.state,'ready_for_review');assert.equal(after.decisions.at(-1).current,false);
 await assert.rejects(c.decide({reviewId:r.id,decision:'feedback',feedback:'Late reply',expectedHash:r.evidenceHash,channel:'demo-ui'}),e=>e.code==='stale_evidence');
});
test('a written question can receive feedback without pretending to approve a missing image',async t=>{
 const {c}=fixture(t);const review=c.reviews.reviews.values().next().value;review.actual=null;review.reference=null;review.question='Which audience should the concept address?';
 const r=(await c.snapshot()).reviews[0];assert.ok(r.evidenceHash);
 const reply=await c.decide({reviewId:r.id,decision:'feedback',feedback:'Product founders.',expectedHash:r.evidenceHash,channel:'demo-ui'});assert.equal(reply.review.state,'feedback_received');
 await assert.rejects(c.decide({reviewId:r.id,decision:'approve',expectedHash:r.evidenceHash,channel:'demo-ui'}),e=>e.code==='awaiting_evidence');
 review.question='Which product?';assert.notEqual((await c.snapshot()).reviews[0].evidenceHash,r.evidenceHash);
});
test('omitted workspace ids follow the containing project rather than the first project',t=>{
 const {d}=fixture(t);const raw=structuredClone(d.config);raw.workspaces.unshift({id:'other',root:d.root+'/state',label:'Other'});raw.runs.forEach(r=>{delete r.origin;delete r.workspace;});raw.reviews.forEach(r=>delete r.workspace);raw.launch={enabled:false,profiles:[]};
 // Reuse an existing narrower root for the unrelated default.
 raw.workspaces[0].root=d.config.stateDir;
 const checked=validatePanelConfig(raw);assert.equal(checked.ok,true,JSON.stringify(checked.problems));assert.ok(checked.config.runs.every(r=>r.workspace!=='other'));assert.ok(checked.config.reviews.every(r=>r.workspace!=='other'));
});

test('question registration is scoped, reusable, and preserves other reviews',t=>{
 const {d}=fixture(t);const doc=structuredClone(d.config);doc.runs.forEach(r=>delete r.origin);doc.launch={enabled:false,profiles:[]};
 const configPath=d.root+'/questions.json';fs.writeFileSync(configPath,JSON.stringify(doc));
 const args={configPath,workspace:doc.workspaces[0].root,id:'brand-direction',label:'Brand direction',question:'Which direction feels right?'};
 askQuestion(args);askQuestion({...args,question:'Which audience should this serve?'});
 const saved=JSON.parse(fs.readFileSync(configPath));assert.equal(saved.reviews.length,doc.reviews.length+1);assert.equal(saved.reviews.at(-1).question,'Which audience should this serve?');assert.deepEqual(saved.reviews.slice(0,-1),doc.reviews);
 assert.throws(()=>askQuestion({...args,file:'/etc/passwd'}),/project/);
});
