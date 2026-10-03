import {reduceEvents,validateEvent,safeReplay} from '/model.mjs';
const $=s=>document.querySelector(s);const el=(tag,text,cls)=>{const x=document.createElement(tag);if(text!==undefined)x.textContent=text;if(cls)x.className=cls;return x};
const hash=new URLSearchParams(location.hash.slice(1));let token=hash.get('token')||sessionStorage.getItem('viewer-token');if(token){sessionStorage.setItem('viewer-token',token);history.replaceState(null,'',location.pathname)}
let data={mode:'Connecting',events:[],sources:[]},liveData=null,index=0,selected=null,following=true,timer=null,imported=false,error='',exportData=null;
const label=e=>e.type.replaceAll('.',' · ');const time=t=>new Date(t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
function stop(){clearTimeout(timer);timer=null;$('#play').textContent='Play'}
function stepList(steps){const box=el('div');for(const s of steps){const row=el('div',undefined,'step');row.append(el('span',s.status==='completed'?'✓':s.status==='in_progress'?'◌':'○',`symbol ${s.status==='completed'?'done':''}`),el('span',s.step));box.append(row)}return box}
const observed=a=>{const span=Math.max(0,Math.floor((Date.parse(a.last)-Date.parse(a.firstActivity||a.created))/1000));return `${Math.floor(span/60)}m ${span%60}s`};
const count=n=>n.toLocaleString();
// Usage reflects only events up to the replay position. Input includes cache reads and writes.
function usageList(u){const box=el('div');for(const [name,x] of [['Total',u],...u.models.map(m=>[m.model,m])]){const t=x.usage,input=t.inputTokens+t.cacheReadInputTokens+t.cacheCreationInputTokens;const row=el('div',undefined,'step'),body=el('span');
 body.append(el('div',`${name} · ${count(input)} input · ${count(t.outputTokens)} output`),el('div',`${count(t.cacheReadInputTokens)} cache read · ${count(t.cacheCreationInputTokens)} cache write · ${x.completeness} · ${x.basis}`,'meta'));
 row.append(el('span',x.completeness==='final'?'✓':'◌',`symbol ${x.completeness==='final'?'done':''}`),body);box.append(row)}return box}
function render(){
 const events=data.events;index=Math.min(index,Math.max(0,events.length-1));const visible=events.slice(0,index+1);const agents=reduceEvents(visible);if(!agents.some(a=>a.id===selected))selected=agents[0]?.id;
 $('#mode').textContent=data.mode==='Live'&&!following?'Live · paused':data.mode;
 $('#coverage').textContent=data.coverage||'Recorded events. Replay preserves the captured sequence.';
 $('#notice').textContent=error||(data.mode==='Sample'?'Sample data — this is a demonstration, not measured test activity.':data.details?'Detailed local text is enabled. Review the screen before recording.':'Privacy view: work descriptions are hidden. Plans appear only when explicitly recorded.');
 const list=$('#agents');list.replaceChildren();
 const completed=a=>['Accepted','Cancelled','Failed','Turn complete'].includes(a.status);
 for(const [name,subset] of [['Active / awaiting review',agents.filter(a=>!completed(a))],['Finished',agents.filter(completed)]]){
  if(!subset.length)continue;const h=el('div',undefined,'group');h.append(el('span',name),el('span',String(subset.length),'badge'));list.append(h);
  for(const a of subset){const b=el('button',undefined,`agent ${a.parent?'nested':''}`);b.setAttribute('aria-pressed',String(a.id===selected));b.onclick=()=>{selected=a.id;render()};
   const title=el('span');title.append(el('span',a.title,'agent-name'),el('div',`${a.model} · ${a.status}`,'meta'));title.append(el('div',`${observed(a)} observed span`,'meta'));b.append(el('span',completed(a)?'✓':'•',`symbol ${a.status==='Accepted'?'done':''}`),title,el('span',a.steps.length?`${a.steps.filter(s=>s.status==='completed').length}/${a.steps.length}`:'—','stamp'),el('span','›'));list.append(b);
   if(a.steps.length&&a.id===selected){const steps=stepList(a.steps);steps.className='steps';list.append(steps)}
  }
 }
 if(!agents.length)list.append(el('p','Waiting for selected session events.','empty'));
 const pane=$('#detail');pane.replaceChildren();const a=agents.find(a=>a.id===selected);
 if(a){pane.append(el('div',`${a.title.startsWith('Project lead')?'Project lead':a.parent?'Worker':'Lead'} · ${a.model}`,'meta'),el('h2',a.title),el('div',a.status,'status'),el('h3','Assignment'),el('p',a.assignment||'Not included in the selected event stream.','assignment'),el('h3','Reported plan'));
 pane.append(a.steps.length?stepList(a.steps):el('p','No explicit plan has been observed.','meta'));
 pane.append(el('h3',`Latest activity · ${time(a.last)}`),el('p',a.activity||label(a.history.at(-1)),'activity'),el('h3','Verification'),el('p',a.verification==='not-run'?'No verification result recorded.':`Reported checks: ${a.verification}`,'meta'));
 pane.append(el('h3','Observed duration'),el('p',`${observed(a)} · ${time(a.firstActivity||a.created)} to ${time(a.last)} · from recorded event timestamps`,'meta'));
 pane.append(el('h3','Usage'),a.usage?usageList(a.usage):el('p','No usage recorded up to this point.','meta'),el('p','Token counts from recorded usage events, not allowance percentages. Human quality: see the trial report.','meta'));
 const disclosure=el('details');disclosure.append(el('summary',`Event history (${a.history.length})`));for(const e of a.history.slice(-100).reverse()){const row=el('div',undefined,'event-row');row.append(el('time',time(e.at)),el('span',e.data.text||label(e)));disclosure.append(row)}pane.append(el('h3','Evidence'),disclosure);
 }else pane.append(el('p','Select a session or open a recorded replay.','empty'));
 $('#scrub').max=Math.max(0,events.length-1);$('#scrub').value=index;$('#scrub').disabled=!events.length;$('#position').textContent=events.length?`${index+1} / ${events.length}`:'0 / 0';
 $('#event').textContent=events[index]?`${time(events[index].at)} · ${label(events[index])}`:'No events yet';
 $('#sources').textContent=(data.sources||[]).map(s=>`${s.label}: ${s.status}${s.errors?` · ${s.errors} rejected records`:''}${s.partialLine?' · partial line pending':''}`).join(' | ');
 $('#live').hidden=!liveData||(!imported&&(data.mode!=='Live'||following));$('#live').textContent=liveData?.mode==='Live'?'Return to live':'Back to sample';$('#play').disabled=!events.length;$('#export').disabled=!events.length;
}
async function poll(){try{const r=await fetch('/api/state',{headers:{Authorization:`Bearer ${token}`}});if(!r.ok)throw Error(r.status===401?'Open the full Viewer URL printed in the terminal.':`Connection error (${r.status})`);const next=await r.json();liveData=next;if(!imported){const first=data.mode==='Connecting';data=next;if(first&&data.mode==='Sample'){index=Math.min(10,data.events.length-1);following=false}else if(following){index=Math.max(0,data.events.length-1)}error='';render()}}catch(e){error=`Disconnected — ${e.message}. Last observed state is retained.`;render()}finally{setTimeout(poll,1500)}}
$('#scrub').oninput=e=>{stop();following=false;index=Number(e.target.value);render()};
function advance(){if(index>=data.events.length-1){stop();return}const delay=Math.min(60000,Math.max(60,(Date.parse(data.events[index+1].at)-Date.parse(data.events[index].at))/Number($('#speed').value)));timer=setTimeout(()=>{index++;render();advance()},delay)}
$('#play').onclick=()=>{if(timer){stop();return}following=false;if(index>=data.events.length-1)index=0;$('#play').textContent='Pause';render();advance()};
$('#live').onclick=()=>{stop();imported=false;data=liveData;following=data.mode==='Live';index=Math.max(0,data.events.length-1);error='';render()};
$('#import').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>5*1024*1024)throw Error('Replay exceeds the 5 MB limit');const parsed=JSON.parse(await file.text());if(parsed.schemaVersion!==1||!Array.isArray(parsed.events)||parsed.events.length>20000)throw Error('Invalid replay format');const seen=new Set();for(const event of parsed.events){validateEvent(event);if(seen.has(event.eventId))throw Error('Duplicate event ID');seen.add(event.eventId)}stop();data={mode:parsed.mode==='Sample'?'Sample':'Recorded',events:parsed.events.slice().sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)),sources:[],details:parsed.redacted!==true};imported=true;following=false;selected=null;index=0;error='';render()}catch(e){error=`Replay not opened: ${e.message}`;render()}finally{e.target.value=''}};
$('#export').onclick=()=>{exportData=safeReplay(data.events,data.mode);$('#export-summary').textContent=`${exportData.events.length} events. Mode: ${exportData.mode}. Agent names and text replaced. Model labels, token counts and timing retained.`;$('#export-dialog').showModal()};$('#cancel-export').onclick=()=>$('#export-dialog').close();
$('#download-export').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(exportData,null,2)],{type:'application/json'}));const a=el('a');a.href=url;a.download='agent-replay.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);$('#export-dialog').close()};
render();poll();
