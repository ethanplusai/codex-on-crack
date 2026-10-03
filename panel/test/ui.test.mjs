// Renderer checks in jsdom with an in-process demo controller behind a fake
// transport. These catch runtime errors and contract slips (text-only
// rendering, decision binding, empty/disconnected states); visual quality and
// real-browser behaviour are checked separately in the browser checklist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelController } from '../src/controller.mjs';
import { createDemo } from '../src/demo.mjs';
import { hasModule, waitFor } from './fixtures.mjs';

const ready = hasModule('jsdom');
const skip = !ready && 'jsdom is not installed (npm ci)';

async function dom(t) {
  const { JSDOM } = await import('jsdom');
  const window = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', { pretendToBeVisual: true }).window;
  window.scrollTo = () => {};
  if (!window.HTMLDialogElement.prototype.showModal) {
    window.HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute('open', ''); };
    window.HTMLDialogElement.prototype.close = function close() { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  }
  const saved = {};
  for (const key of ['window', 'document', 'Node', 'CSS', 'HTMLElement']) saved[key] = globalThis[key];
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.Node = window.Node;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.CSS = window.CSS ?? { escape: (value) => String(value).replace(/["\\\]\[]/g, '\\$&') };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
    window.close();
  });
  return window;
}

function fakeTransport(controller, calls) {
  return {
    kind: 'http',
    pollMs: 60_000,
    state: () => controller.snapshot(),
    async artifact(reviewId, side, hash) {
      // The view always pins the fetch to the image hash its snapshot showed.
      assert.match(hash, /^[0-9a-f]{64}$/);
      const image = await controller.artifact(reviewId, side, hash);
      return `data:${image.type};base64,${image.data.toString('base64')}`;
    },
    async decide(body) {
      calls.push(['decide', body]);
      return controller.decide({ ...body, channel: 'demo-ui' });
    },
    launchPreview: (id) => controller.launchPreview(id),
    launch: async (body) => { calls.push(['launch', body]); return controller.launch(body); },
    cancel: async (body) => { calls.push(['cancel', body]); return controller.cancel(body); },
    resumePreview: (id) => controller.resumePreview(id),
    resume: async (body) => controller.resume(body),
    demoRevise: async (body) => { calls.push(['revise', body]); return controller.demoRevise(body.reviewId); },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
// Wait for a rendered condition rather than a fixed delay; the suite runs in parallel.
async function until(predicate, message) {
  assert.ok(await waitFor(predicate, 10_000, 20), message);
}
const textOf = (window) => window.document.body.textContent;
const button = (window, text) => [...window.document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(text));

async function mounted(t) {
  const window = await dom(t);
  const demo = createDemo();
  t.after(() => demo.cleanup());
  const controller = new PanelController({ config: demo.config, provenance: 'demo', demo });
  const calls = [];
  const { mountPanel } = await import('../src/ui/panel.mjs');
  const panel = mountPanel(window.document.getElementById('app'), fakeTransport(controller, calls));
  t.after(() => panel.stop());
  panel.start();
  await until(() => window.document.querySelector('.row'), 'the overview renders');
  return { window, controller, calls, panel };
}

test('overview renders the phase and agent hierarchy with the demo label', { skip }, async (t) => {
  const { window } = await mounted(t);
  const text = window.document.body.textContent;
  assert.match(text, /Codex on Crack/);
  assert.match(text, /Demo data\./);
  assert.match(text, /Design/);
  assert.match(text, /Implementation lead/);
  assert.match(text, /Worker · builder/);
  assert.match(text, /Native worker dispatch/);
  assert.match(text, /not executed by the panel/);
  assert.match(text, /Observed only/);
  assert.ok(button(window, 'Launch…').disabled, 'demo launch is disabled');
  assert.ok(button(window, 'Cancel').disabled);
});

test('review: changes need feedback, decisions carry the evidence hash, revisions invalidate', { skip }, async (t) => {
  const { window, controller, calls } = await mounted(t);
  button(window, 'Review').click();
  await until(() => [...window.document.querySelectorAll('img[data-image]')].length === 2
    && [...window.document.querySelectorAll('img[data-image]')].every((img) => img.getAttribute('src')?.startsWith('data:image/png;base64,')), 'both images load');

  button(window, 'Request changes').click();
  await until(() => window.document.querySelector('.toast'), 'a toast explains the missing feedback');
  assert.equal(calls.length, 0, 'no request without feedback');
  assert.match(window.document.querySelector('.toast').textContent, /Describe the change/);

  const textarea = window.document.querySelector('textarea');
  textarea.value = 'Even card spacing, please.';
  textarea.dispatchEvent(new window.Event('input'));
  button(window, 'Request changes').click();
  await until(() => /Even card spacing, please\./.test(textOf(window)) && !button(window, 'Request changes').disabled, 'the change request is shown');
  const before = (await controller.snapshot()).reviews[0];
  assert.equal(calls[0][0], 'decide');
  assert.equal(calls[0][1].decision, 'request_changes');
  assert.equal(calls[0][1].expectedHash, before.evidenceHash);
  assert.match(textOf(window), /Changes requested/);

  button(window, 'Simulate revised evidence').click();
  await until(() => button(window, 'Approve revision 2') && !button(window, 'Approve revision 2').disabled, 'revision 2 is shown');
  button(window, 'Approve revision 2').click();
  await until(async () => (await controller.snapshot()).reviews[0].state === 'approved' && /Demo decision/.test(textOf(window)), 'the approval is recorded');
  const approved = (await controller.snapshot()).reviews[0];
  assert.equal(calls.at(-1)[1].expectedHash, approved.evidenceHash);
  assert.notEqual(approved.evidenceHash, before.evidenceHash);
  assert.match(window.document.body.textContent, /Demo decision/);
});

test('usage view shows recorded counters and labels the unknowns', { skip }, async (t) => {
  const { window } = await mounted(t);
  button(window, 'Usage & routes').click();
  await until(() => /Recorded usage/.test(textOf(window)), 'the usage view renders');
  const text = window.document.body.textContent;
  assert.match(text, /Recorded usage/);
  assert.match(text, /\$1\.84/);
  assert.match(text, /not bills/);
  assert.match(text, /Configured versus verified/);
  assert.match(text, /Host action only/);
  assert.ok(window.document.querySelectorAll('.unknown').length > 0, 'missing counters render as unknown, not zero');
});

test('native styling: neutral stylesheet, quiet demo note, details survive polls', { skip }, async (t) => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../src/ui/panel.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /text-transform:\s*uppercase|dashed|#6a4fd0|#a996ff|violet/i, 'no eyebrows, dashed boxes, or violet accent');
  assert.match(css, /--color-ring-primary/, 'focus uses the host ring token');

  const { window, panel } = await mounted(t);
  assert.equal(window.document.querySelectorAll('.strip.demo').length, 1, 'one demo note');
  const details = window.document.querySelector('details.disclosure');
  assert.ok(details && !details.open, 'technical details start collapsed');
  const toggled = new Promise((resolve) => details.addEventListener('toggle', resolve, { once: true }));
  details.open = true;
  await toggled;
  await panel.refresh();
  assert.ok(window.document.querySelector('details.disclosure').open, 'an open disclosure stays open after a refresh');

  button(window, 'Review').click();
  await until(() => window.document.querySelector('.bullets li'), 'checks render as plain bullets');
  assert.equal(window.document.querySelectorAll('input[type="checkbox"]').length, 0);
});

test('controller text is rendered as text, never as HTML', { skip }, async (t) => {
  const window = await dom(t);
  const { mountPanel } = await import('../src/ui/panel.mjs');
  const hostile = '<img src=x onerror="globalThis.pwned=1">';
  const snapshot = {
    schemaVersion: 1, provenance: 'real', generatedAt: new Date().toISOString(), launchEnabled: false,
    workspaces: [{ id: 'w', label: hostile }], routes: [], phases: [{ name: 'build', runs: ['r'] }],
    runs: [{
      id: 'r', workspaceId: 'w', label: hostile, origin: 'observed', owned: false, state: 'completed', phase: 'build', mode: 'solo', toolProfile: 'files',
      failureKind: null, errors: [hostile], model: 'claude-opus-5-5', startedAt: null, endedAt: null,
      timing: { elapsedMs: null, elapsedBasis: 'unknown', activeMs: null, activeBasis: 'not reported' },
      usage: { models: [], note: '' }, agents: [], workers: [], hostRequests: [],
      activity: [{ at: new Date().toISOString(), type: 'activity.reported', text: hostile }],
      actions: { cancel: { allowed: false, reason: hostile }, resume: { allowed: false, reason: hostile } },
    }],
    profiles: [], reviews: [], coverage: hostile,
  };
  const transport = { kind: 'http', pollMs: 60_000, state: async () => snapshot };
  const panel = mountPanel(window.document.getElementById('app'), transport);
  t.after(() => panel.stop());
  panel.start();
  await until(() => window.document.querySelector('.row'), 'the hostile snapshot renders');
  assert.equal(window.document.querySelectorAll('img').length, 0);
  assert.ok(window.document.body.textContent.includes(hostile));
  assert.equal(globalThis.pwned, undefined);
});

test('unconfigured and disconnected states are explicit', { skip }, async (t) => {
  const window = await dom(t);
  const { mountPanel } = await import('../src/ui/panel.mjs');
  let fail = false;
  const transport = {
    kind: 'mcp', pollMs: 60_000,
    state: async () => {
      if (fail) throw new Error('host closed the channel');
      return { schemaVersion: 1, provenance: 'unconfigured', configPath: '~/.codex/crack/panel.json', problems: ['No readable panel configuration.'] };
    },
    useDemo: async () => {},
  };
  const panel = mountPanel(window.document.getElementById('app'), transport);
  t.after(() => panel.stop());
  panel.start();
  await until(() => /Your build, in view/.test(textOf(window)), 'the unconfigured state renders');
  assert.ok(button(window, 'Explore an example'));
  fail = true;
  await panel.refresh();
  assert.match(window.document.body.textContent, /Disconnected/);
  assert.match(window.document.body.textContent, /host closed the channel/);
  assert.ok(button(window, 'Retry'));
});

test('the bundled MCP App document executes and renders before the host connects', { skip }, async (t) => {
  const { JSDOM, VirtualConsole } = await import('jsdom');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { PLUGIN_ROOT } = await import('./fixtures.mjs');
  const html = fs.readFileSync(path.join(PLUGIN_ROOT, 'server', 'app.html'), 'utf8');
  const errors = [];
  const console = new VirtualConsole();
  console.on('jsdomError', (error) => { if (!/Not implemented: Window's scrollTo/.test(error.message)) errors.push(error.message); });
  const window = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: console }).window;
  t.after(() => window.close());
  await until(() => /Connecting/.test(window.document.getElementById('app').textContent), 'the bundled app renders');
  assert.deepEqual(errors, []);
  assert.match(window.document.getElementById('app').textContent, /Codex on Crack[\s\S]*Connecting/);
});


test('phase selection, review shortcut and activity filters follow recorded data', { skip }, async (t) => {
  const { window } = await mounted(t);
  const phase = window.document.querySelector('.phase-step.completed');
  phase.click();
  assert.match(window.document.querySelector('[aria-label="Selected run"]').textContent, /Design lead/);
  button(window, 'Tools').click();
  const tools = [...window.document.querySelectorAll('.event-text')].map(n=>n.textContent);
  assert.ok(tools.length > 0);
  assert.ok(tools.every(text=>/started|finished/.test(text)));
  button(window, 'Lifecycle').click();
  assert.ok([...window.document.querySelectorAll('.event-text')].every(n=>!tools.includes(n.textContent)));
  window.document.querySelector('.attention-link').click();
  assert.ok(window.document.querySelector('.review'));
  await until(()=>[...window.document.querySelectorAll('img[data-image]')].every(img=>img.getAttribute('src')?.startsWith('data:')), 'review evidence finishes loading');
  assert.match(window.document.querySelector('.question-item[aria-pressed="true"]').textContent, /Dashboard layout/);
});

test('missing output counters stay unknown in the run summary', { skip }, async (t) => {
  const { window, controller, panel } = await mounted(t);
  const snapshot = await controller.snapshot();
  snapshot.runs.forEach(r=>r.usage.models.forEach(m=>{m.outputTokens=null;}));
  panel.show(snapshot);
  assert.match(window.document.querySelectorAll('.metric-value')[1].textContent, /Not reported/);
  assert.ok(window.document.querySelector('.strip.demo'));
});


test('first-run connection request previews the message and sends only on confirmation', { skip }, async (t) => {
  const window = await dom(t);
  const { mountPanel } = await import('../src/ui/panel.mjs');
  const messages = [];
  const panel = mountPanel(window.document.getElementById('app'), {
    kind:'mcp', pollMs:60_000,
    state:async()=>({provenance:'unconfigured',problems:[]}),
    host:{canDiscuss:()=>true,canShareContext:()=>false,displayToggle:()=>null,discuss:async text=>messages.push(text)},
    useDemo:async()=>{},
  });
  t.after(()=>panel.stop());panel.start();
  await until(()=>button(window,'Connect this project'),'connection action appears');
  button(window,'Connect this project').click();
  const preview = window.document.querySelector('dialog .message').textContent;
  assert.match(preview,/Preserve existing registrations/);
  assert.equal(messages.length,0);
  button(window,'Send message').click();
  await until(()=>messages.length===1,'confirmed connection request is sent');
  assert.equal(messages[0],preview);
  await until(()=>!window.document.querySelector('dialog'),'dialog closes');
  await new Promise(resolve=>setTimeout(resolve,10));
});

test('demo entrypoint sets the transport mode before the next refresh', { skip }, async (t) => {
  const window=await dom(t);
  const {mountPanel}=await import('../src/ui/panel.mjs');
  const demo=createDemo();t.after(()=>demo.cleanup());
  const controller=new PanelController({config:demo.config,provenance:'demo',demo});
  let demoMode=false;
  const panel=mountPanel(window.document.getElementById('app'),{
    kind:'mcp',pollMs:60_000,
    useDemo:async on=>{demoMode=on;},
    state:async()=>demoMode?controller.snapshot():{provenance:'unconfigured',problems:[]},
  });
  t.after(()=>panel.stop());
  panel.show(await controller.snapshot());
  assert.equal(demoMode,true);
  await panel.refresh();
  assert.ok(window.document.querySelector('.strip.demo'));
});

test('visual inbox sends asynchronous feedback with no comparison slider', {skip},async t=>{
 const {window,calls,controller}=await mounted(t);button(window,'Review').click();
 assert.equal(window.document.querySelector('[aria-label="Actual image opacity"]'),null);
 assert.equal(window.document.querySelector('[aria-label="Comparison mode"]'),null);
 const input=window.document.querySelector('textarea');input.value='Keep the typography; soften the color.';input.dispatchEvent(new window.Event('input',{bubbles:true}));
 button(window,'Send feedback').click();await until(()=>calls.length===1&&!button(window,'Send feedback').disabled,'feedback saved');
 assert.equal(calls[0][1].decision,'feedback');assert.equal((await controller.snapshot()).reviews[0].approvedBy,null);assert.match(textOf(window),/without interrupting/);
});

test('one project destination contains its runs and review queue', {skip},async t=>{
 const {window,panel,controller}=await mounted(t);const s=await controller.snapshot();
 s.workspaces=[{id:'sample-project',label:'Sample project'},{id:'other',label:'Other project'}];
 s.runs.forEach(r=>r.workspaceId='sample-project');s.reviews.forEach(r=>r.workspaceId='sample-project');
 panel.show(s);
 const tab=window.document.querySelector('[data-key="project-sample-project"]');assert.ok(tab);tab.click();
 assert.equal(window.document.querySelectorAll('[data-key="project-sample-project"]').length,1);
 assert.match(window.document.querySelector('.sidebar').textContent,/Design lead/);assert.match(window.document.querySelector('.sidebar').textContent,/Implementation lead/);
 window.document.querySelector('[data-key="project-other"]').click();assert.match(window.document.querySelector('.detail').textContent,/No runs yet/);
});


test('workspace navigation scopes review badges, usage, routes and survives refresh', { skip }, async (t) => {
  const {window,controller,panel}=await mounted(t);
  const s=await controller.snapshot();
  s.workspaces=[{id:'sample-project',label:'Sample project'},{id:'other',label:'Other'}];
  s.runs.forEach(r=>r.workspaceId='sample-project');
  s.reviews.forEach(r=>r.workspaceId='sample-project');
  s.workspaceRoutes={'sample-project':s.routes,other:[]};
  panel.show(s);
  const doc=window.document;
  const workspaceNav=doc.querySelector('.project-tabs');
  assert.ok(workspaceNav.compareDocumentPosition(doc.querySelector('.tabs')) & window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(doc.querySelector('[data-key="project-all"]'),null);
  assert.equal(doc.querySelector('[data-key="project-sample-project"]').getAttribute('aria-pressed'),'true');
  const count=s.reviews.filter(r=>r.state==='ready_for_review').length;
  assert.equal(doc.querySelector('[data-key="tab-review"] .count')?.textContent,String(count));
  doc.querySelector('[data-key="project-other"]').click();
  assert.equal(doc.querySelector('[data-key="tab-review"] .count'),null);
  doc.querySelector('[data-key="tab-review"]').click();
  assert.equal(doc.querySelectorAll('.question-item').length,0);
  doc.querySelector('[data-key="tab-usage"]').click();
  assert.equal(doc.querySelectorAll('.routes tbody tr').length,0);
  for(const r of s.runs)assert.ok(!doc.querySelector('.usage').textContent.includes(r.label));
  panel.show(s);
  assert.equal(doc.querySelector('[data-key="project-other"]').getAttribute('aria-pressed'),'true');
  doc.querySelector('[data-key="project-sample-project"]').click();
  assert.equal(doc.querySelectorAll('.routes tbody tr').length,s.routes.length);
});
