import test from 'node:test';import assert from 'node:assert/strict';
import {sessionUsage} from '../plugins/codex-on-crack/skills/crack/scripts/lib/report.mjs';
const log=(id,parent,totals)=>[
 {type:'session_meta',payload:{id,source:parent?{subagent:{spawn:{parent_thread_id:parent}}}:'cli'}},
 {type:'turn_context',payload:{model:'fixture-native'}},
 ...totals.map(([input,cached,output])=>({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,cached_input_tokens:cached,output_tokens:output}}}}))
].map(JSON.stringify).join('\n');
test('session report attributes descendants, excludes other roots, and deduplicates cumulative counts',()=>{
 const root=log('root',null,[[100,20,10],[100,20,10],[150,30,15]]);
 const r=sessionUsage([root,root,log('child','root',[[70,40,7]]),log('unrelated',null,[[999,999,999]])],'root');
 assert.deepEqual(r.totals,{input_tokens:220,cached_input_tokens:70,uncached_input_tokens:150,output_tokens:22});
 assert.equal(r.excluded_unrelated_sessions,1);assert.equal(r.sessions.length,2);assert.equal(r.billing,null);
 assert.equal(r.sessions[0].by_model[0].provider,'unknown');
});
test('missing usage remains unknown and malformed/reset counters are refused',()=>{
 assert.equal(sessionUsage([log('root',null,[])],'root').totals,null);
 assert.throws(()=>sessionUsage([log('root',null,[[100,0,10],[90,0,12]])],'root'),{code:'invalid_usage'});
 assert.throws(()=>sessionUsage([log('root',null,[[100,101,10]])],'root'),{code:'invalid_usage'});
 assert.throws(()=>sessionUsage([log('root',null,[]),log('root',null,[[10,0,1]])],'root'),{code:'duplicate_session'});
 assert.throws(()=>sessionUsage([log('other',null,[])],'root'),{code:'root_missing'});
});

test('desktop thread_spawn descendants and session provider metadata are counted',()=>{
 const child=log('child','root',[[70,40,7]]).split('\n').map(JSON.parse);
 child[0].payload.source={subagent:{thread_spawn:{parent_thread_id:'root',agent_path:'/root/builder'}}};
 child[0].payload.model_provider='openai';
 const r=sessionUsage([log('root',null,[[100,20,10]]),child.map(JSON.stringify).join('\n')],'root');
 assert.equal(r.sessions.length,2);assert.equal(r.totals.input_tokens,170);
 assert.equal(r.sessions[1].by_model[0].provider,'openai');
});

const usage = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output });
const response = (id, counts, thread, extra = {}) => ({ type: 'event_msg', payload: { type: 'token_usage_record', response_id: id,
 usage: counts, ...(thread ? { thread_token_usage: thread } : {}), ...extra } });
const modernLog = (events, id = 'root', parent = null) => [
 { type: 'session_meta', payload: { id, parent_session_id: parent, model_provider: 'route' } },
 { type: 'turn_context', payload: { model: 'first' } }, ...events,
].map(JSON.stringify).join('\n');
test('desktop per-response accounting deduplicates and retains models and providers', () => {
 const first = response('a', usage(100, 20, 10), usage(100, 20, 10));
 const result = sessionUsage([modernLog([first, first,
  { type: 'turn_context', payload: { model: 'second', model_provider: 'other' } },
  response('b', { ...usage(50, 10, 5), reasoning_output_tokens: 3, total_tokens: 55 }, { total_token_usage: usage(150, 30, 15) }),
 ])], 'root');
 assert.deepEqual(result.totals, { input_tokens: 150, cached_input_tokens: 30, output_tokens: 15, uncached_input_tokens: 120 });
 assert.equal(result.sessions[0].response_count, 2);
 assert.deepEqual(result.sessions[0].by_model.map((r) => [r.model, r.provider, r.input_tokens]), [['first', 'route', 100], ['second', 'other', 50]]);
});
test('mixed cumulative and response schemas reconcile without double counting in either event order', () => {
 const a = response('a', usage(100, 20, 10), usage(100, 20, 10));
 const b = response('b', usage(50, 10, 5), usage(150, 30, 15));
 const snapshot = (counts) => ({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: counts } } });
 for (const events of [[a, snapshot(usage(100, 20, 10)), b, snapshot(usage(150, 30, 15))],
  [snapshot(usage(100, 20, 10)), a, snapshot(usage(150, 30, 15)), b]]) {
  assert.equal(sessionUsage([modernLog(events)], 'root').totals.input_tokens, 150);
 }
});
test('top-level desktop records work and unrelated response accounting stays isolated', () => {
 const event = response('a', usage(12, 2, 3));
 const top = { type: 'token_usage_record', payload: event.payload };
 const result = sessionUsage([modernLog([top]), modernLog([event], 'child', 'missing'), modernLog([response('b', usage(5, 1, 2))], 'linked', 'root')], 'root');
 assert.equal(result.totals.input_tokens, 17); assert.equal(result.excluded_unrelated_sessions, 1);
});
test('response accounting refuses contradictions, missing fields, partial prefixes and unsafe numbers', () => {
 const a = response('a', usage(100, 20, 10), usage(100, 20, 10));
 const bad = [
  [a, response('a', usage(101, 20, 10))], [a, response('a', usage(100, 20, 10), usage(101, 20, 10))],
  [response('a', { input_tokens: 1, output_tokens: 1 })], [response('', usage(1, 0, 1))],
  [response('a', usage(1, 2, 1))], [response('a', usage(-1, 0, 1))], [response('a', usage(1.1, 0, 1))],
  [response('a', { ...usage(1, 0, 1), total_tokens: 3 })], [response('a', { ...usage(1, 0, 1), reasoning_output_tokens: 2 })],
  [response('a', usage(Number.MAX_SAFE_INTEGER, 0, 1))],
  [response('a', usage(10, 1, 2), usage(100, 20, 10))],
  [a, { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: usage(120, 20, 12) } } }],
 ];
 for (const events of bad) assert.throws(() => sessionUsage([modernLog(events)], 'root'), { code: 'invalid_usage' });
 assert.throws(() => sessionUsage([modernLog([a]), modernLog([a], 'linked', 'root')], 'root'), { code: 'invalid_usage' });
});
