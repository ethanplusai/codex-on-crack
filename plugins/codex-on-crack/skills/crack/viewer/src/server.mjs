import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {parseArgs} from 'node:util';
import {Tail} from './tail.mjs';
import {selectEvents} from './adapter.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const {values}=parseArgs({options:{session:{type:'string',multiple:true},events:{type:'string',multiple:true},root:{type:'string'},since:{type:'string'},port:{type:'string',default:'4318'},details:{type:'boolean',default:false},help:{type:'boolean'}}});
if(values.help){console.log('npm start -- [--session /absolute/root.jsonl --session /absolute/child.jsonl] [--events /absolute/events.jsonl] [--root ID] [--since ISO_DATE] [--details] [--port 4318]\nNo session: sample replay. Explicit files only. --details exposes reported plan text locally; review before screen recording.');process.exit(0)}
if(values.since&&!Number.isFinite(Date.parse(values.since)))throw Error('Invalid --since timestamp');
const port=Number(values.port);if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid port');
const tails=[...new Set(values.session||[])].map((file,i)=>new Tail(path.resolve(file),i,values.details));
for(const file of new Set(values.events||[]))tails.push(new Tail(path.resolve(file),tails.length,values.details,true));
const token=randomBytes(24).toString('hex');let busy=false;
async function poll(){if(busy)return;busy=true;try{await Promise.all(tails.map(t=>t.poll()))}finally{busy=false}}
await poll();const interval=setInterval(poll,1000);
const assets=new Map([['/','../public/index.html'],['/app.mjs','../public/app.mjs'],['/style.css','../public/style.css'],['/model.mjs','./model.mjs']]);
const sample=JSON.parse(await fs.readFile(path.join(here,'../fixtures/sample.json'),'utf8'));
const server=http.createServer(async(req,res)=>{
 const host=req.headers.host;const address=server.address();const expected=`127.0.0.1:${address.port}`;
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
 if(host!==expected||req.headers.origin&&req.headers.origin!==`http://${expected}`){res.writeHead(403);res.end('Forbidden');return}
 if(req.method!=='GET'){res.writeHead(405);res.end('Read-only');return}
 const url=new URL(req.url,`http://${expected}`);
 if(url.pathname==='/api/state'){
  if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401);res.end('Token required');return}
  const root=values.root||tails[0]?.adapter.id;
  const events=tails.length?selectEvents(tails.map(t=>t.adapter),root,values.since):sample.events;
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({schemaVersion:1,mode:tails.length?'Live':'Sample',events,details:values.details,since:values.since||null,sources:tails.map(t=>({label:`Source ${t.index+1}`,sessionId:t.adapter.id,status:t.status,checkedAt:t.checkedAt,errors:t.adapter.errors,partialLine:t.pending.length>0})),coverage:'Only explicitly selected files are observed. Missing workers and undeclared plans are not inferred. Usage reflects recorded counters only. Subscription quota and human quality remain in the trial report.'}));return;
 }
 if(!assets.has(url.pathname)){res.writeHead(404);res.end('Not found');return}
 try{const file=path.resolve(here,assets.get(url.pathname));res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.mjs')?'text/javascript':'text/html');res.end(await fs.readFile(file))}catch{res.writeHead(500);res.end('Asset unavailable')}
});
server.listen(port,'127.0.0.1',()=>console.log(`Viewer: http://127.0.0.1:${server.address().port}/#token=${token}\n${tails.length?'Watching selected files, read-only.':'Sample replay only. Add --session to watch a real test.'}`));
server.on('error',e=>{clearInterval(interval);console.error(e.message);process.exitCode=1});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{clearInterval(interval);server.close(()=>process.exit(0))});
