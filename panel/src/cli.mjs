#!/usr/bin/env node
// Build panel CLI.
//
//   serve [--config FILE | --demo] [--port N]   localhost fallback (127.0.0.1)
//   mcp   [--config FILE]                       stdio MCP server with the MCP App UI
//   check [--config FILE]                       validate a configuration, launch nothing
//
// The configuration defaults to $CRACK_PANEL_CONFIG, then
// $CODEX_HOME/crack/panel.json, then ~/.codex/crack/panel.json. It is read, never written.
import fs from 'node:fs';
import {connectSession,askQuestion} from './connect.mjs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadPanelConfig, validatePanelConfig } from './config.mjs';
import { PanelController, SOURCE_LEAD_CLI } from './controller.mjs';
import { createDemo } from './demo.mjs';
import { startServer } from './http.mjs';
import { createRecording, addCheckpoint, exportRecording } from './recording.mjs';

const USAGE = `Usage:
  panel serve [--config FILE | --demo] [--port N]
  panel mcp   [--config FILE]
  panel check [--config FILE]
  panel connect --session FILE --workspace DIR [--label TEXT] [--details] [--config FILE]
  panel record --out NEW_DIR [--config FILE] [--sources FILE] [--details] [--interval MS] [--once]
  panel ask --workspace DIR --id QUESTION_ID --question TEXT [--label TEXT] [--file IMAGE] [--config FILE]
  panel checkpoint --recording DIR --file JSON
  panel export --recording DIR --out NEW_DIR [--details] [--images]
Nothing is launched unless the configuration enables launching and you confirm a launch in the panel.`;

export function defaultConfigPath(env = process.env) {
  if (env.CRACK_PANEL_CONFIG) return path.resolve(env.CRACK_PANEL_CONFIG);
  const home = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), '.codex');
  return path.join(home, 'crack', 'panel.json');
}

// A built bundle ships its own copy of the adapter CLI next to itself.
export function leadCliPath(moduleUrl = import.meta.url) {
  const bundled = path.join(path.dirname(fileURLToPath(moduleUrl)), 'lead.mjs');
  return fs.existsSync(bundled) ? bundled : SOURCE_LEAD_CLI;
}

function parse(argv) {
  return parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      id:{type:'string'},question:{type:'string'},session: {type:'string'},workspace:{type:'string'},label:{type:'string'},out: { type: 'string' }, sources: { type: 'string' }, recording: { type: 'string' }, file: { type: 'string' }, interval: { type: 'string' }, once: { type: 'boolean' }, details: { type: 'boolean' }, images: { type: 'boolean' }, config: { type: 'string' }, demo: { type: 'boolean' }, port: { type: 'string' }, help: { type: 'boolean' },
    },
  }).values;
}

async function serve(values) {
  const port = values.port === undefined ? 4327 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535');
  let controller;
  let demo = null;
  if (values.demo) {
    if (values.config) throw new Error('--demo and --config are exclusive: demo and real runs never share a panel');
    demo = createDemo();
    controller = new PanelController({ config: demo.config, provenance: 'demo', demo, leadCli: leadCliPath() });
  } else {
    controller = new PanelController({ config: loadPanelConfig(values.config ?? defaultConfigPath()), leadCli: leadCliPath() });
    controller.reloadSources=()=>loadPanelConfig(values.config ?? defaultConfigPath());
  }
  const { server, url } = await startServer({ controller, port });
  process.stdout.write(`Build panel (${controller.provenance}): ${url}\nLocal only (127.0.0.1). The token in the link is required; keep it private. Ctrl+C to stop.\n`);
  const stop = () => {
    controller.close();
    server.close(() => {
      demo?.cleanup();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function check(values) {
  const file = values.config ?? defaultConfigPath();
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, config: file, problems: ['The configuration is missing or not valid JSON.'] };
  }
  const result = validatePanelConfig(doc);
  return {
    ok: result.ok,
    config: file,
    problems: result.problems,
    summary: result.ok ? {
      workspaces: result.config.workspaces.length,
      runs: result.config.runs.length,
      sessions: result.config.sessions.length,
      reviews: result.config.reviews.length,
      profiles: result.config.launch.profiles.length,
      launchEnabled: result.config.launch.enabled,
    } : null,
    model_calls_made: false,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  let values;
  try {
    values = parse(rest);
  } catch (error) {
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (values.help || !command) {
    process.stdout.write(`${USAGE}\n`);
    return command ? 0 : 2;
  }
  if (command === 'record') {
    if(!values.out) throw Error('--out is required');
    const recorder=createRecording({out:values.out,configPath:values.config??(values.sources?null:defaultConfigPath()),sourcesPath:values.sources,details:values.details===true,intervalMs:values.interval===undefined?2000:Number(values.interval)});
    let stopping=false;let wake=null;
    const stop=()=>{stopping=true;wake?.();};
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    process.stdout.write(`Recording locally in ${recorder.dir}. No model calls. Stop with Ctrl+C; export afterward.\n`);
    try {
      do {
        const result=await recorder.sample();
        if(result.problems.length)process.stderr.write(`Capture frame ${result.frames}: ${result.problems.join('; ')}\n`);
        if(values.once||stopping)break;
        await new Promise(resolve=>{const timer=setTimeout(resolve,values.interval===undefined?2000:Number(values.interval));wake=()=>{clearTimeout(timer);resolve();};});wake=null;
      }while(!stopping);
      recorder.finish();
    }catch(error){recorder.finish('failed');throw error;}
    finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
    return 0;
  }
  if(command==='ask'){process.stdout.write(JSON.stringify(askQuestion({...values,configPath:values.config??defaultConfigPath()}))+'\n');return 0;}
  if(command==='connect'){process.stdout.write(JSON.stringify(connectSession({configPath:values.config??defaultConfigPath(),file:values.session,workspace:values.workspace,label:values.label,details:values.details===true}))+'\n');return 0;}
  if(command==='checkpoint') {
    if(!values.recording||!values.file)throw Error('--recording and --file are required');
    addCheckpoint(values.recording,values.file);process.stdout.write('Checkpoint recorded locally.\n');return 0;
  }
  if(command==='export') {
    if(!values.recording||!values.out)throw Error('--recording and --out are required');
    process.stdout.write(JSON.stringify(exportRecording({recording:values.recording,out:values.out,details:values.details===true,images:values.images===true}),null,2)+'\n');return 0;
  }
  if (command === 'serve') {
    await serve(values);
    return null;
  }
  if (command === 'mcp') {
    const { runStdioServer } = await import('./mcp/server.mjs');
    await runStdioServer({ configPath: values.config ?? defaultConfigPath(), leadCli: leadCliPath() });
    return null;
  }
  if (command === 'check') {
    const result = check(values);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }
  process.stderr.write(`Unknown command ${JSON.stringify(command)}.\n${USAGE}\n`);
  return 2;
}

function isEntrypoint() {
  try {
    return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().then((code) => {
    if (code !== null) process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`panel: ${error.message}\n`);
    for (const problem of error.problems ?? []) process.stderr.write(`  - ${problem}\n`);
    process.exitCode = 1;
  });
}
