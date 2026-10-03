// MCP protocol checks with the official client SDK over stdio, against the
// source server and the built bundle: initialize, tools/list (entrypoints and
// app-only visibility), resources/read (the MCP App HTML), and tool calls.
// Skipped only when the pinned dependencies are not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DEV_ROOT, PLUGIN_ROOT, configDoc, hasModule, workspace } from './fixtures.mjs';

const ready = hasModule('@modelcontextprotocol/sdk') && hasModule('@openai/mcp-extensions') && hasModule('@modelcontextprotocol/ext-apps');
const URI = 'ui://codex-on-crack-panel/panel-v3';

async function connect(t, entry, configPath) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'panel-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [entry, 'mcp', '--config', configPath], cwd: PLUGIN_ROOT, stderr: 'pipe',
  }));
  t.after(() => client.close());
  return client;
}

async function writeConfig(ws) {
  const doc = configDoc(ws);
  doc.launch.enabled = false;
  const file = path.join(ws.base, 'panel.json');
  await fsp.writeFile(file, JSON.stringify(doc));
  return file;
}

for (const [label, entry] of [['source', path.join(DEV_ROOT, 'src/cli.mjs')], ['bundle', './server/panel.mjs']]) {
  test(`MCP ${label}: initialize, entrypoints, app-only tools, and the UI resource`, { skip: !ready && 'pinned MCP dependencies are not installed (npm ci)' }, async (t) => {
    if (label === 'bundle' && !fs.existsSync(path.join(PLUGIN_ROOT, entry))) {
      assert.fail('server/panel.mjs is missing; run npm run build');
    }
    const { OpenAIUiToolMetadataSchema, OpenAIUiResourceMetadataSchema } = await import('@openai/mcp-extensions/server');
    const { RESOURCE_MIME_TYPE } = await import('@modelcontextprotocol/ext-apps/server');
    const ws = await workspace(t);
    const client = await connect(t, entry, await writeConfig(ws));

    const info = client.getServerVersion();
    assert.equal(info.name, 'codex-on-crack-panel');
    assert.equal(info.icons, undefined, 'text-only entrypoints do not advertise a brand icon');
    assert.equal(info.title,'Codex on Crack');

    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const global = byName.get('crack_panel');
    const thread = byName.get('crack_panel_review');
    assert.deepEqual(OpenAIUiToolMetadataSchema.parse(global._meta['openai/ui']).entrypoints, [{ type: 'global' }, { type: 'thread' }]);
    assert.equal(thread._meta['openai/ui'],undefined,'review selection reuses the canonical panel instead of advertising a second tab');
    assert.equal(global._meta.ui.resourceUri, URI);
    assert.equal(global.title,'Codex on Crack');
    assert.equal(thread.title,'Codex on Crack');
    // Optional registered ids and an explicit demo boolean: no paths or commands.
    assert.deepEqual(Object.keys(global.inputSchema.properties).sort(), ['demo', 'reviewId', 'runId']);
    assert.deepEqual(Object.keys(thread.inputSchema.properties), ['reviewId']);
    for (const schema of [global.inputSchema, thread.inputSchema]) {
      assert.deepEqual(schema.required ?? [], []);
      for (const [name,property] of Object.entries(schema.properties)) {
        if (name === 'demo') assert.equal(property.type, 'boolean');
        else assert.equal(property.pattern, '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');
      }
    }

    // Everything that records a decision or changes lifecycle is app-only.
    for (const name of ['panel_session', 'panel_state', 'panel_artifact', 'panel_decide', 'panel_launch', 'panel_cancel', 'panel_resume', 'panel_demo_revise', 'search_mentions']) {
      assert.deepEqual(byName.get(name)?._meta?.ui?.visibility, ['app'], `${name} must be app-only`);
    }
    // The SDK's settings tools stay as the SDK registers them; they carry view preferences only.
    const modelVisible = tools.filter((tool) => !tool._meta?.ui?.visibility?.length || tool._meta.ui.visibility.includes('model')).map((tool) => tool.name).sort();
    assert.deepEqual(modelVisible, ['crack_panel', 'crack_panel_review', 'crack_panel_status', 'crack_panel_submit_evidence', 'settings.read', 'settings.update']);

    const { resources } = await client.listResources();
    assert.deepEqual(resources.map((r) => [r.uri, r.mimeType]), [[URI, RESOURCE_MIME_TYPE]]);
    const read = await client.readResource({ uri: URI });
    const content = read.contents[0];
    assert.equal(content.mimeType, RESOURCE_MIME_TYPE);
    OpenAIUiResourceMetadataSchema.parse(content._meta['openai/ui']);
    assert.match(content.text, /^<!doctype html>/);
    assert.match(content.text, /<script>/);
    assert.doesNotMatch(content.text, /<script[^>]+src=|<link[^>]+href=/, 'the app is one self-contained document');

    const opened = await client.callTool({ name: 'crack_panel', arguments: {} });
    assert.equal(opened.isError, undefined);
    assert.equal(opened.structuredContent.snapshot.provenance, 'real');
    assert.equal(opened.structuredContent.snapshot.reviews[0].state, 'ready_for_review');
    const threadOpen = await client.callTool({ name: 'crack_panel_review', arguments: {} });
    assert.equal(threadOpen.structuredContent.view, 'review');

    // The model-visible status tool cannot approve, and a decision without the
    // view nonce is refused even though the tool exists.
    const hash = opened.structuredContent.snapshot.reviews[0].evidenceHash;
    const refused = await client.callTool({ name: 'panel_decide', arguments: { nonce: 'guess', reviewId: 'design', decision: 'approve', expectedHash: hash } });
    assert.equal(refused.isError, true);
    assert.equal(refused.structuredContent.error, 'view_nonce_required');
    const { structuredContent: { nonce } } = await client.callTool({ name: 'panel_session', arguments: {} });
    const decided = await client.callTool({ name: 'panel_decide', arguments: { nonce, reviewId: 'design', decision: 'approve', expectedHash: hash } });
    assert.equal(decided.structuredContent.state, 'approved');
    let state = (await client.callTool({ name: 'panel_state', arguments: {} })).structuredContent.snapshot;
    assert.equal(state.reviews[0].decisions[0].channel, 'mcp-app', 'host-mediated decisions are labelled as such');

    // New evidence from the model makes the approval stale.
    const submitted = await client.callTool({ name: 'crack_panel_submit_evidence', arguments: { reviewId: 'design', imagePath: path.join(ws.root, 'evidence', 'actual-2.png'), note: 'fixed spacing' } });
    assert.equal(submitted.structuredContent.review.state, 'ready_for_review');
    const outside = await client.callTool({ name: 'crack_panel_submit_evidence', arguments: { reviewId: 'design', imagePath: path.join(ws.outside, 'secret.png') } });
    assert.equal(outside.isError, true);
    assert.equal(outside.structuredContent.error, 'outside_roots');
    const status = await client.callTool({ name: 'crack_panel_status', arguments: {} });
    assert.equal(status.structuredContent.reviews[0].state, 'ready_for_review');
    assert.match(status.content[0].text, /assistant tools cannot record them/);

    const current=(await client.callTool({name:'panel_state',arguments:{}})).structuredContent.snapshot.reviews[0];
    await client.callTool({name:'panel_decide',arguments:{nonce,reviewId:'design',decision:'feedback',feedback:'Prefer the softer direction.',expectedHash:current.evidenceHash}});
    const inbox=(await client.callTool({name:'crack_panel_status',arguments:{}})).structuredContent.reviews[0];
    assert.equal(inbox.state,'feedback_received');assert.equal(inbox.approvedBy,null);assert.equal(inbox.feedback.at(-1).text,'Prefer the softer direction.');

    const image = await client.callTool({ name: 'panel_artifact', arguments: { reviewId: 'design', side: 'actual' } });
    assert.equal(image.structuredContent.type, 'image/png');
    assert.ok(Buffer.from(image.structuredContent.base64, 'base64').subarray(1, 4).toString() === 'PNG');
    // Pinned to the hash the view's snapshot showed: a different hash is refused.
    const pinned = await client.callTool({ name: 'panel_artifact', arguments: { reviewId: 'design', side: 'actual', sha256: image.structuredContent.sha256 } });
    assert.equal(pinned.structuredContent.sha256, image.structuredContent.sha256);
    const mismatch = await client.callTool({ name: 'panel_artifact', arguments: { reviewId: 'design', side: 'actual', sha256: '0'.repeat(64) } });
    assert.equal(mismatch.isError, true);

    const demo = (await client.callTool({ name: 'panel_state', arguments: { demo: true } })).structuredContent.snapshot;
    assert.equal(demo.provenance, 'demo');
    state = (await client.callTool({ name: 'panel_state', arguments: {} })).structuredContent.snapshot;
    assert.equal(state.provenance, 'real');
    const launch = await client.callTool({ name: 'panel_launch', arguments: { nonce, profileId: 'impl', confirm: true, requestSha256: 'a'.repeat(64), promptSha256: 'b'.repeat(64) } });
    assert.equal(launch.isError, true, 'launching is off in this configuration');
    const text = JSON.stringify(state);
    assert.ok(!text.includes(ws.root) && !text.includes(ws.state), 'no filesystem paths in the snapshot');
  });
}

test('MCP without a configuration reports an honest unconfigured state', { skip: !ready && 'pinned MCP dependencies are not installed (npm ci)' }, async (t) => {
  const ws = await workspace(t);
  const client = await connect(t, path.join(DEV_ROOT, 'src/cli.mjs'), path.join(ws.base, 'missing.json'));
  const opened = await client.callTool({ name: 'crack_panel', arguments: {} });
  assert.equal(opened.structuredContent.snapshot.provenance, 'unconfigured');
  assert.match(opened.content[0].text, /no registered workspace/);
  const submit = await client.callTool({ name: 'crack_panel_submit_evidence', arguments: { reviewId: 'x', imagePath: '/tmp/x.png' } });
  assert.equal(submit.structuredContent.error, 'unconfigured');
});

for (const [label, entry] of [['source', path.join(DEV_ROOT, 'src/cli.mjs')], ['bundle', './server/panel.mjs']]) {
  test(`MCP ${label}: view settings, entrypoint selection, and registered mentions`, { skip: !ready && 'pinned MCP dependencies are not installed (npm ci)' }, async (t) => {
    const { OpenAISettingsReadResultSchema, OpenAIMentionSearchResultSchema } = await import('@openai/mcp-extensions/server');
    const ws = await workspace(t);
    const client = await connect(t, entry, await writeConfig(ws));

    // Settings are advertised through the SDK capability and hold view preferences only.
    assert.deepEqual(client.getServerCapabilities().experimental?.['openai/settings'], { readTool: 'settings.read', updateTool: 'settings.update' });
    const read = await client.callTool({ name: 'settings.read', arguments: {} });
    const settings = OpenAISettingsReadResultSchema.parse(read.structuredContent);
    assert.deepEqual(Object.keys(settings.schema.properties).sort(), ['defaultView', 'showCompletedRuns']);
    assert.deepEqual(settings.values, { defaultView: 'overview', showCompletedRuns: true });
    assert.ok(!/model|launch|root|token|credential|approv/i.test(Object.keys(settings.schema.properties).join(' ')));

    const updated = await client.callTool({ name: 'settings.update', arguments: { set: { defaultView: 'usage', showCompletedRuns: false } } });
    assert.equal(updated.isError, undefined);
    assert.deepEqual(updated.structuredContent.values, { defaultView: 'usage', showCompletedRuns: false });
    const file = path.join(ws.state, 'preferences.json');
    const stored = fs.readFileSync(file, 'utf8');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    for (const bad of [{ launchEnabled: true }, { defaultView: '../x' }, { showCompletedRuns: 'yes' }, {}]) {
      const refused = await client.callTool({ name: 'settings.update', arguments: { set: bad } });
      assert.equal(refused.isError, true, `refused: ${JSON.stringify(bad)}`);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), stored, 'refused updates change nothing');
    assert.deepEqual(fs.readdirSync(ws.state).filter((name) => name.endsWith('.tmp')), [], 'no temporary files are left');

    // Preferences reach the view, and the global entrypoint opens on the default view.
    const opened = await client.callTool({ name: 'crack_panel', arguments: {} });
    assert.equal(opened.structuredContent.view, 'usage');
    assert.equal(opened.structuredContent.selection, null);
    assert.equal(opened.structuredContent.preferences.showCompletedRuns, false);
    assert.equal((await client.callTool({ name: 'panel_state', arguments: {} })).structuredContent.preferences.defaultView, 'usage');

    // Entrypoint selection: registered ids only, resolved by the server.
    const picked = await client.callTool({ name: 'crack_panel_review', arguments: { reviewId: 'design' } });
    assert.deepEqual(picked.structuredContent.selection, { kind: 'review', id: 'design' });
    assert.equal(picked.structuredContent.view, 'review');
    const viaGlobal = await client.callTool({ name: 'crack_panel', arguments: { reviewId: 'design' } });
    assert.equal(viaGlobal.structuredContent.view, 'review', 'a selection decides the view');
    const unknown = await client.callTool({ name: 'crack_panel', arguments: { runId: 'not-registered-7' } });
    assert.equal(unknown.isError, undefined);
    assert.equal(unknown.structuredContent.selection, null);
    assert.match(unknown.structuredContent.selectionNotice, /not registered/);
    assert.ok(!JSON.stringify(unknown.structuredContent.selectionNotice).includes('not-registered-7'), 'the argument is not echoed');
    for (const args of [{ runId: '../etc/passwd' }, { reviewId: '/abs/path' }, { runId: 'x'.repeat(65) }, { runId: 'a b' }]) {
      const refused = await client.callTool({ name: 'crack_panel', arguments: args });
      assert.equal(refused.isError, true, `refused: ${JSON.stringify(args)}`);
    }
    const both = await client.callTool({ name: 'crack_panel', arguments: { runId: 'a', reviewId: 'design' } });
    assert.equal(both.structuredContent.error, 'selection_invalid');

    // Mentions: bounded search over registered items, resolved to bounded, path-free facts.
    const found = OpenAIMentionSearchResultSchema.parse((await client.callTool({ name: 'search_mentions', arguments: { query: 'dash' } })).structuredContent);
    assert.deepEqual(found.items, [{ type: 'resource', resourceUri: 'crack-panel://review/design', title: 'Dashboard layout', subtitle: 'Codex on Crack' }]);
    assert.deepEqual((await client.callTool({ name: 'search_mentions', arguments: { query: 'zzz' } })).structuredContent.items, []);
    assert.ok((await client.callTool({ name: 'search_mentions', arguments: { query: '' } })).structuredContent.items.length <= 8);
    assert.deepEqual((await client.callTool({ name: 'search_mentions', arguments: { query: 'd'.repeat(10_000) } })).structuredContent.items, []);
    const facts = await client.readResource({ uri: 'crack-panel://review/design' });
    assert.equal(facts.contents[0].mimeType, 'text/plain');
    assert.match(facts.contents[0].text, /review 'Dashboard layout' \[id design\]/);
    assert.ok(facts.contents[0].text.length <= 900);
    assert.ok(!facts.contents[0].text.includes(ws.root) && !facts.contents[0].text.includes(ws.state), 'no paths');
    for (const uri of ['crack-panel://review/missing', 'crack-panel://file/design', 'crack-panel://review/..%2F..%2Fetc']) {
      await assert.rejects(client.readResource({ uri }), `refused: ${uri}`);
    }
    assert.deepEqual((await client.listResources()).resources.map((r) => r.uri), [URI], 'mention resources are not listed');
  });
}

test('MCP settings without a configuration read defaults and refuse to save', { skip: !ready && 'pinned MCP dependencies are not installed (npm ci)' }, async (t) => {
  const ws = await workspace(t);
  const client = await connect(t, path.join(DEV_ROOT, 'src/cli.mjs'), path.join(ws.base, 'missing.json'));
  const read = await client.callTool({ name: 'settings.read', arguments: {} });
  assert.equal(read.structuredContent.values.defaultView, 'overview');
  const update = await client.callTool({ name: 'settings.update', arguments: { set: { defaultView: 'review' } } });
  assert.equal(update.isError, true);
  assert.match(update.content[0].text, /Register a workspace/);
  assert.deepEqual((await client.callTool({ name: 'search_mentions', arguments: { query: '' } })).structuredContent.items, []);
});


test('MCP recovers a first-run configuration and keeps explicit demo separate', { skip: !ready }, async (t) => {
  const ws = await workspace(t);
  const file = path.join(ws.base, 'panel.json');
  const client = await connect(t, path.join(DEV_ROOT, 'src/cli.mjs'), file);
  let result = await client.callTool({name:'crack_panel',arguments:{}});
  assert.equal(result.structuredContent.snapshot.provenance,'unconfigured');
  result = await client.callTool({name:'crack_panel',arguments:{demo:true}});
  assert.equal(result.structuredContent.snapshot.provenance,'demo');
  assert.equal(result.structuredContent.snapshot.launchEnabled,false);
  await writeConfig(ws);
  result = await client.callTool({name:'crack_panel',arguments:{}});
  assert.notEqual(result.structuredContent.snapshot.provenance,'unconfigured');
  assert.notEqual(result.structuredContent.snapshot.provenance,'demo');
  assert.equal(result.structuredContent.snapshot.workspaces.length,1);
});

test('live MCP session registration becomes visible without replacing its controller', {skip:!ready},async t=>{
 const ws=await workspace(t);const configPath=await writeConfig(ws);
 const client=await connect(t,path.join(DEV_ROOT,'src/cli.mjs'),configPath);
 const before=(await client.callTool({name:'crack_panel',arguments:{}})).structuredContent.snapshot;
 const file=fs.realpathSync(ws.base)+'/host.jsonl';
 fs.writeFileSync(file,JSON.stringify({type:'session_meta',timestamp:'2026-10-02T00:00:00Z',payload:{id:'private-host'}})+'\n');
 const doc=JSON.parse(fs.readFileSync(configPath));doc.sessions=[{id:'host',file,workspace:doc.workspaces[0].id,label:'Research host'}];fs.writeFileSync(configPath,JSON.stringify(doc));
 const after=(await client.callTool({name:'crack_panel',arguments:{}})).structuredContent.snapshot;
 assert.equal(after.session,before.session);assert.ok(after.runs.some(r=>r.id==='host'));assert.deepEqual(after.profiles,before.profiles);
});
