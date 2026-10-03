import {mountPanel} from './panel.mjs';
import {reduceEvents} from '../../../plugins/codex-on-crack/skills/crack/viewer/src/model.mjs';
const data=JSON.parse(document.getElementById('recording-data').textContent);
let index=0,timer=null,mode='panel';
const $=id=>document.getElementById(id);
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const panel=mountPanel($('app'),{kind:'replay',artifact:async(_id,_side,hash)=>{
 const image=data.images[hash];if(!image)throw Error('Image not included in this export');
 if(!/^image\/(png|jpeg|webp|gif)$/.test(image.type))throw Error('Unsupported image');
 return `data:${image.type};base64,${image.base64}`;
}});
function stop(){clearTimeout(timer);timer=null;$('play').textContent='Play';}
function draw(){
 const frame=data.frames[index];$('position').value=String(index);$('time').textContent=`${index+1} / ${data.frames.length} · ${new Date(frame.at).toLocaleTimeString()}`;
 $('capture-state').textContent=`Recording · ${data.state}${data.details?' · Private details included':''}${data.imagesIncluded?' · Images included':''}`;
 const snapshot=structuredClone(frame.snapshot);
 if(snapshot){snapshot.readOnly=true;snapshot.launchEnabled=false;
  for(const run of snapshot.runs??[])run.actions={cancel:{allowed:false,reason:'Read-only replay'},resume:{allowed:false,reason:'Read-only replay'}};
  for(const profile of snapshot.profiles??[])profile.launch={allowed:false,reasons:['Read-only replay']};
  for(const review of snapshot.reviews??[])review.demoRevisionAvailable=false;
  panel.show(snapshot);
 }else panel.show({provenance:'unconfigured',problems:['No panel snapshot captured at this position. Use Recorded sessions for registered agent events.']});
 $('gaps').textContent=frame.problems?.length?`${frame.problems.length} capture gap(s) at this position. ${frame.problems.join(' · ')}`:'';
 $('app').hidden=mode!=='panel';$('session-view').hidden=mode!=='sessions';$('checkpoint-view').hidden=mode!=='checkpoints';
 if(mode==='sessions'){
  const section=$('session-view');section.replaceChildren();
  section.append(el('p','Registered session events, including any earlier session history. These overlap panel counters; do not add the two views together.','foot'));
  const agents=reduceEvents(data.events.filter(e=>Date.parse(e.at)<=Date.parse(frame.at)));
  for(const a of agents){
   const box=el('section',undefined,'session-card');box.append(el('h2',a.title),el('p',`${a.model} · ${a.status}`,'muted'));
   if(a.usage)box.append(el('p',`Input ${a.usage.usage.inputTokens.toLocaleString()} · Output ${a.usage.usage.outputTokens.toLocaleString()} · Cache read ${a.usage.usage.cacheReadInputTokens.toLocaleString()} · Cache write ${a.usage.usage.cacheCreationInputTokens.toLocaleString()} · ${a.usage.completeness}`,'foot'));
   else box.append(el('p','Usage not recorded','muted'));
   const steps=el('ul');for(const step of a.steps)steps.append(el('li',`${step.status}: ${step.step}`));box.append(steps);
   if(a.activity)box.append(el('p',a.activity,'foot'));section.append(box);
  }
  if(!agents.length)section.append(el('p','No registered session events at this position.','empty'));
 }
 if(mode==='checkpoints'){
  const section=$('checkpoint-view');section.replaceChildren();
  for(const point of data.checkpoints.filter(c=>index===data.frames.length-1||Date.parse(c.at)<=Date.parse(frame.at))){const box=el('section',undefined,'session-card');box.append(el('h2',`${point.kind} · ${point.label}`),el('pre',JSON.stringify(point,null,2)));section.append(box);}
  if(!section.children.length)section.append(el('p','No checkpoints included at this position.','empty'));
 }
}
function advance(){if(index>=data.frames.length-1){stop();return;}const delay=Math.max(40,(Date.parse(data.frames[index+1].at)-Date.parse(data.frames[index].at))/Number($('speed').value));timer=setTimeout(()=>{index++;draw();advance();},delay);}
$('play').onclick=()=>{if(timer){stop();return;}if(index===data.frames.length-1)index=0;draw();$('play').textContent='Pause';advance();};
$('position').max=String(data.frames.length-1);$('position').oninput=()=>{stop();index=Number($('position').value);draw();};
$('previous').onclick=()=>{stop();index=Math.max(0,index-1);draw();};$('next').onclick=()=>{stop();index=Math.min(data.frames.length-1,index+1);draw();};
$('speed').onchange=()=>{if(timer){stop();$('play').textContent='Pause';advance();}};
for(const button of document.querySelectorAll('[data-view]'))button.onclick=()=>{mode=button.dataset.view;for(const b of document.querySelectorAll('[data-view]'))b.setAttribute('aria-pressed',String(b===button));draw();};
$('coverage').textContent=data.coverage;draw();
