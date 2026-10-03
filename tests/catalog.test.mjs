import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogEntry, makeHome, DUPLICATED, FLASH, OPUS, ROOT_MODEL, V1_ONLY } from './helpers.mjs';
import {
  describeModels, effectiveCatalog, modelEntries, routerProvider,
} from '../plugins/codex-on-crack/skills/crack/scripts/lib/catalog.mjs';

const where = (h) => ({ home: h.home, codexHome: h.codexHome });

test('effectiveCatalog reads model_catalog_json when config sets it', (t) => {
  const h = makeHome(t);
  const catalog = effectiveCatalog({ config: { model_catalog_json: 'catalog.json' }, ...where(h) });
  assert.equal(catalog.source, 'model_catalog_json');
  assert.equal(catalog.entries.length, 6);
});

test("effectiveCatalog falls back to Codex's own models_cache.json without a router", (t) => {
  const h = makeHome(t, { catalog: null });
  h.write('models_cache.json', JSON.stringify({ fetched_at: 'x', models: [catalogEntry('gpt-5.6-mini')] }));
  const catalog = effectiveCatalog({ config: {}, ...where(h) });
  assert.equal(catalog.source, 'models_cache');
  assert.deepEqual(catalog.entries.map((e) => e.slug), ['gpt-5.6-mini']);
});

test('effectiveCatalog explains a missing, unreadable, or unrecognized catalog', (t) => {
  const h = makeHome(t, { catalog: null });
  assert.throws(() => effectiveCatalog({ config: {}, ...where(h) }), { code: 'catalog_missing' });
  assert.throws(() => effectiveCatalog({ config: { model_catalog_json: 'nope.json' }, ...where(h) }), { code: 'catalog_missing' });
  h.write('bad.json', '{not json');
  assert.throws(() => effectiveCatalog({ config: { model_catalog_json: 'bad.json' }, ...where(h) }), { code: 'catalog_unreadable' });
  h.write('odd.json', '{"weird": true}');
  assert.throws(() => effectiveCatalog({ config: { model_catalog_json: 'odd.json' }, ...where(h) }), { code: 'catalog_unrecognized' });
});

test('modelEntries accepts a bare list or a models/data wrapper', () => {
  assert.equal(modelEntries([{ slug: 'a' }, 'junk']).length, 1);
  assert.equal(modelEntries({ data: [{ id: 'b' }] }).length, 1);
});

test('describeModels reports eligibility with a reason, plus capabilities', (t) => {
  const h = makeHome(t);
  const models = describeModels(effectiveCatalog({ config: { model_catalog_json: 'catalog.json' }, ...where(h) }).entries);
  const by = Object.fromEntries(models.map((m) => [m.model, m]));
  assert.deepEqual(models.map((m) => m.model), [ROOT_MODEL, FLASH, OPUS, V1_ONLY, DUPLICATED]);
  assert.equal(by[FLASH].eligible, true);
  assert.equal(by[FLASH].reason, null);
  assert.equal(by[FLASH].vision, true);
  assert.deepEqual(by[FLASH].efforts, ['low', 'high']);
  assert.equal(by[FLASH].defaultEffort, 'high');
  assert.equal(by[FLASH].contextWindow, 1048576);
  assert.equal(by[OPUS].vision, false);
  assert.equal(by[V1_ONLY].eligible, false);
  assert.equal(by[V1_ONLY].reason, 'not_subagent_capable');
  assert.match(by[V1_ONLY].why, /multi_agent_version/);
  assert.equal(by[DUPLICATED].reason, 'duplicate');
});

test('describeModels drops a default effort the model does not list', () => {
  const [model] = describeModels([catalogEntry('m', { default_reasoning_level: 'ultra' })]);
  assert.equal(model.defaultEffort, null);
});

test('routerProvider mirrors codex-router agent files, skips broken ones, and refuses disagreement', (t) => {
  const h = makeHome(t);
  assert.equal(routerProvider(h.codexHome, OPUS), 'codex-router');
  assert.equal(routerProvider(h.codexHome, FLASH), null);
  h.write('agents/router-model-broken.toml', 'model = "unterminated\n');
  assert.equal(routerProvider(h.codexHome, OPUS), 'codex-router');
  h.write('agents/router-model-other.toml', `model_provider = "other"\nmodel = "${OPUS}"\n`);
  assert.throws(() => routerProvider(h.codexHome, OPUS), { code: 'ambiguous_provider' });
});
