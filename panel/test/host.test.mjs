// Host integration over the real MCP Apps protocol: the official AppBridge
// plays the host (in memory, no network, no model), and the view runs the
// same host.mjs and panel.mjs as the bundle, with the official App and
// OpenAIExtensions clients. Each test checks one host profile: nothing
// advertised, OpenAI extensions advertised, standard MCP Apps capabilities
// only, and an entrypoint result with a selection and preferences.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelController } from '../src/controller.mjs';
import { createDemo } from '../src/demo.mjs';
import { hasModule, waitFor } from './fixtures.mjs';

const ready = hasModule('jsdom') && hasModule('@modelcontextprotocol/ext-apps') && hasModule('@openai/mcp-extensions');
const skip = !ready && 'jsdom or the MCP Apps SDKs are not installed (npm ci)';

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

const until = async (predicate, message) => assert.ok(await waitFor(predicate, 10_000, 20), message);
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const buttons = (window, text) => [...window.document.querySelectorAll('button')].filter((b) => (b.querySelector('strong')?.textContent??b.textContent).trim().startsWith(text));
const button = (window, text) => buttons(window, text)[0];

// A view wired exactly like mcp-entry.mjs, against an AppBridge host.
async function mounted(t, { capabilities = {}, hostContext = {}, preferences = null } = {}) {
  const window = await dom(t);
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { App } = await import('@modelcontextprotocol/ext-apps');
  const { AppBridge } = await import('@modelcontextprotocol/ext-apps/app-bridge');
  const { OpenAIExtensions } = await import('@openai/mcp-extensions/app');
  const { bindHost, createHost } = await import('../src/ui/host.mjs');
  const { mountPanel } = await import('../src/ui/panel.mjs');

  const demo = createDemo();
  t.after(() => demo.cleanup());
  const controller = new PanelController({ config: demo.config, provenance: 'demo', demo });

  const calls = { message: [], context: [], display: [] };
  const bridge = new AppBridge(null, { name: 'test-host', version: '0.0.0' }, capabilities, { hostContext });
  bridge.onmessage = async (params) => { calls.message.push(params); return {}; };
  bridge.onupdatemodelcontext = async (params) => { calls.context.push(params); return {}; };
  bridge.onrequestdisplaymode = async ({ mode }) => { calls.display.push(mode); return { mode }; };
  const [hostSide, appSide] = InMemoryTransport.createLinkedPair();
  await bridge.connect(hostSide);

  const app = new App({ name: 'codex-on-crack-panel', version: '0.2.0' }, { availableDisplayModes: ['inline', 'fullscreen'] }, { autoResize: false });
  const openai = new OpenAIExtensions(app);
  const transport = {
    kind: 'mcp',
    pollMs: 60_000,
    host: createHost({ app, openai }),
    state: () => controller.snapshot(),
    preferences: () => preferences,
    async artifact(reviewId, side, hash) {
      const image = await controller.artifact(reviewId, side, hash);
      return `data:${image.type};base64,${image.data.toString('base64')}`;
    },
    decide: () => assert.fail('no decision is made in these tests'),
    launchPreview: (id) => controller.launchPreview(id),
    launch: () => assert.fail('no launch in these tests'),
    cancel: () => assert.fail('no cancel in these tests'),
    resumePreview: (id) => controller.resumePreview(id),
    resume: () => assert.fail('no resume in these tests'),
    demoRevise: () => assert.fail('no revision in these tests'),
  };
  const panel = mountPanel(window.document.getElementById('app'), transport);
  const binding = bindHost({ app, openai, panel });
  await app.connect(appSide);
  binding.ready();
  panel.start();
  t.after(async () => {
    panel.stop();
    await app.close();
  });
  await until(() => window.document.querySelector('.tab'), 'the view renders');
  return { window, bridge, calls, controller, demo, panel, host: transport.host };
}

const OPENAI = { experimental: { 'openai/message': {}, 'openai/modelContext': {} } };
const CONTEXT = {
  theme: 'dark', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'], platform: 'desktop',
  toolInfo: { tool: { name: 'crack_panel_review', inputSchema: { type: 'object' } } },
  styles: { variables: { '--color-background-primary': '#101010' } },
  safeAreaInsets: { top: 4, right: 0, bottom: 0, left: 0 },
};

test('host advertises nothing: no host controls, nothing shared or sent', { skip }, async (t) => {
  const { window, calls, host } = await mounted(t);
  assert.equal(host.canDiscuss(), false);
  assert.equal(host.canShareContext(), false);
  assert.equal(host.displayToggle(), null);
  assert.equal(button(window, 'Discuss in chat'), undefined);
  assert.equal(window.document.querySelector('.display-mode'), null);
  assert.equal(window.document.documentElement.dataset.displayMode, undefined);

  button(window, 'Design lead').click();
  button(window, 'Review').click();
  await until(() => button(window, 'Final build'), 'review tabs render');
  button(window, 'Final build').click();
  await settle();
  assert.equal(button(window, 'Discuss in chat'), undefined);
  assert.doesNotMatch(window.document.body.textContent, /shares its id/);
  assert.deepEqual(calls, { message: [], context: [], display: [] });
  await assert.rejects(host.discuss('hello'), /does not accept messages/);
});

test('OpenAI extensions: deep link, host context, bounded selection context, user-confirmed message, display mode', { skip }, async (t) => {
  const { window, bridge, calls, demo } = await mounted(t, {
    capabilities: OPENAI, hostContext: { ...CONTEXT, 'openai/deepLink': { url: '/reviews/final' } },
  });
  const root = window.document.documentElement;
  const selectedReview = () => window.document.querySelector('.question-item[aria-pressed="true"] strong')?.textContent;

  // The link selects a registered review; it shares and sends nothing.
  await until(() => selectedReview() === 'Final build', 'the deep link selects the review');
  assert.equal(root.dataset.displayMode, 'inline');
  assert.equal(root.dataset.entry, 'thread');
  assert.equal(root.dataset.platform, 'desktop');
  assert.equal(root.style.getPropertyValue('--color-background-primary'), '#101010');
  assert.equal(root.style.getPropertyValue('--p-safe-top'), '4px');
  assert.match(root.outerHTML, /dark/);
  await settle();
  assert.deepEqual([calls.message.length, calls.context.length], [0, 0], 'opening and linking share nothing');

  // An explicit selection shares bounded facts once.
  button(window, 'Dashboard layout').click();
  await until(() => calls.context.length === 1, 'the selection reaches the model context');
  const shared = calls.context[0];
  assert.match(shared.content[0].text, /review 'Dashboard layout' \[id design\]/);
  assert.equal(shared.structuredContent.buildPanelSelection.kind, 'review');
  const sharedText = JSON.stringify(shared);
  for (const ws of demo.config.workspaces) assert.ok(!sharedText.includes(ws.root), 'no paths');
  assert.ok(sharedText.length < 2000, 'bounded');
  button(window, 'Dashboard layout').click();
  await settle();
  assert.equal(calls.context.length, 1, 'the same selection is not re-sent');
  assert.match(window.document.body.textContent, /Selecting this review shares its id/);

  // Discuss: a preview first; nothing is sent on cancel; one message on confirm.
  button(window, 'Discuss in chat').click();
  const dialog = window.document.querySelector('dialog[open]');
  const previewed = dialog.querySelector('.callout.message').textContent;
  assert.match(previewed, /^Let's discuss build panel review 'Dashboard layout' \[id design\] \(demo data\)/);
  [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click();
  await settle();
  assert.equal(calls.message.length, 0, 'cancel sends nothing');
  button(window, 'Discuss in chat').click();
  [...window.document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Send message').click();
  await until(() => calls.message.length === 1, 'the confirmed message is sent');
  assert.deepEqual(calls.message[0], { role: 'user', content: [{ type: 'text', text: previewed }] });
  assert.equal(calls.context.length, 1, 'discussing does not share more context');

  // Display mode: offered from host context, requested on click, reflected from the host.
  button(window, 'Full screen').click();
  await until(() => calls.display.length === 1, 'the display mode is requested');
  assert.deepEqual(calls.display, ['fullscreen']);
  bridge.setHostContext({ ...CONTEXT, displayMode: 'fullscreen', 'openai/deepLink': { url: '/reviews/final' } });
  await until(() => root.dataset.displayMode === 'fullscreen' && button(window, 'Exit full screen'), 'the host-reported mode is shown');
  assert.equal(selectedReview(), 'Dashboard layout', 'an unchanged link does not move the user');

  // New links: a registered run, then refused and unregistered links that change nothing.
  bridge.setHostContext({ ...CONTEXT, 'openai/deepLink': { url: '/runs/design-lead' } });
  await until(() => window.document.querySelector('.row[aria-pressed="true"]')?.textContent.includes('Design lead'), 'the run link selects the run');
  for (const [url, notice] of [['https://evil.example/runs/x', /does not point to a panel view/], ['/runs/ghost', /not registered/]]) {
    bridge.setHostContext({ ...CONTEXT, 'openai/deepLink': { url } });
    await until(() => notice.test(window.document.querySelector('.toast')?.textContent ?? ''), `notice for ${url}`);
    assert.ok(window.document.querySelector('.row[aria-pressed="true"]')?.textContent.includes('Design lead'), 'the selection is unchanged');
  }
  assert.equal(calls.message.length, 1, 'no further messages');
});

test('standard MCP Apps capabilities: message and context through the base requests', { skip }, async (t) => {
  const { window, calls, host } = await mounted(t, { capabilities: { message: { text: {} }, updateModelContext: { text: {} } } });
  assert.equal(host.canDiscuss(), true);
  assert.equal(host.canShareContext(), true);
  assert.equal(host.displayToggle(), null, 'no display toggle without host-reported modes');
  button(window, 'Implementation lead').click();
  await until(() => calls.context.length === 1, 'selection shared through ui/update-model-context');
  assert.match(calls.context[0].content[0].text, /run 'Implementation lead' \[id implementation-lead\]/);
  button(window, 'Discuss in chat').click();
  [...window.document.querySelectorAll('dialog[open] button')].find((b) => b.textContent === 'Send message').click();
  await until(() => calls.message.length === 1, 'message sent through ui/message');
  assert.match(calls.message[0].content[0].text, /^Let's discuss build panel run 'Implementation lead'/);
});

test('image-only message support is not treated as text support', { skip }, async (t) => {
  const { window, host } = await mounted(t, { capabilities: { message: { image: {} }, updateModelContext: { image: {} } } });
  assert.equal(host.canDiscuss(), false);
  assert.equal(host.canShareContext(), false);
  assert.equal(button(window, 'Discuss in chat'), undefined);
});

test('entrypoint result: server-resolved selection and view preferences', { skip }, async (t) => {
  const { window, bridge, controller } = await mounted(t);
  const snapshot = await controller.snapshot();
  bridge.sendToolInput({ arguments: { runId: 'design-lead' } });
  bridge.sendToolResult({
    content: [],
    structuredContent: {
      view: 'overview', snapshot, selection: { kind: 'run', id: 'design-lead' }, selectionNotice: null,
      preferences: { defaultView: 'usage', showCompletedRuns: false, compareMode: 'overlay' },
    },
  });
  // The selected completed run stays visible even though completed runs are hidden.
  await until(() => window.document.querySelector('.row[aria-pressed="true"]')?.textContent.includes('Design lead'), 'the selected run is shown');
  button(window, 'Implementation lead').click();
  await until(() => !button(window, 'Design lead') && button(window, 'Show 1 completed'), 'completed runs follow the preference');
  button(window, 'Show 1 completed').click();
  assert.ok(button(window, 'Design lead'), 'the user can show them for this view');
  button(window, 'Review').click();
  assert.equal(window.document.querySelector('[aria-label="Comparison mode"]'),null,'legacy preferences cannot restore the removed comparison UI');

  // An unregistered selection is reported, not applied.
  bridge.sendToolResult({ content: [], structuredContent: { view: 'review', snapshot, selection: null, selectionNotice: 'The requested run is not registered in this panel.' } });
  await until(() => /not registered/.test(window.document.querySelector('.toast')?.textContent ?? ''), 'the notice is shown');
});

test('the default view preference applies once, before the user navigates', { skip }, async (t) => {
  const { window } = await mounted(t, { preferences: { defaultView: 'usage', showCompletedRuns: true, compareMode: 'side-by-side' } });
  await until(() => window.document.querySelector('.tab[aria-selected="true"]')?.textContent === 'Usage & routes', 'opens on the preferred view');
  button(window, 'Overview').click();
  assert.equal(window.document.querySelector('.tab[aria-selected="true"]').textContent, 'Overview');
});
