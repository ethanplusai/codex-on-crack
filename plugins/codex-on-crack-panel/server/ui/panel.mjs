// Build panel renderer, shared by the localhost fallback and the MCP App.
//
// A transport supplies data and actions; this module only renders. Every
// string from the controller is inserted as text, never as HTML.
//
// transport = {
//   kind: 'http' | 'mcp', pollMs,
//   state(), artifact(reviewId, side, hash) -> url,
//   decide(body), launchPreview(profileId), launch(body), cancel(body),
//   resumePreview(runId), resume(body), demoRevise(body),
//   useDemo?(on)       // MCP only: switch to the separate demo controller
//   preferences?()     // MCP only: view preferences from the last state call
//   host?              // MCP only: capability-gated host features (host.mjs)
// }
//
// Without `host` (the localhost fallback, or a host that advertises nothing)
// the host-only controls are simply not rendered.

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    // CSSOM, not a style attribute: the localhost CSP blocks inline style attributes.
    else if (key === 'style') node.style.cssText = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// ---------------------------------------------------------------- formatting

const nf = new Intl.NumberFormat(undefined);
function tokens(n) {
  if (!Number.isSafeInteger(n)) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return nf.format(n);
}
function duration(ms) {
  if (!Number.isFinite(ms)) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
function clock(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
}
function ago(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}
const usd = (n) => (typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : null);
const title = (s) => String(s ?? '').replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const unknown = (text = 'unknown') => h('span', { class: 'unknown', text });

// Tones stay neutral except where the state itself is a warning or failure.
const RUN_STATE = {
  idle: ['Between turns', ''], observed: ['Observed', ''],
  completed: ['Completed', ''],
  failed: ['Failed', 'bad'],
  running: ['Running', 'live'],
  'running-observed': ['Running · observed', 'live'],
  starting: ['Starting', 'live'],
  unavailable: ['Unavailable', 'warn'],
  unreadable: ['Unreadable · refused', 'bad'],
};
const REVIEW_STATE = {
  feedback_received: ['Feedback saved', 'ok'],
  awaiting_evidence: ['Awaiting evidence', ''],
  ready_for_review: ['Ready for your review', 'live'],
  changes_requested: ['Changes requested', 'warn'],
  approved: ['Approved', 'ok'],
};
const ROUTE_STATUS = {
  verified: ['Verified', 'ok'],
  unverified: ['Configured · unverified', ''],
  'available-unverified': ['Available · unverified', ''],
  unavailable: ['Unavailable', 'bad'],
  failed: ['Failed', 'bad'],
  'not-configured': ['Not configured', ''],
  'host-only': ['Host action only', ''],
  demo: ['Demo', ''],
};
const CHANNEL = {
  'local-ui': 'Local panel client (session token)',
  'mcp-app': 'Codex app view (host-recorded)',
  'demo-ui': 'Demo decision',
};
const GATE = { 'early-design': 'Early design gate', visual: 'Visual check', final: 'Final acceptance' };

const MODE = { solo: 'Solo lead', 'external-lead': 'Lead + native worker' };
const LIVE = new Set(['running', 'running-observed', 'starting']);

function dot(tone = '', pulse = false) {
  return h('span', { class: `dot ${tone} ${pulse ? 'pulse' : ''}`.trim(), 'aria-hidden': 'true' });
}
function dotFor(state) {
  return dot(RUN_STATE[state]?.[1] ?? '', LIVE.has(state));
}
// A state as a dot and plain text; colour only carries warning and failure.
function status(map, key) {
  const [label, tone] = map[key] ?? [title(key), ''];
  return h('span', { class: `status ${tone}`.trim() }, dot(tone, map === RUN_STATE && LIVE.has(key)), label);
}
// Inline items separated by a quiet middle dot.
function line(cls, ...items) {
  return h('div', { class: `line ${cls}`.trim() }, items.flat().filter((item) => item !== null && item !== undefined && item !== false && item !== '')
    .map((item) => (item instanceof Node ? item : h('span', { text: String(item) }))));
}
function section(label, aside, ...body) {
  return h('section', { class: 'section', 'aria-label': label },
    h('div', { class: 'section-head' }, h('h3', { text: label }), aside ? h('span', { class: 'aside', text: aside }) : null),
    ...body);
}

// Small local icons; no network fonts or image dependencies.
const ICONS = {
  layers: 'M3 7l9-4 9 4-9 4-9-4zm0 5l9 4 9-4M3 17l9 4 9-4',
  arrow: 'M5 12h14m-5-5l5 5-5 5',
  check: 'M5 12l4 4L19 6',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  code: 'M8 5l-6 7 6 7m8-14l6 7-6 7m-3-15l-2 16',
  activity: 'M2 12h4l3-8 6 16 3-8h4',
  review: 'M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9M8 12l3 3L21 3',
};
function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.5','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',class:`icon ${cls}`})) svg.setAttribute(key,value);
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', ICONS[name] ?? ICONS.layers); svg.append(path); return svg;
}
function modelName(model) {
  return ({'gpt-6-astra':'Astra', 'gpt-6-sol':'Sol 6', 'claude-opus-5-5':'Opus 5.5', 'deepseek/deepseek-v4.1-flash':'Flash 4.1'})[model] ?? model ?? 'Not reported';
}

// ---------------------------------------------------------------- app

export function mountPanel(root, transport) {
  const ui = {
    snapshot: null,
    signature: '',
    view: 'overview',
    runId: null,
    reviewId: null,
    projectId: null,
    reviewFilter: 'waiting',
    compare: 'side',
    overlay: 50,
    connection: 'connecting',
    lastOk: null,
    error: null,
    drafts: new Map(),
    images: new Map(),
    imageNodes: new Map(),
    failedImages: new Set(),
    open: new Set(),
    toast: null,
    timer: null,
    busy: false,
    // View preferences (defaults until the host's settings arrive), and what
    // the user has chosen in this view, which preferences never override.
    prefs: { defaultView: 'overview', showCompletedRuns: true, compareMode: 'side-by-side' },
    prefsSeen: false,
    showCompleted: null,
    touched: { view: false, compare: false },
    pendingRoute: null,
    activityFilter: 'all',
    activityLimit: 12,
  };
  const host = transport.host ?? null;

  function applyPreferences(prefs) {
    if (!prefs || typeof prefs !== 'object') return false;
    const next = {
      defaultView: ['overview', 'review', 'usage'].includes(prefs.defaultView) ? prefs.defaultView : ui.prefs.defaultView,
      showCompletedRuns: typeof prefs.showCompletedRuns === 'boolean' ? prefs.showCompletedRuns : ui.prefs.showCompletedRuns,
      compareMode: ['side-by-side', 'overlay'].includes(prefs.compareMode) ? prefs.compareMode : ui.prefs.compareMode,
    };
    // The default view applies once, when the first preferences arrive; a
    // later settings change never moves an open view.
    const first = !ui.prefsSeen;
    ui.prefsSeen = true;
    if (first && !ui.touched.view) ui.view = next.defaultView;
    if (JSON.stringify(next) === JSON.stringify(ui.prefs)) return first;
    ui.prefs = next;
    if (!ui.touched.compare) ui.compare = next.compareMode === 'overlay' ? 'overlay' : 'side';
    return true;
  }

  // Select a registered run or review (from an entrypoint argument, a deep
  // link, or a click). Unregistered ids select nothing and say so; nothing
  // here starts an action.
  function navigate(route) {
    if (!route) return false;
    if (!ui.snapshot || ui.snapshot.provenance === 'unconfigured') {
      if (!ui.snapshot) ui.pendingRoute = route;
      return false;
    }
    const s = ui.snapshot;
    if (route.runId && !s.runs.some((r) => r.id === route.runId)) {
      toast('The linked run is not registered in this panel.');
      return false;
    }
    if (route.reviewId && !s.reviews.some((r) => r.id === route.reviewId)) {
      toast('The linked review is not registered in this panel.');
      return false;
    }
    if (['overview', 'review', 'usage'].includes(route.view)) ui.view = route.view;
    if (route.runId) {ui.runId = route.runId;ui.projectId=s.runs.find(r=>r.id===route.runId)?.workspaceId??null;}
    if (route.reviewId) {ui.reviewId = route.reviewId;ui.projectId=s.reviews.find(r=>r.id===route.reviewId)?.workspaceId??null;ui.reviewFilter='all';}
    ui.touched.view = true;
    render();
    return true;
  }
  function flushPendingRoute() {
    const pending = ui.pendingRoute;
    ui.pendingRoute = null;
    if (pending) navigate(pending);
  }

  // An explicit click on a run or review shares its bounded facts with the
  // host when the host accepts model context. Failures are not the user's
  // problem and change nothing in the view.
  function choose(kind, id) {
    if (kind === 'run') { ui.runId = id; ui.activityLimit = 12; }
    else ui.reviewId = id;
    render();
    if (host?.canShareContext()) Promise.resolve().then(() => host.shareSelection(ui.snapshot, { kind, id })).catch(() => {});
  }

  function toast(message, tone = '') {
    ui.toast = { message, tone };
    renderToast();
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { ui.toast = null; renderToast(); }, 5200);
  }
  function renderToast() {
    document.querySelector('.toast')?.remove();
    if (ui.toast) document.body.append(h('div', { class: `toast ${ui.toast.tone}`, role: 'status', text: ui.toast.message }));
  }

  async function refresh({ force = false } = {}) {
    try {
      const next = await transport.state();
      ui.connection = 'live';
      ui.lastOk = new Date();
      ui.error = null;
      const prefsChanged = applyPreferences(transport.preferences?.());
      const signature = JSON.stringify({ ...next, generatedAt: null });
      if (force || prefsChanged || signature !== ui.signature) {
        ui.snapshot = next;
        ui.signature = signature;
        render();
        flushPendingRoute();
      } else {
        renderConnection();
      }
    } catch (error) {
      ui.connection = 'lost';
      ui.error = error?.message ?? 'Connection lost.';
      render();
    }
  }

  function schedule() {
    clearTimeout(ui.timer);
    if (ui.stopped) return;
    ui.timer = setTimeout(async () => {
      if (document.visibilityState !== 'hidden') await refresh();
      schedule();
    }, transport.pollMs ?? 2500);
  }

  async function act(fn, success) {
    if (ui.busy) return null;
    ui.busy = true;
    render();
    try {
      const result = await fn();
      if (success) toast(typeof success === 'function' ? success(result) : success);
      await refresh({ force: true });
      return result;
    } catch (error) {
      toast(error?.message ?? 'The action failed.', 'bad');
      if (error?.code === 'stale_evidence') await refresh({ force: true });
      return null;
    } finally {
      ui.busy = false;
      render();
    }
  }

  // Preserve focus and caret across re-renders so a poll never eats typing.
  function render() {
    const active = document.activeElement;
    const key = active?.dataset?.key ?? null;
    const selection = key && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
    const scroll = window.scrollY;
    root.replaceChildren(view());
    if (key) {
      const again = root.querySelector(`[data-key="${CSS.escape(key)}"]`);
      if (again) {
        again.focus({ preventScroll: true });
        if (selection && 'setSelectionRange' in again) again.setSelectionRange(...selection);
      }
    }
    window.scrollTo(0, scroll);
    loadImages();
  }
  function renderConnection() {
    const node = root.querySelector('.conn');
    if (node) {
      node.className = `conn ${ui.connection}`;
      node.textContent = connectionText();
    }
  }
  function connectionText() {
    if (transport.kind === 'replay') return 'Recorded · offline';
    if (ui.connection === 'live') {
      if (ui.snapshot?.provenance === 'demo') return transport.kind === 'mcp' ? 'Example · Codex' : 'Example · localhost';
      return transport.kind === 'mcp' ? 'Connected via Codex' : 'Connected · localhost';
    }
    if (ui.connection === 'lost') return 'Disconnected';
    return 'Connecting…';
  }

  // ---------------------------------------------------------------- views

  // A native <details>; its open state survives re-renders and polls.
  function disclosure(key, summary, ...body) {
    const node = h('details', { class: 'disclosure', open: ui.open.has(key) },
      h('summary', { dataset: { key: `details-${key}` }, text: summary }),
      h('div', { class: 'disclosure-body' }, ...body));
    node.addEventListener('toggle', () => { if (node.open) ui.open.add(key); else ui.open.delete(key); });
    return node;
  }
  function notes(entries) {
    return h('dl', { class: 'notes' }, entries.filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([label, value]) => h('div', {}, h('dt', { text: label }), h('dd', {}, value))));
  }

  function view() {
    let s = ui.snapshot;
    const shell = h('div', { class: 'shell' });
    shell.append(topbar(s));
    if (ui.connection === 'lost') {
      shell.append(h('div', { class: 'strip lost', role: 'alert' },
        h('span', { class: 'grow' }, h('strong', { text: 'Disconnected. ' }),
          ui.lastOk ? `Showing the last state from ${clock(ui.lastOk.toISOString())}. ` : '',
          ui.error ?? ''),
        h('button', { class: 'button small', onclick: () => refresh({ force: true }) }, 'Retry')));
    }
    if (!s) {
      shell.append(h('div', { class: 'loading' }, h('p', { class: 'muted', text: 'Connecting to the panel controller…' }),
        h('div', { class: 'skeleton', style: 'width:62%' }), h('div', { class: 'skeleton', style: 'width:40%' }), h('div', { class: 'skeleton', style: 'width:54%' })));
      return shell;
    }
    if (s.provenance === 'unconfigured') {
      shell.append(unconfigured(s));
      return shell;
    }
    if (s.provenance === 'demo') {
      shell.append(h('div', { class: 'strip demo' },
        h('span', { class: 'grow' }, h('strong', { text: 'Demo data. ' }),
          'Explore an example build. No models are running and no usage is charged.'),
        transport.useDemo ? h('button', { class: 'button ghost small', onclick: () => switchDemo(false) }, 'Leave demo') : null));
    }
    shell.append(projectTabs(s));
    s=projectScope(s,ui.projectId);
    shell.append(viewTabs(s));
    if (ui.view === 'review') shell.append(reviewView(s));
    else if (ui.view === 'usage') shell.append(usageView(s));
    else shell.append(overview(s));
    return shell;
  }

  function projectScope(s,id) {
    if(!id)return {...s,runs:[],reviews:[],phases:[],profiles:[],routes:[]};
    const label=s.workspaces.find(w=>w.id===id)?.label;
    const runs=s.runs.filter(r=>r.workspaceId===id||(!r.workspaceId&&r.workspace===label));
    return {...s,runs,routes:s.workspaceRoutes?.[id]??[],reviews:s.reviews.filter(r=>r.workspaceId===id),phases:s.phases.map(p=>({...p,runs:p.runs.filter(id=>runs.some(r=>r.id===id))})).filter(p=>p.runs.length),profiles:s.profiles.filter(p=>p.workspaceId?p.workspaceId===id:p.workspace===id||p.workspace===label)};
  }
  function projectTabs(s) {
    if(!s.workspaces.some(w=>w.id===ui.projectId)) {
      ui.projectId=s.runs.find(r=>r.id===ui.runId)?.workspaceId??s.reviews.find(r=>r.id===ui.reviewId)?.workspaceId??s.workspaces.find(w=>s.runs.some(r=>r.workspaceId===w.id)||s.reviews.some(r=>r.workspaceId===w.id))?.id??s.workspaces[0]?.id??null;
    }
    return h('nav',{class:'project-tabs','aria-label':'Workspaces'},s.workspaces.map(w=>{
      const waiting=s.reviews.filter(r=>(!w.id||r.workspaceId===w.id)&&r.state==='ready_for_review').length;
      return h('button',{class:'project-tab','aria-pressed':String(ui.projectId===w.id),dataset:{key:`project-${w.id??'all'}`},onclick:()=>{ui.projectId=w.id;ui.runId=null;ui.reviewId=null;render();}},w.label,waiting?h('span',{class:'count',text:String(waiting)}):null);
    }));
  }

  function topbar(s) {
    // Offered only when the host reports the current mode and allows another.
    const display = host?.displayToggle() ?? null;
    return h('header', { class: 'topbar' },
      h('div', { class: 'titlebar' },
        h('h1', { text: 'Codex on Crack' }),
        s && s.provenance !== 'unconfigured' ? h('span', { class: 'sub', text: `${s.workspaces?.length??0} projects` }) : null,
        h('span', { class: 'spacer' }),
        transport.useDemo && s?.provenance !== 'demo' && s?.provenance !== 'unconfigured' ? h('button', {class:'button ghost small', onclick:()=>switchDemo(true)}, 'Explore demo') : null,
        h('span', { class: `conn ${ui.connection}`, role: 'status', text: connectionText() }),
        display ? h('button', {
          class: 'button ghost small display-mode', dataset: { key: 'display-mode' },
          onclick: () => host.requestDisplayMode(display.target).then(() => render(), () => toast('The host kept the current display mode.')),
        }, display.label) : null),
      );
  }

  function viewTabs(s) {
    const waiting = s?.reviews?.filter((r) => r.state === 'ready_for_review').length ?? 0;
    const tab = (id, label, extra = null) => h('button', {
      class: 'tab', role: 'tab', 'aria-selected': String(ui.view === id), 'aria-pressed': String(ui.view === id),
      dataset: { key: `tab-${id}` }, onclick: () => { ui.view = id; ui.touched.view = true; render(); },
    }, label, extra);
    return h('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Workspace views' },
      tab('overview', 'Overview'),
      tab('review', 'Review', waiting ? h('span', { class: 'count', 'aria-label': `${waiting} waiting`, text: String(waiting) }) : null),
      tab('usage', 'Usage & routes'));
  }

  function unconfigured(s) {
    return h('div', { class: 'welcome' },
      h('div', {class:'welcome-symbol'}, icon('layers')),
      h('p', {class:'welcome-label', text:'Codex on Crack'}),
      h('h2', {text:'Your build, in view.'}),
      h('p', {class:'welcome-copy', text:'Follow the plan, see what each model is doing, and review the result. All alongside your conversation.'}),
      h('div', {class:'welcome-actions'},
        host?.canDiscuss() ? h('button', {class:'button primary',onclick:openConnect}, 'Connect this project',icon('arrow')) : null,
        transport.useDemo ? h('button', {class:`button ${host?.canDiscuss() ? '' : 'primary'}`, onclick:()=>switchDemo(true)}, 'Explore an example', icon('arrow')) : null,
        h('button', {class:'button', onclick:()=>refresh({force:true})}, 'Check connection')),
      h('div', {class:'welcome-steps'},
        [['01','Plan together','Agree on the work and choose your models.'],['02','Follow the handoffs','See the lead, workers, and recorded activity.'],['03','Review the result','Compare evidence and give precise feedback.']].map(([n,t,d])=>h('div', {}, h('span',{class:'step-number',text:n}),h('h3',{text:t}),h('p',{text:d})))),
      h('div', {class:'setup-note'}, icon('code'),h('div',{},
        h('strong',{text:(s.problems?.length ?? 0)>1 ? 'Reconnect your workspace' : 'Connect your first project'}),
        h('p',{text:'Ask in chat: “Connect this project to the build panel.” The example is separate from your real work.'}),
        disclosure('setup-details','Connection details',
          s.configPath ? h('p',{},'Configuration: ',h('code',{text:s.configPath})) : null,
          ...(s.problems??[]).map(p=>h('p',{class:'small muted',text:p}))))));
  }

  function openConnect() {
    const text = 'Connect the project in this conversation to the build panel. Preserve existing registrations and keep launching disabled.';
    dialog({heading:'Connect this project in chat?',confirm:'Send message',
      body:[h('p',{class:'muted small',text:'The assistant will check this project and the panel configuration. This sends the following request to your conversation.'}),h('div',{class:'callout message',text})],
      onConfirm:()=>act(()=>host.discuss(text),'Sent to the conversation. Refresh after the configuration is ready.'),
    });
  }

  async function switchDemo(on) {
    await transport.useDemo(on);
    ui.runId = null;
    ui.reviewId = null;
    ui.view = 'overview';
    await refresh({ force: true });
  }

  // ---------------------------------------------------------------- overview

  // Completed runs follow the preference unless the user toggled them here.
  const showingCompleted = () => ui.showCompleted ?? ui.prefs.showCompletedRuns;
  const listed = (s) => s.runs.filter((r) => showingCompleted() || r.state !== 'completed' || r.id === ui.runId);

  function overview(s) {
    if (!ui.runId || !s.runs.some((r) => r.id === ui.runId)) {
      const visible = showingCompleted() ? s.runs : s.runs.filter((r) => r.state !== 'completed');
      ui.runId = visible.find((r) => r.state.startsWith('running'))?.id ?? visible[0]?.id ?? s.runs[0]?.id ?? null;
    }
    const run = s.runs.find((r) => r.id === ui.runId) ?? null;
    const detail = h('div', { class: 'detail' });
    if (run) detail.append(...runDetail(s, run));
    else detail.append(h('div', { class: 'empty' }, h('h2', { text: 'No runs yet' }),
      h('p', { text: 'Register a run directory in the panel configuration, or launch a registered profile once its gate is approved.' })));
    return h('div', { class: 'build-workspace' }, buildProgress(s), h('div', { class: 'split' }, h('aside', { class: 'sidebar' }, h('div',{class:'sidebar-caption',text:'Build outline'}), hierarchy(s), launch(s)), detail));
  }

  function buildProgress(s) {
    const phases = s.phases.map(phase=>{
      const runs = s.runs.filter(r=>phase.runs.includes(r.id));
      const state = runs.some(r=>['failed','unreadable'].includes(r.state)) ? 'failed' : runs.some(r=>LIVE.has(r.state)) ? 'running' : runs.length && runs.every(r=>r.state==='completed') ? 'completed' : runs.some(r=>r.state==='idle')?'idle':runs.some(r=>r.state==='observed')?'observed':'unavailable';
      return {phase,runs,state};
    });
    const waiting = s.reviews.filter(r=>r.state==='ready_for_review');
    return h('section',{class:'build-progress','aria-label':'Build progress'},
      h('div',{class:'phase-track'},phases.map(({phase,runs,state},index)=>h('button',{
        class:`phase-step ${state}`, 'aria-pressed':String(runs.some(r=>r.id===ui.runId)),
        dataset:{key:`phase-${index}`},onclick:()=>{if(runs[0]) choose('run',runs[0].id);},
      },h('span',{class:'phase-symbol'},state==='completed'?icon('check'):String(index+1).padStart(2,'0')),
        h('span',{class:'row-text'},h('span',{class:'title',text:title(phase.name)}),h('span',{class:'meta',text:RUN_STATE[state]?.[0]??title(state)}))))),
      waiting.length?h('button',{class:'attention-link',onclick:()=>{ui.view='review';ui.touched.view=true;choose('review',waiting[0].id);}},icon('review'),h('span',{},h('strong',{text:`${waiting.length} review${waiting.length===1?'':'s'} ready`}),h('span',{text:'Your feedback is next'})),icon('arrow')):null);
  }

  function hierarchy(s) {
    if(ui.projectId || s.workspaces.length<2)return runHierarchy(s);
    return h('div', {class:'project-tree'},s.workspaces.map(w=>{
      const scoped=projectScope(s,w.id);if(!scoped.runs.length)return null;
      return h('section',{},h('button',{class:'project-heading',onclick:()=>{ui.projectId=w.id;ui.runId=null;render();}},w.label),runHierarchy(scoped));
    }));
  }

  function runHierarchy(s) {
    const tree = h('nav', { class: 'tree', 'aria-label': 'Phases and agents' });
    if (!s.runs.length) {
      tree.append(h('div', { class: 'group', text: 'Runs' }), h('p', { class: 'muted small pad', text: 'Nothing registered.' }));
      return tree;
    }
    const shown = new Set(listed(s).map((r) => r.id));
    const hidden = s.runs.length - shown.size;
    for (const phase of s.phases) {
      if (!phase.runs.some((id) => shown.has(id))) continue;
      tree.append(h('div', { class: 'group', text: phase.name === 'unphased' ? 'Other runs' : title(phase.name) }));
      for (const runId of phase.runs) {
        const run = s.runs.find((r) => r.id === runId);
        if (!run || !shown.has(run.id)) continue;
        tree.append(h('button', {
          class: 'row', 'aria-pressed': String(ui.runId === run.id), dataset: { key: `run-${run.id}` },
          onclick: () => choose('run', run.id),
        },
        dotFor(run.state),
        h('span', { class: 'row-text' },
          h('span', { class: 'title', text: run.label }),
          h('span', { class: 'meta', text: [run.model ?? 'model unknown', RUN_STATE[run.state]?.[0] ?? title(run.state)].join(' · ') })),
        h('span', { class: 'aside num', text: duration(run.timing.elapsedMs) ?? '' })));
        const kids = [];
        for (const worker of run.workers) {
          kids.push(h('div', { class: 'leaf' }, dot(),
            h('span', { class: 'row-text' }, h('span', { class: 'title', text: `Worker · ${worker.id}` }), h('span', { class: 'meta', text: `${worker.model} · ${worker.status} · recorded result` }))));
        }
        for (const request of run.hostRequests) {
          kids.push(h('div', { class: 'leaf' }, dot('hollow'),
            h('span', { class: 'row-text' }, h('span', { class: 'title', text: title(request.action) }), h('span', { class: 'meta', text: 'Host request · not executed by the panel' }))));
        }
        if (kids.length) tree.append(h('div', { class: 'children' }, kids));
      }
    }
    const completed = s.runs.filter((r) => r.state === 'completed').length;
    if (hidden > 0 || (completed > 0 && ui.showCompleted === true && !ui.prefs.showCompletedRuns)) {
      tree.append(h('button', {
        class: 'button ghost small tree-toggle', dataset: { key: 'toggle-completed' },
        onclick: () => { ui.showCompleted = !showingCompleted(); render(); },
      }, hidden > 0 ? `Show ${hidden} completed` : 'Hide completed'));
    }
    return tree;
  }

  function launch(s) {
    if (!s.profiles.length) return null;
    const box = h('section', { class: 'launch', 'aria-label': 'Launch' },
      h('div', { class: 'group' }, 'Launch', h('span', { class: 'group-aside', text: s.launchEnabled ? 'Enabled' : 'Off' })));
    for (const profile of s.profiles) {
      const gate = profile.gate;
      box.append(h('div', { class: 'profile' },
        h('div', { class: 'profile-head' },
          h('span', { class: 'row-text' }, h('span', { class: 'title', text: profile.label }),
            h('span', { class: 'meta', text: `${profile.model} · ${profile.mode} · ${profile.toolProfile} tools` })),
          h('button', {
            class: 'button primary small', disabled: !profile.launch.allowed || ui.busy,
            onclick: () => openLaunch(profile.id),
          }, 'Launch…')),
        gate.reviewId ? h('p', { class: `gate ${gate.satisfied ? '' : 'warn'}`.trim() }, dot(gate.satisfied ? 'ok' : 'warn'),
          `${gate.satisfied ? 'Gate approved' : 'Waiting on gate'} · ${gate.title} · ${gate.enforcement === 'controller-enforced' ? 'controller-enforced' : gate.enforcement ?? 'gate'}`) : null,
        profile.launch.reasons.length ? h('ul', { class: 'reasons' }, profile.launch.reasons.map((reason) => h('li', { class: 'reason', text: reason }))) : null));
    }
    return box;
  }

  function runDetail(s, run) {
    const usage = run.usage.models;
    const origin = run.origin === 'controller' ? (run.owned ? 'Started by this panel' : 'Started by the panel earlier') : 'Observed only';
    const parts = [
      h('header', { class: 'detail-head', 'aria-label': 'Selected run' },
        h('div', { class: 'grow' },
          h('h2', { text: run.label }),
          line('subline', status(RUN_STATE, run.state), run.model ?? unknown('model unknown'),
            run.phase ? `${title(run.phase)} phase` : null,
            run.failureKind ? h('span', { class: 'status bad', text: run.failureKind.replaceAll('_', ' ') }) : null)),
        runActions(run)),
      runMetrics(run),
      run.kind==='session' ? null : orchestration(s, run),
      h('dl', { class: 'facts-row' },
        fact('Origin', origin),
        run.mode ? fact('Mode', MODE[run.mode] ?? run.mode) : null,
        run.toolProfile ? fact('Tools', run.toolProfile) : null,
        fact('API-active time', duration(run.timing.activeMs) ?? unknown('not reported')),
        fact('Started', run.startedAt ? `${clock(run.startedAt)} · ${ago(run.startedAt)}` : unknown())),
    ];
    if (run.errors.length) {
      parts.push(h('div', { class: 'notice bad', role: 'status' }, h('strong', { text: 'Run reported problems: ' }), run.errors.join(' · ')));
    }
    if(run.plan?.length)parts.push(section('Plan','Recorded steps',h('ul', {class:'list'},run.plan.map(step=>h('li',{},`${step.status}: ${step.step}`)))));
    parts.push(activity(run));
    const cancel = run.actions.cancel;
    const resume = run.actions.resume;
    parts.push(disclosure(`run-${run.id}`, 'Details', notes([
      ['Run', h('code', { text: run.id })],
      ['Workspace', run.workspace],
      ['Origin', run.origin === 'controller' ? 'Started through this panel’s controller.' : 'Observed from its registered run directory; the panel did not start it.'],
      ['Elapsed', run.timing.elapsedBasis],
      ['Active', run.timing.activeMs === null && run.timing.activeBasis === 'not reported' ? 'Not reported by the CLI.' : run.timing.activeBasis],
      ['Tokens', usage.length ? ['Input includes cache reads and writes.', run.usage.note].filter(Boolean).join(' ') : 'Not recorded. Nothing is estimated.'],
      ['Billing', run.usage.billing],
      ['Cancel', cancel.allowed ? 'Available' : cancel.reason],
      ['Resume', resume.allowed ? 'Available: resumes into a new run directory.' : resume.reason],
      sharingNote('run'),
    ].filter(Boolean))));
    return parts.filter(Boolean);
  }

  function runMetrics(run) {
    const models=run.usage.models;
    const output=models.length && models.every(m=>Number.isSafeInteger(m.outputTokens)) ? models.reduce((n,m)=>n+m.outputTokens,0) : null;
    const tools=run.activity.filter(e=>e.type==='tool.finished').length;
    const metric=(label,value,note,mark)=>h('div',{class:'metric'},h('div',{class:'metric-label'},icon(mark),label),h('div',{class:'metric-value num'},value??unknown('Not reported')),h('p',{class:'metric-note',text:note}));
    return h('div',{class:'metrics','aria-label':'Selected run metrics'},
      metric('Elapsed time',duration(run.timing.elapsedMs),run.kind==='session'?'Recorded span, including waits':'Wall clock for this run','clock'),
      metric('Output tokens',tokens(output),'Reported session counter','code'),
      metric('Tool completions',String(tools),'In the recorded activity','activity'));
  }

  function orchestration(s,run) {
    const hostRoute=s.routes.find(r=>r.role==='host');
    const node=(role,model,detail,tone='')=>h('div',{class:`agent-node ${tone}`},
      h('div',{class:'agent-role',text:role}),h('div',{class:'agent-model'},h('span',{class:'model-avatar',text:modelName(model).slice(0,1)}),h('strong',{text:modelName(model)})),h('p',{class:'agent-caption',text:detail}));
    const nodes=[node('Coordinates',hostRoute?.model,'Codex host · configured')];
    nodes.push(node(run.mode==='external-lead'?'Plans & reviews':'Implements',run.model,RUN_STATE[run.state]?.[0]??title(run.state),LIVE.has(run.state)?'working':''));
    for(const worker of run.workers) nodes.push(node('Implementation result',worker.model,title(worker.status)+' · recorded'));
    const flow=h('div',{class:'agent-flow'},nodes.flatMap((n,i)=>i?[icon('arrow','flow-arrow'),n]:[n]));
    return section('Model handoffs', 'Selected run',flow,
      run.hostRequests.length?h('div',{class:'handoff-note'},icon('layers'),h('span',{text:`${run.hostRequests.length} host request${run.hostRequests.length===1?'':'s'} recorded. Execution is handled by Codex, not the panel.`})):null);
  }

  function fact(label, value) {
    return h('div', {}, h('dt', { text: label }), h('dd', {}, value));
  }

  function runActions(run) {
    const box = h('div', { class: 'head-actions' });
    const cancel = run.actions.cancel;
    const resume = run.actions.resume;
    box.append(h('div', { class: 'actions' },
      discussButton('run', run.id),
      h('button', { class: 'button small', disabled: !cancel.allowed || ui.busy, title: cancel.reason ?? 'Stop this run', onclick: () => openCancel(run) }, 'Cancel'),
      h('button', { class: 'button small', disabled: !resume.allowed || ui.busy, title: resume.reason ?? 'Resume into a new run directory', onclick: () => openResume(run) }, 'Resume…')));
    const reason = !cancel.allowed && !resume.allowed && cancel.reason === resume.reason ? cancel.reason
      : [!cancel.allowed ? cancel.reason : null, !resume.allowed ? resume.reason : null].filter(Boolean)[0];
    if (reason) box.append(h('p', { class: 'reason', text: reason }));
    return box;
  }

  // Shown only when the host accepts user messages from the view.
  function discussButton(kind, id) {
    if (!host?.canDiscuss()) return null;
    return h('button', {
      class: 'button ghost small', disabled: ui.busy, dataset: { key: `discuss-${kind}-${id}` },
      title: 'Preview a short factual message about this selection, then send it to the conversation',
      onclick: () => openDiscuss(kind, id),
    }, 'Discuss in chat…');
  }

  // A text-only note in Details when selection facts reach the conversation.
  function sharingNote(kind) {
    if (!host?.canShareContext()) return null;
    return ['Conversation', `Selecting this ${kind} shares its id, label, state, model or gate, timing, and counts with the conversation. Transcripts, activity, logs, evidence, and paths are not shared.`];
  }

  function activity(run) {
    const events=run.activity.filter(e=>ui.activityFilter==='all'||(ui.activityFilter==='tools'?e.type.startsWith('tool.'):!e.type.startsWith('tool.')));
    const filters=h('div',{class:'toggle activity-filters',role:'group','aria-label':'Filter activity'},
      [['all','All activity'],['tools','Tools'],['lifecycle','Lifecycle']].map(([id,label])=>h('button',{
        'aria-pressed':String(ui.activityFilter===id),dataset:{key:`activity-${id}`},onclick:()=>{ui.activityFilter=id;ui.activityLimit=12;render();},
      },label)));
    return section('Activity', 'Recorded events',filters,
      events.length?h('ul',{class:'list activity'},events.slice(0,ui.activityLimit).map(event=>h('li',{},
        h('time',{datetime:event.at,text:clock(event.at)}),
        h('span',{class:'event-mark'},icon(event.type.startsWith('tool.')?'code':'activity')),
        h('span',{class:'event-text',text:event.text})))):h('p',{class:'muted small',text:'No activity recorded for this filter.'}),
      events.length>ui.activityLimit?h('button',{class:'button ghost small load-events',onclick:()=>{ui.activityLimit+=30;render();}},`Show more · ${events.length-ui.activityLimit} remaining`):null);
  }

  // ---------------------------------------------------------------- review

  function reviewView(s) {
    if (!s.reviews.length) {
      return h('div', { class: 'empty' }, h('h2', { text: 'No reviews registered' }),
        h('p', { text: 'The agent can post visual questions here. Your replies are saved for its next checkpoint without interrupting the conversation.' }));
    }
    if (!ui.reviewId || !s.reviews.some((r) => r.id === ui.reviewId)) {
      ui.reviewId = (s.reviews.find((r) => r.state === 'ready_for_review') ?? s.reviews[0]).id;
    }
    const review = s.reviews.find((r) => r.id === ui.reviewId);
    const pending=r=>['ready_for_review','awaiting_evidence'].includes(r.state);
    const items=ui.reviewFilter==='waiting'?s.reviews.filter(pending):s.reviews;
    const selected=s.reviews.find(r=>r.id===ui.reviewId);
    const queue=items.some(r=>r.id===ui.reviewId)||!selected?items:[selected,...items];
    return h('div',{class:'review review-inbox'},
      h('aside',{class:'review-queue'},h('h2',{text:'Visual questions'}),
        h('div',{class:'toggle','aria-label':'Question filter'},['waiting','all'].map(filter=>h('button',{'aria-pressed':String(ui.reviewFilter===filter),onclick:()=>{ui.reviewFilter=filter;ui.reviewId=null;render();}},filter==='waiting'?'Needs you':'All'))),
        queue.map(item=>h('button',{class:'question-item','aria-pressed':String(item.id===ui.reviewId),dataset:{key:`review-${item.id}`},onclick:()=>choose('review',item.id)},
          h('span',{class:'small muted',text:s.workspaces.find(w=>w.id===item.workspaceId)?.label??'Project'}),
          h('strong',{text:item.title}),h('span',{class:'small',text:REVIEW_STATE[item.state]?.[0]??title(item.state)}))),
        !items.length?h('p',{class:'small muted',text:'No questions waiting for feedback.'}):null),
      h('div',{class:'detail review-content'},...reviewDetail(s,review)));
  }

  function reviewDetail(s, review) {
    const rev = review.revision;
    const parts = [
      h('header', { class: 'detail-head', 'aria-label': `Review ${review.title}` },
        h('div', { class: 'grow' },
          h('h2', { text: review.title }),
          line('subline', status(REVIEW_STATE, review.state),
            rev ? `Revision ${rev.number}${review.revisionCount > 1 ? ` of ${review.revisionCount}` : ''}` : null,
            GATE[review.gate] ?? 'Review',
            review.approvedBy ? `Approved via ${CHANNEL[review.approvedBy] ?? review.approvedBy}` : null)),
        host?.canDiscuss() ? h('div', { class: 'head-actions' }, h('div', { class: 'actions' }, discussButton('review', review.id))) : null),
    ];
    if (review.notice) parts.push(h('div', { class: 'notice warn', role: 'status', text: review.notice }));
    parts.push(h('p',{class:'review-question',text:review.question??'What would you like to keep or change?'}));
    parts.push(compare(review));
    if (rev?.note) parts.push(h('p', { class: 'small muted' }, h('strong', { text: 'Submission note: ' }), rev.note));
    if (review.checks.length) {
      parts.push(section('What to check', null, h('ul', { class: 'bullets' }, review.checks.map((check) => h('li', { text: check })))));
    }
    parts.push(decisionForm(s, review));
    if (review.decisions.length) {
      parts.push(disclosure(`history-${review.id}`, `History · ${review.decisions.length} ${review.decisions.length === 1 ? 'decision' : 'decisions'}`,
        h('ul', { class: 'list history' }, review.decisions.slice().reverse().map((d) => h('li', { class: d.current ? '' : 'stale' },
          dot(d.decision === 'approve' ? 'ok' : 'warn'),
          h('div', {},
            h('div', {}, h('strong', { text: d.decision === 'approve' ? 'Approved' : d.decision==='feedback'?'Feedback saved':'Changes requested' }), ` · revision ${d.revision ?? '?'}`, d.current ? '' : ' · earlier evidence'),
            h('div', { class: 'who', text: `${CHANNEL[d.channel] ?? d.channel} · ${clock(d.at)} · ${ago(d.at)}` }),
            d.feedback ? h('div', { class: 'text', text: d.feedback }) : null))))));
    }
    parts.push(disclosure(`review-${review.id}`, 'Details', notes([
      ['Gate', review.gateEnforcement],
      ['Decision', transport.kind === 'mcp'
        ? 'Recorded as a host-mediated decision from this app view, bound to this exact revision. The assistant cannot record it with its own tools.'
        : 'Recorded as a decision from the local panel client (session token), bound to this exact revision. The token identifies a local client, not a person. New evidence makes it stale.'],
      ['Reference', review.reference?.label ?? 'Not registered'],
      ['Evidence', review.actual?.label ?? 'Not submitted'],
      ['Evidence hash', review.evidenceHash ? h('code', { text: review.evidenceHash.slice(0, 12) }) : null],
      sharingNote('review'),
    ].filter(Boolean))));
    return parts;
  }

  // Image elements are kept across re-renders, so a poll never reloads or
  // flickers an image whose evidence did not change.
  function imageFailure() {
    return h('div', { class: 'placeholder', text: transport.kind === 'mcp'
      ? 'This view could not display the image. Open the localhost panel to review it.'
      : 'The image could not be displayed.' });
  }

  function image(key, alt, style = '') {
    if (ui.failedImages.has(key)) return imageFailure();
    let node = ui.imageNodes.get(key);
    if (!node) {
      node = h('img', { alt, dataset: { image: key } });
      node.addEventListener('error', () => {
        if (!node.getAttribute('src')) return;
        ui.failedImages.add(key);
        ui.imageNodes.delete(key);
        node.replaceWith(imageFailure());
      });
      ui.imageNodes.set(key, node);
    }
    node.alt = alt;
    node.style.cssText = style;
    return node;
  }

  function figure(label, review, side, facts) {
    const frame = h('div', { class: 'frame' });
    if (facts?.present) {
      // Keyed by this side's image hash from the snapshot; the fetch is pinned
      // to it, so the image shown is the one the evidence hash covers.
      frame.append(image(`${review.id}|${side}|${facts.sha256 ?? 'none'}`, `${label} for ${review.title}`));
    } else {
      let message;
      if (side === 'actual') {
        message = review.revision ? 'No evidence file yet, or it is not a supported image. It appears here once the screenshot exists.' : 'No evidence yet. The builder or host submits a screenshot when the work is ready.';
      } else {
        message = facts ? 'The registered reference image is missing or not a supported image.' : 'No reference image is registered.';
      }
      frame.append(h('div', { class: 'placeholder', text: message }));
    }
    return h('figure', {}, h('figcaption', {}, h('span', { class: 'label', text: label }), h('span', { class: 'file', text: facts?.label ?? '' })), frame);
  }

  function compare(review) {
    return h('div',{class:'evidence review-stage'},
      review.actual?.present ? figure('For your review',review,'actual',review.actual) : h('p',{class:'muted',text:review.question?'Answer below. Visual material can be added to this question.':'Waiting for visual material.'}),
      review.reference?.present && review.reference.sha256!==review.actual?.sha256 ? disclosure(`context-${review.id}`,'Supporting reference',figure('Context',review,'reference',review.reference)) : null);
  }

  function decisionForm(s, review) {
    const canRespond=!s.readOnly && Boolean(review.evidenceHash);
    const canDecide=canRespond && review.actual?.present===true;
    const draftKey = `${review.id}:${review.evidenceHash}`;
    const textarea = h('textarea', {
      'aria-label': 'Feedback for the builder', placeholder: canRespond ? 'Your answer, preference, or feedback…' : 'Waiting for a question or visual material.',
      disabled: !canRespond, maxlength: '4000', rows: '3', dataset: { key: `feedback-${review.id}` },
      oninput: (event) => ui.drafts.set(draftKey, event.target.value),
    });
    textarea.id = `feedback-${review.id}`;
    textarea.value = ui.drafts.get(draftKey) ?? '';
    const decide = (decision) => act(() => transport.decide({
      reviewId: review.id, decision, feedback: textarea.value, expectedHash: review.evidenceHash,
    }), () => {
      ui.drafts.delete(draftKey);
      return decision === 'approve' ? `Approved revision ${review.revision.number}.` : decision==='feedback'?'Feedback saved. The agent can read it at its next checkpoint.':'Changes requested.';
    });
    return h('div', { class: `composer ${canRespond ? '' : 'disabled'}`.trim(), role: 'group', 'aria-label': 'Your decision' },
      h('p',{class:'small muted',text:'Reply here without interrupting the session. The agent reads saved feedback at its next checkpoint.'}),
      textarea,
      h('button',{class:'button primary',disabled:!canRespond||ui.busy,onclick:()=>{if(!textarea.value.trim()){toast('Add your answer or feedback first.','bad');textarea.focus();return;}decide('feedback');}},'Send feedback'),
      disclosure(`approval-${review.id}`,'Approval actions',h('div', { class: 'composer-foot' },
        review.demoRevisionAvailable && s.provenance === 'demo' ? h('button', {
          class: 'button ghost small', disabled: ui.busy,
          onclick: () => act(() => transport.demoRevise({ reviewId: review.id }), 'Demo: a new revision was submitted. Earlier decisions no longer apply.'),
        }, 'Simulate revised evidence (demo)') : null,
        h('span', { class: 'composer-note', text: canDecide ? `Bound to revision ${review.revision?.number ?? '?'}` : 'Waiting for evidence' }),
        h('span', { class: 'spacer' }),
        h('button', { class: 'button small', disabled: !canDecide || ui.busy, onclick: () => {
          if (!textarea.value.trim()) { toast('Describe the change you want first.', 'bad'); textarea.focus(); return; }
          decide('request_changes');
        } }, 'Request changes'),
        h('button', { class: 'button primary small', disabled: !canDecide || ui.busy, onclick: () => decide('approve') },
          review.revision ? `Approve revision ${review.revision.number}` : 'Approve'))));
  }

  async function loadImages() {
    for (const img of root.querySelectorAll('img[data-image]')) {
      const key = img.dataset.image;
      const [reviewId, side, hash] = key.split('|');
      if (ui.images.has(key)) {
        const cached = ui.images.get(key);
        if (cached.url && img.getAttribute('src') !== cached.url) img.src = cached.url;
        continue;
      }
      ui.images.set(key, { url: null });
      try {
        const url = await transport.artifact(reviewId, side, hash);
        ui.images.set(key, { url });
        for (const node of root.querySelectorAll(`img[data-image="${CSS.escape(key)}"]`)) node.src = url;
      } catch (error) {
        ui.images.delete(key);
        ui.imageNodes.delete(key);
        ui.failedImages.add(key);
        img.replaceWith(h('div', { class: 'placeholder', text: error?.message ?? 'The image could not be loaded.' }));
      }
    }
  }

  // ---------------------------------------------------------------- usage

  function usageView(s) {
    const rows = s.runs.flatMap((run) => run.usage.models.map((m) => ({ run, m })));
    const usage = section('Recorded usage', 'Session counters per run');
    if (!rows.length) usage.append(h('p', { class: 'muted small', text: 'No usage has been recorded for the registered runs. Nothing is estimated.' }));
    else {
      const cell = (n) => (Number.isSafeInteger(n) ? h('td', { title: nf.format(n), text: tokens(n) }) : h('td', {}, unknown('—')));
      usage.append(h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Run · model', 'Input', 'Output', 'Cache read', 'Cache write', 'Elapsed', 'Active', 'List-price equiv.'].map((t) => h('th', { scope: 'col', text: t })))),
        h('tbody', {}, rows.map(({ run, m }) => h('tr', {},
          h('td', {}, h('div', { text: run.label }), h('div', { class: 'small muted', text: m.model })),
          cell(m.inputTokens), cell(m.outputTokens), cell(m.cacheReadInputTokens), cell(m.cacheCreationInputTokens),
          h('td', {}, duration(run.timing.elapsedMs) ?? unknown()),
          h('td', {}, duration(run.timing.activeMs) ?? unknown('n/a')),
          h('td', {}, usd(m.billedUsd) ? `${usd(m.billedUsd)} billed` : usd(m.equivalentUsd) ?? unknown('—'))))))));
    }
    usage.append(h('p', { class: 'foot', text: 'Resumed runs can include earlier usage: do not add overlapping rows together. List-price equivalents are not bills.' }),
      disclosure('usage-notes', 'How usage is counted', notes([
        ['Rows', 'Each row shows the session counters recorded by that run. Repeated samples within a run are deduplicated; rows from different runs are listed separately.'],
        ['Time', 'Elapsed is wall clock; active is API time when the CLI reports it.'],
        ['Cost', 'Subscription list-price equivalents are not bills, and account quota is not inferred from tokens.'],
        ['Coverage', s.coverage],
      ])));
    const routes = section('Routes', 'Configured versus verified',
      h('div', { class: 'table-wrap' }, h('table', { class: 'routes' },
        h('thead', {}, h('tr', {}, ['Role', 'Model · route', 'Status'].map((t) => h('th', { scope: 'col', text: t })))),
        h('tbody', {}, s.routes.map((route) => h('tr', {},
          h('td', { text: route.label }),
          h('td', { class: 'mono', text: [route.model, route.route].filter(Boolean).join(' · ') || 'not configured' }),
          h('td', {}, status(ROUTE_STATUS, route.status))))))),
      disclosure('route-notes', 'Route details', notes(s.routes.map((route) => [route.label, route.detail]))));
    return h('div', { class: 'detail usage' }, usage, routes);
  }

  // ---------------------------------------------------------------- dialogs

  function dialog({ heading, body, confirm, danger = false, onConfirm }) {
    const node = h('dialog', { 'aria-label': heading },
      h('div', { class: 'dialog-body' }, h('h2', { text: heading }), body),
      h('div', { class: 'dialog-foot' },
        h('button', { class: 'button', onclick: () => node.close() }, 'Cancel'),
        h('button', { class: `button ${danger ? 'danger' : 'primary'}`, onclick: async () => { node.close(); await onConfirm(); } }, confirm)));
    node.addEventListener('close', () => node.remove());
    document.body.append(node);
    node.showModal();
  }

  async function openLaunch(profileId) {
    let preview;
    try {
      preview = await transport.launchPreview(profileId);
    } catch (error) {
      toast(error?.message ?? 'Could not prepare the launch.', 'bad');
      return;
    }
    const p = preview.profile;
    if (!p.launch.allowed || !preview.request.sha256 || preview.request.problems) {
      toast(p.launch.reasons[0] ?? 'This profile cannot launch right now.', 'bad');
      return;
    }
    dialog({
      heading: `Start “${p.label}”?`,
      confirm: 'Start run',
      body: [
        h('div', { class: 'callout', text: preview.notice }),
        h('dl', { class: 'facts' },
          h('dt', { text: 'Model' }), h('dd', { text: `${p.model} · ${p.route}` }),
          h('dt', { text: 'Mode' }), h('dd', { text: `${p.mode} · ${p.toolProfile} tools` }),
          h('dt', { text: 'Workspace' }), h('dd', { text: p.workspace ?? '—' }),
          h('dt', { text: 'Objective' }), h('dd', { text: preview.request.objective }),
          h('dt', { text: 'Checks' }), h('dd', { text: String(preview.request.acceptanceChecks) }),
          h('dt', { text: 'Budget' }), h('dd', { text: `$${preview.request.budgetUsd} authorized in the request` }),
          h('dt', { text: 'Deadline' }), h('dd', { text: duration(preview.deadlineSeconds * 1000) }),
          h('dt', { text: 'Request' }), h('dd', {}, h('code', { text: preview.request.sha256.slice(0, 12) }), ` · prompt ${nf.format(preview.prompt.bytes)} bytes`)),
        p.gate.reviewId ? h('p', { class: 'small muted', text: `Gate “${p.gate.title}” is approved.` }) : null,
      ],
      onConfirm: () => act(() => transport.launch({
        profileId, confirm: true, requestSha256: preview.request.sha256, promptSha256: preview.prompt.sha256,
      }), (result) => { ui.runId = result?.runId ?? ui.runId; ui.view = 'overview'; return 'Run started.'; }),
    });
  }

  async function openResume(run) {
    let preview;
    try {
      preview = await transport.resumePreview(run.id);
    } catch (error) {
      toast(error?.message ?? 'Could not prepare the resume.', 'bad');
      return;
    }
    if (!preview.allowed) {
      toast(preview.reason, 'bad');
      return;
    }
    dialog({
      heading: `Resume “${run.label}”?`,
      confirm: 'Resume run',
      body: [
        h('div', { class: 'callout', text: preview.notice }),
        h('dl', { class: 'facts' },
          h('dt', { text: 'Profile' }), h('dd', { text: preview.profile }),
          h('dt', { text: 'Prompt' }), h('dd', {}, h('code', { text: preview.prompt.sha256.slice(0, 12) }), ` · ${nf.format(preview.prompt.bytes)} bytes`),
          h('dt', { text: 'Feedback' }), h('dd', { text: preview.feedback ? `Includes your revision ${preview.feedback.revision} feedback: “${preview.feedback.text.slice(0, 280)}”` : 'No recorded feedback is included.' })),
      ],
      onConfirm: () => act(() => transport.resume({ runId: run.id, confirm: true, promptSha256: preview.prompt.sha256 }),
        (result) => { ui.runId = result?.runId ?? ui.runId; return 'Resumed into a new run.'; }),
    });
  }

  // The user sees the exact message before anything is sent; it is sent only
  // when they confirm, and only as text.
  function openDiscuss(kind, id) {
    const text = host?.discussText(ui.snapshot, { kind, id }) ?? null;
    if (!text) {
      toast('This selection is no longer registered.', 'bad');
      return;
    }
    dialog({
      heading: kind === 'run' ? 'Discuss this run in chat?' : 'Discuss this review in chat?',
      confirm: 'Send message',
      body: [
        h('p', { class: 'muted small', text: 'This sends the message below to the conversation as you. It cannot approve, request changes, or launch anything.' }),
        h('div', { class: 'callout message', text }),
      ],
      onConfirm: () => act(() => host.discuss(text), 'Sent to the conversation.'),
    });
  }

  function openCancel(run) {
    dialog({
      heading: `Stop “${run.label}”?`,
      confirm: 'Stop run',
      danger: true,
      body: h('p', { class: 'muted', text: 'The panel asks the run’s own runner to stop over its authenticated control channel. Only this run’s process group is stopped. Partial output stays in the run directory.' }),
      onConfirm: () => act(() => transport.cancel({ runId: run.id }), (result) => (result?.cancelled ? 'Stop requested.' : `Not stopped: ${result?.status ?? 'unknown'}.`)),
    });
  }

  // ---------------------------------------------------------------- start

  render();
  return {
    start(initial = null) {
      if (initial) {
        ui.snapshot = initial;
        ui.signature = JSON.stringify({ ...initial, generatedAt: null });
        ui.connection = 'live';
        ui.lastOk = new Date();
      }
      render();
      refresh({ force: true });
      schedule();
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
    },
    // An entrypoint result: its view applies unless the user (or a link)
    // already navigated; its selection is a registered id resolved server-side.
    show(snapshot, { view = null, selection = null, preferences = null } = {}) {
      transport.useDemo?.(snapshot.provenance === 'demo');
      applyPreferences(preferences);
      if (['overview', 'review', 'usage'].includes(view) && !ui.touched.view) ui.view = view;
      ui.snapshot = snapshot;
      ui.signature = JSON.stringify({ ...snapshot, generatedAt: null });
      ui.connection = 'live';
      ui.lastOk = new Date();
      render();
      if (selection?.kind === 'run') navigate({ view: 'overview', runId: selection.id });
      else if (selection?.kind === 'review') navigate({ view: 'review', reviewId: selection.id });
      flushPendingRoute();
    },
    navigate,
    notify: (message) => toast(message),
    rerender: () => render(),
    refresh: () => refresh({ force: true }),
    stop() {
      clearTimeout(ui.timer);
      clearTimeout(toast.timer);
      ui.timer = null;
      ui.stopped = true;
    },
    fail(message) {
      ui.connection = 'lost';
      ui.error = message;
      render();
    },
  };
}
