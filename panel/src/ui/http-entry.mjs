// Localhost fallback entry: the token arrives in the URL fragment (never sent
// to the server as part of the URL), is kept in session storage for reloads,
// and is removed from the address bar.
import { mountPanel } from './panel.mjs';

const fragment = new URLSearchParams(location.hash.slice(1));
const token = fragment.get('token') ?? sessionStorage.getItem('crack-panel-token');
if (fragment.has('token')) {
  sessionStorage.setItem('crack-panel-token', token);
  history.replaceState(null, '', location.pathname);
}

class RequestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function call(method, url, body) {
  if (!token) throw new RequestError('no_token', 'Open the full panel URL printed in the terminal (it includes the access token).');
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    credentials: 'omit',
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok === false) {
    throw new RequestError(payload?.error ?? `http_${response.status}`, payload?.message ?? `Request failed (${response.status}).`);
  }
  return payload;
}

const imageUrls = new Map();
const transport = {
  kind: 'http',
  pollMs: 2500,
  state: () => call('GET', '/api/state'),
  async artifact(reviewId, side, hash) {
    const key = `${reviewId}|${side}|${hash}`;
    if (imageUrls.has(key)) return imageUrls.get(key);
    const pinned = /^[0-9a-f]{64}$/.test(hash ?? '') ? `&sha256=${hash}` : '';
    const response = await fetch(`/api/artifact?review=${encodeURIComponent(reviewId)}&side=${encodeURIComponent(side)}${pinned}`, {
      headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', credentials: 'omit',
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new RequestError(payload?.error ?? 'artifact_failed', payload?.message ?? 'The image could not be loaded.');
    }
    const url = URL.createObjectURL(await response.blob());
    imageUrls.set(key, url);
    return url;
  },
  decide: (body) => call('POST', '/api/review/decide', body),
  launchPreview: (profileId) => call('GET', `/api/launch-preview?profile=${encodeURIComponent(profileId)}`),
  launch: (body) => call('POST', '/api/launch', body),
  cancel: (body) => call('POST', '/api/cancel', body),
  resumePreview: (runId) => call('GET', `/api/resume-preview?run=${encodeURIComponent(runId)}`),
  resume: (body) => call('POST', '/api/resume', body),
  demoRevise: (body) => call('POST', '/api/demo/revise', body),
};

mountPanel(document.getElementById('app'), transport).start();
