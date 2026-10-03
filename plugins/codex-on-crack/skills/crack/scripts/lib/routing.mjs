// Codex's bounded role overrides inherit the parent provider. A catalog is not a route.
import { CrackError } from './io.mjs';
import { routerProvider } from './catalog.mjs';

function fail(message) {
  throw new CrackError('provider_incompatible', message,
    'Use an already compatible parent profile. This package never rewrites providers, endpoints, or authentication.');
}
function loopback(value) {
  try {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)
      && !u.username && !u.password && !u.search && !u.hash
      && /^\/(?:v1|_codex-router\/[A-Za-z0-9_-]+\/v1)\/?$/.test(u.pathname);
  } catch { return false; }
}
export function checkRouting({ config, roles, models, codexHome, env = process.env }) {
  if (['OPENAI_BASE_URL', 'CODEX_OPENAI_BASE_URL', 'CODEX_CHATGPT_BASE_URL'].some((k) => env[k])) {
    fail('An endpoint environment override prevents static provider verification.');
  }
  const parent = config.model_provider ?? 'openai';
  const endpoint = parent === 'openai' ? config.openai_base_url : config.model_providers?.[parent]?.base_url;
  const entries = new Map(models.map((m) => [m.model, m]));
  for (const role of roles) for (const rung of role.rungs) {
    if (config.agents?.[rung.agent] !== undefined) {
      throw new CrackError('role_conflict', `An inline ${rung.agent} definition competes with the generated role.`,
        'Reconcile the role definitions without changing unrelated agents.');
    }
    if (!rung.model.includes('/')) {
      if (parent !== 'openai' || endpoint || config.model_providers?.openai
          || ![undefined, 'https://chatgpt.com/backend-api/'].includes(config.chatgpt_base_url)) {
        fail('A native worker requires the built-in OpenAI parent provider and endpoint.');
      }
      const declared = entries.get(rung.model)?.declaredProvider;
      if (declared && declared !== 'openai') fail('The native model metadata declares another provider.');
    } else {
      if (!loopback(endpoint)) fail('A routed worker requires a recognized loopback Router parent endpoint.');
      const requested = routerProvider(codexHome, rung.model);
      if (requested && requested !== parent) {
        const otherEndpoint = config.model_providers?.[requested]?.base_url;
        if (!otherEndpoint || otherEndpoint !== endpoint) fail('The Router role provider does not match the effective parent route.');
      }
    }
  }
  return ['Provider checks are static; verify active project/UI/managed overrides and client-recorded child routing before sending private work.',
    'Role instructions forbid nested delegation and read-only edits; these are not additional sandbox guarantees.'];
}
