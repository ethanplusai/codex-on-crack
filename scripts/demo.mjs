#!/usr/bin/env node
// Disposable paired workspaces and a frozen evaluator. Never launches a model.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

export const PROMPT = `Implement invoice filtering and reporting in this small billing library.
Keep the public APIs queryInvoices(invoices, options = {}) and invoiceReport(invoices, options = {}).
Records have id, customer, status (open/paid/void), amountCents, currency, and dueDate (YYYY-MM-DD or null).
Records themselves are valid. Neither function may mutate the input array or records.
Options: status (open/paid/void, omitted means all), search (trimmed case-insensitive substring of id or customer),
minAmountCents (nonnegative integer, inclusive), overdue (boolean; when true include only open invoices with dueDate strictly before asOf).
asOf is a valid YYYY-MM-DD calendar date, required for overdue filtering and for every invoiceReport call.
Sort by sortBy (amountCents or dueDate, default dueDate), direction (asc/desc, default asc).
Missing due dates always sort last; ties sort by id ascending regardless of direction.
Pagination: page defaults to 1, pageSize defaults to 20; both positive integers, pageSize at most 100.
Reject invalid option values with TypeError. Search must be a string when supplied.
queryInvoices returns { items, total }, with total before pagination; out-of-range pages return no items.
invoiceReport returns { items, total, currencies }. currencies summarizes ALL filtered results before pagination,
not just the current page: one {currency, count, totalCents, overdueCents} per currency, sorted by currency.
Void invoices are excluded from currency summaries even when visible in items. Paid invoices count toward totalCents
but not overdueCents; overdueCents counts only open invoices due strictly before asOf. Never mix currency amounts.
Implement the feature and meaningful tests. Allowed paths: src/ and test/. No dependencies, external services,
commits, or configuration changes. Run node --test and report checks and limitations.`;
const FILES = {
  'package.json': JSON.stringify({name:'invoice-demo',private:true,type:'module',scripts:{test:'node --test'}},null,2)+'\n',
  'src/query.mjs': 'export function queryInvoices(invoices, options = {}) {\n  return { items: [...invoices], total: invoices.length };\n}\n',
  'src/report.mjs': "import { queryInvoices } from './query.mjs';\nexport function invoiceReport(invoices, options = {}) {\n  return { ...queryInvoices(invoices, options), currencies: [] };\n}\n",
  'test/smoke.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {queryInvoices} from '../src/query.mjs';\ntest('empty invoices',()=>assert.deepEqual(queryInvoices([]),{items:[],total:0}));\n",
};
export function prepare(output) {
  fs.mkdirSync(output); // Refuse an existing destination.
  for (const condition of ['baseline','workflow']) for (const [name,text] of Object.entries(FILES)) {
    const file=path.join(output,condition,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);
  }
  const manifest={schema_version:1,conditions:['baseline','workflow'],prompt_sha256:createHash('sha256').update(PROMPT).digest('hex'),
    initial_files:Object.fromEntries(Object.entries(FILES).map(([name,text])=>[name,createHash('sha256').update(text).digest('hex')])),
    note:'Unscored pilot. Same initial files and requirement; no model was launched. Preserve this evaluator outside worker scope.'};
  fs.writeFileSync(path.join(output,'prompt.txt'),PROMPT+'\n');fs.writeFileSync(path.join(output,'fixture.json'),JSON.stringify(manifest,null,2)+'\n');return manifest;
}
export async function score(workspace) {
  const {queryInvoices:q}=await import(pathToFileURL(path.join(workspace,'src/query.mjs')));
  const {invoiceReport:r}=await import(pathToFileURL(path.join(workspace,'src/report.mjs')));
  const invoices=[
    {id:'b',customer:'Acme',status:'open',amountCents:100,currency:'USD',dueDate:'2026-09-01'},
    {id:'a',customer:'acme',status:'paid',amountCents:100,currency:'EUR',dueDate:'2026-08-01'},
    {id:'c',customer:'Beta',status:'open',amountCents:300,currency:'USD',dueDate:'2026-09-26'},
    {id:'d',customer:'Delta',status:'void',amountCents:500,currency:'USD',dueDate:'2026-07-01'},
    {id:'e',customer:'Acme',status:'open',amountCents:200,currency:'EUR',dueDate:null},
  ];
  const ids=(x)=>x.items.map(i=>i.id);const opts={asOf:'2026-09-26'};const checks=[];
  const check=(name,fn)=>{try{fn();checks.push({name,passed:true});}catch(e){checks.push({name,passed:false,message:e.message});}};
  check('default order and total',()=>{const x=q(invoices);assert.deepEqual(ids(x),['d','a','b','c','e']);assert.equal(x.total,5);});
  check('combined case-insensitive search, status and inclusive minimum',()=>assert.deepEqual(ids(q(invoices,{status:'open',search:' ACME ',minAmountCents:100})),['b','e']));
  check('overdue excludes paid, void, due-today and missing dates',()=>assert.deepEqual(ids(q(invoices,{...opts,overdue:true})),['b']));
  check('descending amount retains ascending id ties',()=>assert.deepEqual(ids(q(invoices,{sortBy:'amountCents',direction:'desc'})),['d','c','e','a','b']));
  check('descending dates keep missing last',()=>assert.deepEqual(ids(q(invoices,{direction:'desc'})),['c','b','a','d','e']));
  check('pagination preserves pre-page total',()=>{const x=q(invoices,{page:2,pageSize:2});assert.deepEqual(ids(x),['b','c']);assert.equal(x.total,5);assert.equal(q(invoices,{page:99}).items.length,0);});
  check('summary covers all matches, separates currencies and excludes void',()=>assert.deepEqual(r(invoices,{...opts,pageSize:1}).currencies,[{currency:'EUR',count:2,totalCents:300,overdueCents:0},{currency:'USD',count:2,totalCents:400,overdueCents:100}]));
  check('summary obeys filters before pagination',()=>assert.deepEqual(r(invoices,{...opts,status:'open',search:'acme',pageSize:1}).currencies,[{currency:'EUR',count:1,totalCents:200,overdueCents:0},{currency:'USD',count:1,totalCents:100,overdueCents:100}]));
  check('summary handles more than one maximum-size page',()=>{const many=Array.from({length:151},(_,i)=>({...invoices[0],id:String(i)}));assert.equal(r(many,{...opts,pageSize:100}).currencies[0].count,151);});
  check('invalid option types and ranges are rejected',()=>{for(const bad of [{status:'bad'},{search:1},{minAmountCents:-1},{minAmountCents:1.2},{overdue:'yes'},{page:0},{page:1.5},{pageSize:101},{sortBy:'customer'},{direction:'down'}])assert.throws(()=>q(invoices,bad),TypeError);});
  check('calendar dates are validated, leap day is supported',()=>{for(const bad of [undefined,'2026-02-30','2026-9-01','garbage'])assert.throws(()=>q(invoices,{overdue:true,asOf:bad}),TypeError);assert.doesNotThrow(()=>q(invoices,{overdue:true,asOf:'2024-02-29'}));assert.throws(()=>r(invoices),TypeError);});
  check('frozen inputs are preserved',()=>{const frozen=Object.freeze(invoices.map(i=>Object.freeze({...i})));const before=JSON.stringify(frozen);q(frozen,{direction:'desc'});r(frozen,opts);assert.equal(JSON.stringify(frozen),before);});
  return {workspace,passed:checks.filter(c=>c.passed).length,total:checks.length,checks,
    note:'Functional acceptance only. No cost, speed, routing, or statistical usefulness claim.'};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [command,target]=process.argv.slice(2);
  if(!target || !['prepare','score'].includes(command)) throw new Error('Usage: node scripts/demo.mjs <prepare|score> <absolute path>');
  const result=command==='prepare'?prepare(path.resolve(target)):await score(path.resolve(target));
  console.log(JSON.stringify(result,null,2));if(command==='score' && result.passed!==result.total)process.exitCode=1;
}
