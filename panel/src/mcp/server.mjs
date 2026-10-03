// MCP server for the build panel, on the official SDKs:
//   - @modelcontextprotocol/sdk McpServer over stdio;
//   - @modelcontextprotocol/ext-apps/server registerAppTool / registerAppResource
//     for the MCP App UI resource;
//   - @openai/mcp-extensions/server schemas to validate the OpenAI UI metadata
//     (global and thread entrypoints, display modes), structured settings for
//     view preferences, and composer mention search for registered ids.
//
// Visibility split:
//   model + app  read-only entrypoints and status, evidence submission (which
//                can never record a decision), and the SDK's settings tools
//                (view preferences only);
//   app only     state polling, images, decisions, lifecycle actions, and the
//                SDK's mention search.
// App-only mutations also need a per-view nonce issued by an app-only tool.
// A decision made here is labelled host-recorded: it relies on the host
// enforcing app-only visibility, and is distinguished from a decision made in
// the token-protected localhost panel.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { OpenAIExtensions, OpenAIUiResourceMetadataSchema, OpenAIUiToolMetadataSchema } from '@openai/mcp-extensions/server';
import { z } from 'zod';
import { ID_RE, loadPanelConfig } from '../config.mjs';
import { PanelController } from '../controller.mjs';
import { createDemo } from '../demo.mjs';
import { PanelError } from '../paths.mjs';
import { DEFAULT_PREFERENCES, PREFERENCE_COMPARE, PREFERENCE_VIEWS, readPreferences, writePreferences } from '../preferences.mjs';
import { cleanLabel, selectionFacts } from '../ui/integration.mjs';

export const PANEL_URI = 'ui://codex-on-crack-panel/panel-v3';
export const MENTION_SCHEME = 'crack-panel';
export const SERVER_NAME = 'codex-on-crack-panel';
export const SERVER_VERSION = '0.5.1';
const MAX_MCP_IMAGE = 4 * 1024 * 1024;
const NONCE_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_MENTIONS = 8;
const MAX_MENTION_QUERY = 80;
const here = path.dirname(fileURLToPath(import.meta.url));

function firstExisting(candidates) {
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

// Bundle layout: server/panel.mjs + server/app.html + server/icon.svg.
// Source layout: panel/src/mcp/server.mjs, with the built app in the plugin folder.
export function readAppHtml() {
  const file = firstExisting([path.join(here, 'app.html'), path.resolve(here, '../../../plugins/codex-on-crack-panel/server/app.html')]);
  if (file === null) {
    return '<!doctype html><html><body style="font:14px system-ui;padding:24px"><p>The panel UI has not been built. Run <code>npm run build</code> in the panel plugin.</p></body></html>';
  }
  return fs.readFileSync(file, 'utf8');
}

function tidyPath(file) {
  const home = os.homedir();
  return file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
}

const text = (value) => ({ type: 'text', text: value });
function ok(structuredContent, summary) {
  return { content: [text(summary)], structuredContent };
}
function failure(error) {
  const known = error instanceof PanelError;
  return {
    isError: true,
    content: [text(known ? error.message : 'The panel could not complete the request.')],
    structuredContent: { ok: false, error: known ? error.code : 'internal_error', message: known ? error.message : 'The panel could not complete the request.' },
  };
}
async function guarded(fn) {
  try {
    return await fn();
  } catch (error) {
    return failure(error);
  }
}

function statusSummary(snapshot) {
  if (snapshot.provenance === 'unconfigured') return 'The build panel has no registered workspace yet.';
  const running = snapshot.runs.filter((r) => r.state.startsWith('running')).length;
  const waiting = snapshot.reviews.filter((r) => r.state === 'ready_for_review').map((r) => r.title);
  const approved = snapshot.reviews.filter((r) => r.state === 'approved').map((r) => r.title);
  return [
    snapshot.provenance === 'demo' ? 'DEMO DATA.' : null,
    `${snapshot.runs.length} run(s), ${running} running.`,
    waiting.length ? `Waiting for the user's visual review: ${waiting.join(', ')}.` : null,
    approved.length ? `Approved in the panel (see the recorded channel there): ${approved.join(', ')}.` : null,
    'Approvals and change requests are recorded only through the panel view; assistant tools cannot record them.',
  ].filter(Boolean).join(' ');
}

// Entrypoint arguments may name one registered run or review to select
// initially. The id is resolved against the snapshot; an unregistered id
// selects nothing and says so, without echoing the argument.
function resolveSelection(state, { runId, reviewId }) {
  if (runId !== undefined && reviewId !== undefined) throw new PanelError('selection_invalid', 'Select a run or a review, not both.', 400);
  if (runId === undefined && reviewId === undefined) return { selection: null, selectionNotice: null };
  const kind = runId !== undefined ? 'run' : 'review';
  const id = runId ?? reviewId;
  const known = state.provenance !== 'unconfigured' && (kind === 'run' ? state.runs : state.reviews).some((item) => item.id === id);
  return known
    ? { selection: { kind, id }, selectionNotice: null }
    : { selection: null, selectionNotice: `The requested ${kind} is not registered in this panel.` };
}

const idArg = (what) => z.string().regex(ID_RE).optional().describe(`Optional: a registered ${what} id from crack_panel_status to select. Selection only; it starts nothing.`);

export function createPanelServer({ configPath, leadCli, loadConfig = loadPanelConfig, clock = () => new Date() } = {}) {
  let real = null;
  let realProblem = null;
  try {
    real = new PanelController({ config: loadConfig(configPath), leadCli, clock });
  } catch (error) {
    realProblem = { message: error.message, problems: Array.isArray(error.problems) ? error.problems.slice(0, 12) : [] };
  }
  let demo = null;
  const demoController = () => {
    if (demo === null) {
      const fixture = createDemo({ clock });
      demo = { fixture, controller: new PanelController({ config: fixture.config, provenance: 'demo', demo: fixture, leadCli, clock }) };
    }
    return demo.controller;
  };
  const controllerFor = (useDemo) => {
    if (useDemo) return demoController();
    if (real === null) throw new PanelError('unconfigured', 'No panel configuration is loaded.', 409);
    real.refreshSources(loadConfig(configPath));
    return real;
  };
  const snapshot = async (useDemo = false) => {
    if (useDemo) return demoController().snapshot();
    // Recover a missing or invalid first-run configuration without restarting
    // the host. Never replace a live controller or its process ownership.
    if (real === null) {
      try {
        real = new PanelController({ config: loadConfig(configPath), leadCli, clock });
        realProblem = null;
      } catch (error) {
        realProblem = { message: error.message, problems: Array.isArray(error.problems) ? error.problems.slice(0, 12) : [] };
      }
    }
    if (real === null) {
      return {
        schemaVersion: 1, provenance: 'unconfigured', generatedAt: clock().toISOString(),
        configPath: tidyPath(configPath), problems: [realProblem?.message, ...(realProblem?.problems ?? [])].filter(Boolean),
      };
    }
    // Refresh only read-only source registrations. Preserve process ownership,
    // launch policy, review stores and all lifecycle gates in the live controller.
    try {
      const current=loadConfig(configPath);
      real.refreshSources(current);
    } catch { /* Keep the last valid registrations; source failures remain visible. */ }
    return real.snapshot();
  };
  // View preferences live with the real controller's state; without a
  // configuration they are the defaults and cannot be saved.
  const preferences = () => {const {compareMode,...current}=real===null?DEFAULT_PREFERENCES:readPreferences(real.stateDir);return current;};

  const nonces = new Map();
  const issueNonce = () => {
    const now = Date.now();
    for (const [nonce, at] of nonces) if (now - at > NONCE_TTL_MS) nonces.delete(nonce);
    const nonce = crypto.randomBytes(18).toString('hex');
    nonces.set(nonce, now);
    return nonce;
  };
  const requireNonce = (nonce) => {
    const at = typeof nonce === 'string' ? nonces.get(nonce) : undefined;
    if (at === undefined || Date.now() - at > NONCE_TTL_MS) {
      throw new PanelError('view_nonce_required', 'This action is only available from the panel view. Reopen the panel.', 403);
    }
  };

  const server = new McpServer(
    { name: SERVER_NAME, title: 'Codex on Crack', version: SERVER_VERSION },
    {
      instructions: 'Read-only status for registered codex-on-crack runs, plus a UI panel. Visual approval and requests for changes are recorded through the panel view, never by assistant tools. You may submit new screenshot evidence for a registered review with crack_panel_submit_evidence; doing so makes any earlier approval stale.',
    },
  );

  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const appOnly = (extra = {}) => ({ ui: { resourceUri: PANEL_URI, visibility: ['app'] }, ...extra });
  const entry = (type) => ({
    ui: { resourceUri: PANEL_URI },
    'openai/ui': OpenAIUiToolMetadataSchema.parse({ entrypoints: (Array.isArray(type) ? type : [type]).map(type => ({ type })) }),
  });

  registerAppResource(server, 'Build panel', PANEL_URI, {
    description: 'Phases, agents, activity, usage, and visual review for registered codex-on-crack runs.',
    mimeType: RESOURCE_MIME_TYPE,
  }, async () => ({
    contents: [{
      uri: PANEL_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: readAppHtml(),
      _meta: {
        ui: { prefersBorder: false },
        'openai/ui': OpenAIUiResourceMetadataSchema.parse({ preferredDisplayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'] }),
      },
    }],
  }));

  // ---------------------------------------------------------------- entrypoints

  registerAppTool(server, 'crack_panel', {
    title: 'Codex on Crack',
    description: 'Open the build panel: phases, agents, activity, recorded usage, routes, and visual reviews for registered runs. Read-only; optionally selects one registered run or review. Set demo to true only when the user asks to explore an example.',
    inputSchema: { runId: idArg('run'), reviewId: idArg('review'), demo: z.boolean().optional().describe('Open explicitly labelled example data instead of real registered work. Starts no models.') },
    annotations: readOnly,
    _meta: entry(['global', 'thread']),
  }, async ({ runId, reviewId, demo = false }) => guarded(async () => {
    const state = await snapshot(demo);
    const prefs = preferences();
    const picked = resolveSelection(state, { runId, reviewId });
    const view = picked.selection ? (picked.selection.kind === 'run' ? 'overview' : 'review') : prefs.defaultView;
    return ok({ view, snapshot: state, ...picked, preferences: prefs }, statusSummary(state));
  }));

  registerAppTool(server, 'crack_panel_review', {
    title: 'Codex on Crack',
    description: 'Open the visual review beside this conversation: reference versus actual evidence, checks, and the user’s decision. Read-only for the assistant; optionally selects one registered review.',
    inputSchema: { reviewId: idArg('review') },
    annotations: readOnly,
    _meta: {ui:{resourceUri:PANEL_URI}},
  }, async ({ reviewId }) => guarded(async () => {
    const state = await snapshot(false);
    return ok({ view: 'review', snapshot: state, ...resolveSelection(state, { reviewId }), preferences: preferences() }, statusSummary(state));
  }));

  // ---------------------------------------------------------------- model + app

  server.registerTool('crack_panel_status', {
    title: 'Build panel status',
    description: 'Summarise registered runs, review states, and route verification. Read-only; never records approval.',
    inputSchema: {},
    annotations: readOnly,
  }, async () => guarded(async () => {
    const state = await snapshot(false);
    if (state.provenance === 'unconfigured') return ok({ provenance: 'unconfigured' }, statusSummary(state));
    return ok({
      provenance: state.provenance,
      runs: state.runs.map((r) => ({ id: r.id, label: r.label, phase: r.phase, state: r.state, model: r.model, failureKind: r.failureKind })),
      reviews: state.reviews.map((r) => ({ id: r.id, title: r.title, gate: r.gate, state: r.state, revision: r.revision?.number ?? null, approvedBy: r.approvedBy, question:r.question, feedback:r.decisions.filter(d=>d.current).slice(-5).map(d=>({id:d.id,at:d.at,kind:d.decision,text:d.feedback,revision:d.revision})) })),
      routes: state.routes.map((r) => ({ role: r.role, model: r.model, status: r.status })),
    }, statusSummary(state));
  }));

  server.registerTool('crack_panel_submit_evidence', {
    title: 'Submit review evidence',
    description: 'Submit a new screenshot (PNG, JPEG, GIF, or WebP inside a registered workspace) as the next revision of a registered review. This never approves anything: the user decides in the panel, and any earlier approval becomes stale.',
    inputSchema: {
      reviewId: z.string().min(1).max(64).describe('A registered review id from crack_panel_status.'),
      imagePath: z.string().min(1).max(4096).describe('Absolute path of the screenshot inside a registered workspace.'),
      note: z.string().max(1000).optional().describe('What changed in this revision.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ reviewId, imagePath, note }) => guarded(async () => {
    const result = await controllerFor(false).submitEvidence({ reviewId, actual: imagePath, note: note ?? '', submittedBy: 'model-tool' });
    return ok({ submitted: true, review: { id: result.review.id, state: result.review.state, revision: result.review.revision.number } },
      `Submitted revision ${result.review.revision.number} for review. The user decides in the panel.`);
  }));

  // ---------------------------------------------------------------- app only

  const demoFlag = { demo: z.boolean().optional() };
  const nonceField = { nonce: z.string().min(1).max(100) };

  registerAppTool(server, 'panel_session', {
    title: 'Panel view session', description: 'Issue a per-view nonce for panel actions.', inputSchema: {}, annotations: readOnly, _meta: appOnly(),
  }, async () => ok({ nonce: issueNonce() }, 'Panel view session issued.'));

  registerAppTool(server, 'panel_state', {
    title: 'Panel state', description: 'Current panel snapshot.', inputSchema: demoFlag, annotations: readOnly, _meta: appOnly(),
  }, async ({ demo: useDemo }) => guarded(async () => ok({ snapshot: await snapshot(useDemo === true), preferences: preferences() }, 'Panel state.')));

  registerAppTool(server, 'panel_artifact', {
    title: 'Review image', description: 'One evidence image for a registered review.',
    inputSchema: { ...demoFlag, reviewId: z.string().min(1).max(64), side: z.enum(['reference', 'actual']), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional() },
    annotations: readOnly, _meta: appOnly(),
  }, async ({ demo: useDemo, reviewId, side, sha256: expect }) => guarded(async () => {
    const image = await controllerFor(useDemo === true).artifact(reviewId, side, expect ?? null);
    if (image.data.length > MAX_MCP_IMAGE) throw new PanelError('artifact_too_large', 'This image is too large to show in the app view; use the localhost panel.', 413);
    return ok({ type: image.type, sha256: image.sha256, base64: image.data.toString('base64') }, `${side} image`);
  }));

  registerAppTool(server, 'panel_decide', {
    title: 'Record review decision', description: 'Record the user’s decision from the panel view.',
    inputSchema: {
      ...demoFlag, ...nonceField, reviewId: z.string().min(1).max(64), decision: z.enum(['approve', 'request_changes', 'feedback']),
      feedback: z.string().max(4000).optional(), expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
    },
    _meta: appOnly(),
  }, async ({ demo: useDemo, nonce, reviewId, decision, feedback, expectedHash }) => guarded(async () => {
    requireNonce(nonce);
    const controller = controllerFor(useDemo === true);
    const result = await controller.decide({ reviewId, decision, feedback: feedback ?? '', expectedHash, channel: controller.provenance === 'demo' ? 'demo-ui' : 'mcp-app' });
    return ok({ recorded: true, state: result.review.state }, 'Decision recorded.');
  }));

  registerAppTool(server, 'panel_launch_preview', {
    title: 'Launch preview', description: 'Details for the launch confirmation dialog.',
    inputSchema: { ...demoFlag, profileId: z.string().min(1).max(64) }, annotations: readOnly, _meta: appOnly(),
  }, async ({ demo: useDemo, profileId }) => guarded(async () => ok(await controllerFor(useDemo === true).launchPreview(profileId), 'Launch preview.')));

  registerAppTool(server, 'panel_launch', {
    title: 'Launch registered profile', description: 'Start a registered launch profile after the user confirms it in the panel.',
    inputSchema: {
      ...demoFlag, ...nonceField, profileId: z.string().min(1).max(64), confirm: z.literal(true),
      requestSha256: z.string().regex(/^[0-9a-f]{64}$/), promptSha256: z.string().regex(/^[0-9a-f]{64}$/),
    },
    _meta: appOnly(),
  }, async ({ demo: useDemo, nonce, profileId, confirm, requestSha256, promptSha256 }) => guarded(async () => {
    requireNonce(nonce);
    return ok(await controllerFor(useDemo === true).launch({ profileId, confirm, requestSha256, promptSha256 }), 'Run started.');
  }));

  registerAppTool(server, 'panel_cancel', {
    title: 'Cancel owned run', description: 'Stop a run this panel process started.',
    inputSchema: { ...demoFlag, ...nonceField, runId: z.string().min(1).max(64) }, _meta: appOnly(),
  }, async ({ demo: useDemo, nonce, runId }) => guarded(async () => {
    requireNonce(nonce);
    return ok(await controllerFor(useDemo === true).cancel({ runId }), 'Cancel requested.');
  }));

  registerAppTool(server, 'panel_resume_preview', {
    title: 'Resume preview', description: 'Details for the resume confirmation dialog.',
    inputSchema: { ...demoFlag, runId: z.string().min(1).max(64) }, annotations: readOnly, _meta: appOnly(),
  }, async ({ demo: useDemo, runId }) => guarded(async () => ok(await controllerFor(useDemo === true).resumePreview(runId), 'Resume preview.')));

  registerAppTool(server, 'panel_resume', {
    title: 'Resume run', description: 'Resume a completed panel-launched run into a new run directory after confirmation.',
    inputSchema: { ...demoFlag, ...nonceField, runId: z.string().min(1).max(64), confirm: z.literal(true), promptSha256: z.string().regex(/^[0-9a-f]{64}$/) },
    _meta: appOnly(),
  }, async ({ demo: useDemo, nonce, runId, confirm, promptSha256 }) => guarded(async () => {
    requireNonce(nonce);
    return ok(await controllerFor(useDemo === true).resume({ runId, confirm, promptSha256 }), 'Resumed.');
  }));

  registerAppTool(server, 'panel_demo_revise', {
    title: 'Demo revision', description: 'Demo only: submit the next generated evidence revision.',
    inputSchema: { ...nonceField, reviewId: z.string().min(1).max(64) }, _meta: appOnly(),
  }, async ({ nonce, reviewId }) => guarded(async () => {
    requireNonce(nonce);
    const result = await demoController().demoRevise(reviewId);
    return ok({ submitted: true, state: result.review.state }, 'Demo revision submitted.');
  }));

  // ---------------------------------------------------------------- OpenAI extensions

  const openai = new OpenAIExtensions(server);

  // Structured settings: harmless view preferences only. The SDK derives the
  // tool schemas from these fields and rejects unknown keys and bad values;
  // writePreferences checks them again before persisting.
  openai.settings.register({
    fields: {
      defaultView: { schema: z.enum(PREFERENCE_VIEWS), title: 'Default view', description: 'The view the global Build panel opens on when nothing is selected.' },
      showCompletedRuns: { schema: z.boolean(), title: 'Show completed runs', description: 'List completed runs in the run tree. The selected run is always shown.' },
    },
    layout: [{ kind: 'group', title: 'Build panel view', items: [
      { kind: 'property', property: 'defaultView' },
      { kind: 'property', property: 'showCompletedRuns' },
    ] }],
    read: () => preferences(),
    update: (set) => {
      if (real === null) throw new Error('Register a workspace in the panel configuration before saving view preferences.');
      try {
        writePreferences(real, set);
        return preferences();
      } catch (error) {
        throw new Error(error instanceof PanelError ? error.message : 'The view preferences could not be saved.');
      }
    },
  });

  // Composer mentions: registered runs and reviews of the real controller,
  // matched by id or configured label. Each item is a resource whose read
  // returns the same bounded, path-free facts the view shares on selection.
  const mentionUri = (kind, id) => `${MENTION_SCHEME}://${kind}/${encodeURIComponent(id)}`;
  openai.mentions.setHandler(async ({ query }) => {
    if (real === null) return { items: [] };
    const state = await real.snapshot();
    const needle = String(query ?? '').slice(0, MAX_MENTION_QUERY).trim().toLowerCase();
    const matches = (id, label) => !needle || id.toLowerCase().includes(needle) || label.toLowerCase().includes(needle);
    const items = [];
    for (const review of state.reviews) {
      const label = cleanLabel(review.title);
      if (matches(review.id, label)) items.push({ type: 'resource', resourceUri: mentionUri('review', review.id), title: label || review.id, subtitle: 'Codex on Crack' });
    }
    for (const run of state.runs) {
      const label = cleanLabel(run.label);
      if (matches(run.id, label)) items.push({ type: 'resource', resourceUri: mentionUri('run', run.id), title: label || run.id, subtitle: 'Build run' });
    }
    return { items: items.slice(0, MAX_MENTIONS) };
  });

  // Not listed (list: undefined): these resources exist only for mentions.
  server.registerResource('Build panel selection', new ResourceTemplate(`${MENTION_SCHEME}://{kind}/{id}`, { list: undefined }), {
    description: 'Bounded facts about one registered run or review: ids, labels, states, models, timings, counts. No transcripts, logs, evidence, or paths.',
    mimeType: 'text/plain',
  }, async (uri, { kind, id }) => {
    const name = decodeURIComponent(String(id ?? ''));
    if (real === null || !['run', 'review'].includes(kind) || !ID_RE.test(name)) throw new PanelError('not_registered', 'Not a registered run or review.', 404);
    const facts = selectionFacts(await real.snapshot(), { kind, id: name });
    if (facts === null) throw new PanelError('not_registered', 'Not a registered run or review.', 404);
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: facts.text }] };
  });

  return {
    server,
    close() {
      real?.close();
      demo?.controller.close();
      demo?.fixture.cleanup();
    },
  };
}

export async function runStdioServer({ configPath, leadCli }) {
  const { server, close } = createPanelServer({ configPath, leadCli });
  const transport = new StdioServerTransport();
  const stop = () => {
    close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.stdin.on('end', stop);
  await server.connect(transport);
}
