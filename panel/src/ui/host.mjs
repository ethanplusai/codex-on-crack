// Host integration for the MCP App view, kept apart from the entry so tests
// can drive it against the official AppBridge. Every feature is read from what
// the host advertised after `app.connect()`; an absent feature is hidden, never
// simulated.
//
//   theme, style variables, fonts  ext-apps helpers on every context change
//   display mode                   hostContext.displayMode/availableDisplayModes
//                                  and app.requestDisplayMode, on a user click
//   deep links                     openai/deepLink -> parseRoute -> panel.navigate
//   model context                  on an explicit selection only: bounded facts
//   user message                   "Discuss in chat", after the user confirms
//                                  the exact text; never sent automatically
import { applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { discussText, parseRoute, selectionFacts } from './integration.mjs';

const ENTRYPOINTS = { crack_panel: 'global', crack_panel_review: 'thread' };
const MODES = ['inline', 'fullscreen', 'pip'];

// The capability-gated surface the renderer sees as `transport.host`.
export function createHost({ app, openai }) {
  const caps = () => app.getHostCapabilities() ?? {};
  const context = () => app.getHostContext() ?? {};
  // The OpenAI extension when the host advertises it, else the standard MCP
  // Apps request when the host advertises text support for it, else nothing.
  const messenger = () => openai.message ?? (caps().message?.text ? { send: (params) => app.sendMessage(params) } : null);
  const contextUpdater = () => openai.modelContext ?? (caps().updateModelContext?.text ? { update: (params) => app.updateModelContext(params) } : null);
  let lastShared = null;

  return {
    canDiscuss: () => messenger() !== null,
    canShareContext: () => contextUpdater() !== null,
    discussText,
    async discuss(text) {
      const api = messenger();
      if (api === null) throw new Error('This host does not accept messages from the panel.');
      if (typeof text !== 'string' || !text || text.length > 1000) throw new Error('Nothing to send.');
      const result = await api.send({ role: 'user', content: [{ type: 'text', text }] });
      if (result?.isError) throw new Error('The host did not accept the message.');
    },
    // Bounded facts for an explicit selection; repeated selections of the
    // same item send nothing new.
    async shareSelection(snapshot, selection) {
      const api = contextUpdater();
      const facts = api ? selectionFacts(snapshot, selection) : null;
      if (facts === null) return false;
      const key = JSON.stringify(facts);
      if (key === lastShared) return false;
      await api.update({ content: [{ type: 'text', text: facts.text }], structuredContent: { buildPanelSelection: facts.structured } });
      lastShared = key;
      return true;
    },
    // { current, target, label } when the host offers a different mode, else null.
    displayToggle() {
      const { displayMode: current, availableDisplayModes: available } = context();
      if (!MODES.includes(current) || !Array.isArray(available)) return null;
      const target = current === 'fullscreen' ? 'inline' : 'fullscreen';
      if (!available.includes(target)) return null;
      return { current, target, label: target === 'fullscreen' ? 'Full screen' : 'Exit full screen' };
    },
    async requestDisplayMode(mode) {
      const result = await app.requestDisplayMode({ mode });
      return result?.mode ?? null;
    },
  };
}

// Reflect host context on the document: theme and tokens, plus data
// attributes the stylesheet uses for display mode, platform, and entrypoint.
export function applyHostContext(context, root = document.documentElement) {
  if (!context) return;
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
  if (MODES.includes(context.displayMode)) root.dataset.displayMode = context.displayMode;
  if (['web', 'desktop', 'mobile'].includes(context.platform)) root.dataset.platform = context.platform;
  const entry = ENTRYPOINTS[context.toolInfo?.tool?.name];
  if (entry) root.dataset.entry = entry;
  const insets = context.safeAreaInsets;
  if (insets) {
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const value = Number(insets[side]);
      if (Number.isFinite(value) && value >= 0 && value <= 200) root.style.setProperty(`--p-safe-${side}`, `${value}px`);
    }
  }
}

// Wire a connected-or-connecting app to a mounted panel. Call before
// `app.connect()`, then call `ready()` once it resolves.
export function bindHost({ app, openai, panel, root = document.documentElement }) {
  let lastLink = null;
  // A link is applied once per distinct URL, so later context changes
  // (theme, size) never pull the user away from where they navigated.
  function handleDeepLink() {
    const link = openai.deepLink.getCurrent();
    if (!link || link.url === lastLink) return;
    lastLink = link.url;
    const route = parseRoute(link.url);
    if (route === null) panel.notify('This link does not point to a panel view.');
    else panel.navigate(route, { source: 'link' });
  }
  app.ontoolresult = (result) => {
    const content = result?.structuredContent;
    if (content?.snapshot) {
      panel.show(content.snapshot, { view: content.view, selection: content.selection ?? null, preferences: content.preferences ?? null });
      if (content.selectionNotice) panel.notify(content.selectionNotice);
    }
  };
  app.addEventListener('hostcontextchanged', () => {
    applyHostContext(app.getHostContext(), root);
    handleDeepLink();
    panel.rerender();
  });
  return {
    ready() {
      applyHostContext(app.getHostContext(), root);
      handleDeepLink();
    },
  };
}
