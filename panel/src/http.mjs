// Localhost fallback for hosts without MCP App surfaces.
//
// Binds 127.0.0.1 only. Every API call needs the per-launch bearer token and a
// loopback Host; a browser Origin, when sent, must be this exact origin. A
// mutation additionally needs an explicit POST, `Content-Type: application/json`,
// a matching Origin, and a small JSON object with only the expected keys.
// Responses never contain filesystem paths.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PanelError } from './paths.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 16 * 1024;
const UI = path.join(here, 'ui');
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/assets/panel.mjs', ['panel.mjs', 'text/javascript; charset=utf-8']],
  ['/assets/http-entry.mjs', ['http-entry.mjs', 'text/javascript; charset=utf-8']],
  ['/assets/panel.css', ['panel.css', 'text/css; charset=utf-8']],
  ['/assets/icon.svg', ['icon.svg', 'image/svg+xml']],
]);
const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' blob:", "connect-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

function tokenMatches(header, token) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Pure request gate, exported for tests. Returns 0 when allowed, otherwise
// the HTTP status to answer with.
export function gate(req, { token, port, api }) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const host = req.headers.host;
  if (!allowedHosts.has(host)) return 403;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) return 403;
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && !['same-origin', 'none'].includes(site)) return 403;
  if (req.method !== 'GET' && req.method !== 'POST') return 405;
  if (!api) return req.method === 'GET' ? 0 : 405;
  if (!tokenMatches(req.headers.authorization, token)) return 401;
  if (req.method === 'POST') {
    // Cross-site form posts cannot set this content type without a preflight,
    // and a mutation must say where it came from.
    if (origin === undefined) return 403;
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return 415;
  }
  return 0;
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new PanelError('body_too_large', 'Request body is too large.', 413);
    chunks.push(chunk);
  }
  let doc;
  try {
    doc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new PanelError('invalid_json', 'Request body must be JSON.', 400);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new PanelError('invalid_body', 'Request body must be a JSON object.', 400);
  return doc;
}

function pick(doc, allowed) {
  for (const key of Object.keys(doc)) {
    if (!allowed.includes(key)) throw new PanelError('unknown_field', `Unexpected field ${JSON.stringify(key).slice(0, 40)}.`, 400);
  }
  return doc;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function sendError(res, error) {
  const status = error instanceof PanelError ? error.status : 500;
  const body = error instanceof PanelError
    ? { ok: false, error: error.code, message: error.message }
    : { ok: false, error: 'internal_error', message: 'The panel could not complete the request.' };
  send(res, status, body);
}

export function createHandler({ controller, token, port }) {
  const routes = {
    'GET /api/state': async () => controller.snapshot(),
    'GET /api/launch-preview': async (url) => controller.launchPreview(url.searchParams.get('profile')),
    'GET /api/resume-preview': async (url) => controller.resumePreview(url.searchParams.get('run')),
    'POST /api/review/decide': async (_url, body) => {
      const { reviewId, decision, feedback, expectedHash } = pick(body, ['reviewId', 'decision', 'feedback', 'expectedHash']);
      return controller.decide({ reviewId, decision, feedback, expectedHash, channel: controller.provenance === 'demo' ? 'demo-ui' : 'local-ui' });
    },
    'POST /api/launch': async (_url, body) => controller.launch(pick(body, ['profileId', 'confirm', 'requestSha256', 'promptSha256'])),
    'POST /api/cancel': async (_url, body) => controller.cancel(pick(body, ['runId'])),
    'POST /api/resume': async (_url, body) => controller.resume(pick(body, ['runId', 'confirm', 'promptSha256'])),
    'POST /api/demo/revise': async (_url, body) => controller.demoRevise(pick(body, ['reviewId']).reviewId),
  };

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', CSP);
    let url;
    try {
      url = new URL(req.url, `http://127.0.0.1:${port}`);
    } catch {
      send(res, 400, { ok: false, error: 'bad_url' });
      return;
    }
    const api = url.pathname.startsWith('/api/');
    const denial = gate(req, { token, port, api });
    if (denial) {
      const messages = { 401: 'Open the full panel URL printed in the terminal.', 403: 'Forbidden.', 405: 'Method not allowed.', 415: 'Use application/json.' };
      send(res, denial, { ok: false, error: `http_${denial}`, message: messages[denial] });
      return;
    }
    try {
      if (!api) {
        const asset = ASSETS.get(url.pathname);
        if (!asset) {
          send(res, 404, { ok: false, error: 'not_found' });
          return;
        }
        send(res, 200, await fsp.readFile(path.join(UI, asset[0])), asset[1]);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/artifact') {
        const expect = url.searchParams.get('sha256');
        if (expect !== null && !/^[0-9a-f]{64}$/.test(expect)) throw new PanelError('invalid_hash', 'sha256 must be a hex digest.', 400);
        const image = await controller.artifact(url.searchParams.get('review'), url.searchParams.get('side'), expect);
        res.setHeader('Content-Disposition', 'inline');
        res.setHeader('X-Evidence-Sha256', image.sha256);
        send(res, 200, image.data, image.type);
        return;
      }
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) {
        send(res, 404, { ok: false, error: 'not_found' });
        return;
      }
      const body = req.method === 'POST' ? await readBody(req) : null;
      send(res, 200, { ok: true, ...(await route(url, body)) });
    } catch (error) {
      sendError(res, error);
    }
  };
}

export function startServer({ controller, port = 0, token = crypto.randomBytes(24).toString('hex') }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    let handler = null;
    server.on('request', (req, res) => {
      if (handler === null) {
        res.statusCode = 503;
        res.end('Starting');
        return;
      }
      handler(req, res);
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const bound = server.address().port;
      handler = createHandler({ controller, token, port: bound });
      resolve({ server, port: bound, token, url: `http://127.0.0.1:${bound}/#token=${token}` });
    });
  });
}
