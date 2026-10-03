import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeRun} from '../scripts/study-report.mjs';

const spec={id:'run',condition:'solo',root_session:'root',descendants_confirmed:true,comparison_eligible:true,limitations:[]};
const records=[
 {type:'session_meta',payload:{id:'root',model_provider:'openai'}},
 {type:'event_msg',timestamp:'2026-09-26T10:00:00Z',payload:{type:'task_started'}},
 {type:'response_item',payload:{type:'function_call',arguments:'private content'}},
 {type:'token_usage_record',payload:{response_id:'response-1',usage:{input_tokens:100,cached_input_tokens:60,output_tokens:20},thread_token_usage:{input_tokens:100,cached_input_tokens:60,output_tokens:20}}},
 {type:'token_usage_record',payload:{response_id:'response-1',usage:{input_tokens:100,cached_input_tokens:60,output_tokens:20},thread_token_usage:{input_tokens:100,cached_input_tokens:60,output_tokens:20}}},
 {type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:100,cached_input_tokens:60,output_tokens:20}}}},
 {type:'event_msg',timestamp:'2026-09-26T10:00:10Z',payload:{type:'task_complete'}},
 {type:'event_msg',timestamp:'2026-09-26T10:01:00Z',payload:{type:'task_started'}},
 {type:'event_msg',timestamp:'2026-09-26T10:01:05Z',payload:{type:'task_complete'}},
];
const log=rs=>rs.map(JSON.stringify).join('\n');
test('study counts root timing, cached subset and unique response records without transcript text',()=>{
 const r=summarizeRun(spec,[log(records),log(records)],{passed:9,total:12});
 assert.equal(r.resources.total_tokens,120);assert.equal(r.resources.uncached_input_tokens,40);
 assert.equal(r.resources.root_elapsed_seconds,65);assert.equal(r.resources.root_active_turn_seconds,15);
 assert.equal(r.resources.model_responses_with_usage,1);assert.equal(r.resources.tool_calls,1);
 assert.equal(r.quality.functional_percent,75);assert.equal(r.quality.overall_quality_score,null);
 assert.equal(r.resources.billed_cost,null);assert.doesNotMatch(JSON.stringify(r),/private content/);
});
test('limitations and unknown coverage prevent ranking, and unfinished timing remains unknown',()=>{
 const r=summarizeRun({...spec,limitations:['approval interruption']},[log(records.slice(0,-1))],{passed:12,total:12});
 assert.equal(r.comparison_eligible,false);assert.equal(r.resources.root_elapsed_seconds,null);
 assert.equal(summarizeRun({...spec,descendants_confirmed:false},[log(records)],{passed:12,total:12}).comparison_eligible,false);
 assert.throws(()=>summarizeRun(spec,[log(records)],{passed:13,total:12}),/Invalid acceptance/);
});

test('study rejects response IDs without accounting instead of inferring usage', () => {
 const incomplete = records.map((record) => record.type === 'token_usage_record'
  ? { ...record, payload: { response_id: record.payload.response_id } } : record);
 assert.throws(() => summarizeRun(spec, [log(incomplete)], { passed: 9, total: 12 }), { code: 'invalid_usage' });
});
