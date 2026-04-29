import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJson } from './helpers.js';
import { judgeRoute } from '../js/judge.js';
import { getOuterRouteOptionsForIc } from '../js/route-options.js';

function loadAll() {
  return {
    ics: loadJson('data/ics.json').ics,
    deduction: loadJson('data/deduction.json'),
    shutokoDist: loadJson('data/shutoko_distances.json'),
    shutokoRoutes: loadJson('data/shutoko_routes.json'),
    shutokoGraph: loadJson('data/shutoko_graph.json'),
    gaikanDist: loadJson('data/gaikan_distances.json'),
    routes: loadJson('data/routes.json'),
  };
}

function findIc(data, id) {
  const ic = data.ics.find((x) => x.id === id);
  if (!ic) throw new Error(`IC not found: ${id}`);
  return ic;
}

test('reverse outer route: 霞ヶ関→横浜青葉 uses same 東名 deduction and curated 首都高 distance', () => {
  const data = loadAll();
  const r = judgeRoute({
    outerRoute: 'tomei',
    entryIc: findIc(data, 'kasumigaseki'),
    exitIc: findIc(data, 'yokohama_aoba'),
    roundTrip: false,
  }, data);

  assert.equal(r.totals.paySummary, 'all_company');
  assert.equal(r.totals.deductionKmOneway, 13.3);
  assert.equal(r.segments.find((s) => s.route === 'shutoko')?.distanceKm, 12.0);
  assert.equal(r.segments.find((s) => s.route === 'tomei')?.distanceKm, 13.3);
});

test('reverse explicit 首都高 pair: 空港中央→霞ヶ関 uses curated 霞ヶ関→空港中央 distance', () => {
  const data = loadAll();
  const r = judgeRoute({
    outerRoute: 'none',
    entryIc: findIc(data, 'kukou_chuou'),
    exitIc: findIc(data, 'kasumigaseki'),
    roundTrip: false,
  }, data);

  assert.equal(r.segments.find((s) => s.route === 'shutoko')?.distanceKm, 21.4);
});

test('Haneda-bound Yokohama entries prefer Yokohama-side expressways over Tokyo IC routes', () => {
  const data = loadAll();
  const options = getOuterRouteOptionsForIc({
    ic: findIc(data, 'yokohama_aoba'),
    exitIc: findIc(data, 'kukou_chuou'),
    deduction: data.deduction,
  });

  assert.equal(options[0], 'kitasen_route');
  assert.ok(options.indexOf('kitasen_route') < options.indexOf('tomei'));
});

test('non-Haneda Yokohama entries keep the direct Tokyo-side route first', () => {
  const data = loadAll();
  const options = getOuterRouteOptionsForIc({
    ic: findIc(data, 'yokohama_aoba'),
    exitIc: findIc(data, 'kasumigaseki'),
    deduction: data.deduction,
  });

  assert.equal(options[0], 'tomei');
});

test('route options support reverse trips from Shutoko-side IC to outer expressway IC', () => {
  const data = loadAll();
  const options = getOuterRouteOptionsForIc({
    ic: findIc(data, 'kasumigaseki'),
    exitIc: findIc(data, 'yokohama_aoba'),
    deduction: data.deduction,
  });

  assert.equal(options[0], 'tomei');
  assert.ok(options.includes('kitasen_route'));
});
