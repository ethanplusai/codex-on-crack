// MCP App entry: runs inside the host's sandboxed iframe and talks to the panel
// server only through the official ext-apps App client (postMessage to the
// host, which forwards tool calls). Bundled with esbuild into app.html.
// Host features (theme, display mode, deep links, model context, messages)
// are wired in host.mjs from what the host advertises.
import { App } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions } from '@openai/mcp-extensions/app';
import { bindHost, createHost } from './host.mjs';
import { mountPanel } from './panel.mjs';

// The view declares the display modes it lays out for; the host decides.
const app = new App({ name: 'codex-on-crack-panel', version: '0.5.1' }, { availableDisplayModes: ['inline', 'fullscreen'] });
const openaiExtensions = new OpenAIExtensions(app);

let demo = false;
let nonce = null;
let preferences = null;

class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function tool(name, args = {}) {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) {
    const detail = result.structuredContent ?? {};
    const message = detail.message ?? result.content?.find((c) => c.type === 'text')?.text ?? 'The panel action failed.';
    throw new ToolError(detail.error ?? 'tool_error', message);
  }
  return result.structuredContent ?? {};
}

// A per-view nonce from an app-only tool; mutations must present it.
async function session() {
  if (nonce === null) nonce = (await tool('panel_session')).nonce;
  return nonce;
}

const transport = {
  kind: 'mcp',
  pollMs: 4000,
  host: createHost({ app, openai: openaiExtensions }),
  async state() {
    const result = await tool('panel_state', { demo });
    preferences = result.preferences ?? null;
    return result.snapshot;
  },
  preferences: () => preferences,
  async artifact(reviewId, side, hash) {
    const image = await tool('panel_artifact', { demo, reviewId, side, ...(/^[0-9a-f]{64}$/.test(hash ?? '') ? { sha256: hash } : {}) });
    if (!/^image\/(png|jpeg|gif|webp)$/.test(image.type)) throw new ToolError('unsupported_image', 'Unsupported image type.');
    return `data:${image.type};base64,${image.base64}`;
  },
  async decide(body) {
    return tool('panel_decide', { ...body, demo, nonce: await session() });
  },
  launchPreview: (profileId) => tool('panel_launch_preview', { demo, profileId }),
  async launch(body) {
    return tool('panel_launch', { ...body, demo, nonce: await session() });
  },
  async cancel(body) {
    return tool('panel_cancel', { ...body, demo, nonce: await session() });
  },
  resumePreview: (runId) => tool('panel_resume_preview', { demo, runId }),
  async resume(body) {
    return tool('panel_resume', { ...body, demo, nonce: await session() });
  },
  async demoRevise(body) {
    return tool('panel_demo_revise', { ...body, nonce: await session() });
  },
  async useDemo(on) {
    demo = on === true;
  },
};

const panel = mountPanel(document.getElementById('app'), transport);

// Register before connecting so the entrypoint's initial result renders
// without calling the tool again.
const host = bindHost({ app, openai: openaiExtensions, panel });

// No top-level await: the bundle is a classic inline script.
app.connect().then(() => {
  host.ready();
  panel.start();
}, () => {
  panel.fail('The host did not connect this view to the panel server.');
});
