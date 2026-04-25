import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJson } from './helpers.js';
import { judgeRoute } from '../js/judge.js';

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
function run(opts, data) {
  return judgeRoute({ roundTrip: true, ...opts }, data);
}

// ── 距離パターン golden cases ───────────────────────────────────────

test('D1 遠距離 tomei: 御殿場→霞ヶ関 → all_company / 控除片道 83.7km', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'tomei',
    entryIc: findIc(data, 'gotemba'),
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_company');
  assert.equal(r.totals.deductionKmOneway, 83.7);
  assert.equal(r.totals.deductionKmRoundtrip, 167.4);
});

test('D2 遠距離 chuo: 河口湖→霞ヶ関 → all_company / 控除片道 93.9km', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'chuo',
    entryIc: findIc(data, 'kawaguchiko'),
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_company');
  assert.equal(r.totals.deductionKmOneway, 93.9);
});

test('D3 近距離 8入口: 中台→霞ヶ関 → all_company / 控除0', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'none',
    entryIc: findIc(data, 'nakadai'),
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_company');
  assert.equal(r.totals.deductionKmOneway, 0);
  assert.equal(r.totals.deductionKmRoundtrip, 0);
});

test('D4 新規 千葉 keiyo: 成田空港→霞ヶ関 (keiyo) → 控除片道 51.3km', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'keiyo',
    entryIc: findIc(data, 'narita_kukou'),
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_company');
  assert.equal(r.totals.deductionKmOneway, 51.3);
});

test('D5 新規 千葉 tokan: 成田空港→霞ヶ関 (tokan) → 控除片道 48.8km', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'tokan',
    entryIc: findIc(data, 'narita_kukou'),
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_company');
  assert.equal(r.totals.deductionKmOneway, 48.8);
});

test('D6 新規 アクア→館山: 君津 (aqua) → 霞ヶ関 → 控除片道 31.6km', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'aqua',
    entryIc: findIc(data, 'kimitsu'),
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_company');
  assert.equal(r.totals.deductionKmOneway, 31.6);
});

test('D6b 比較 直接 tateyama: 君津 (tateyama) → 霞ヶ関 → 控除片道 7.9km', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'tateyama',
    entryIc: findIc(data, 'kimitsu'),
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_company');
  assert.equal(r.totals.deductionKmOneway, 7.9);
});

test('D7 新規 東名→玉川IC: 横浜青葉→玉川IC → 北西線→港北→第三京浜', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'tomei',
    entryIc: findIc(data, 'yokohama_aoba'),
    exitIc: findIc(data, 'tamagawa_ic'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_company');
  assert.equal(r.totals.deductionKmOneway, 13.3, 'tomei.yokohama_aoba 控除km');

  const shutokoSeg = r.segments.find((s) => s.route === 'shutoko');
  assert.equal(shutokoSeg.distanceKm, 30.0, '北西線→港北JCT→第三京浜 explicit pair km');
  assert.deepEqual(shutokoSeg.path, ['yokohama_aoba', 'yokohama_kohoku_jct', 'tamagawa_ic']);
  assert.ok(shutokoSeg.name.includes('北西線'), 'segment.name に経路ラベル');
});

test('D8 新規 湾岸環八 alt: 横浜青葉→湾岸環八 → C2_wangan default 17.2km', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'tomei',
    entryIc: findIc(data, 'yokohama_aoba'),
    exitIc: findIc(data, 'wangan_kanpachi'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_company');
  assert.equal(r.totals.deductionKmOneway, 13.3);

  const shutokoSeg = r.segments.find((s) => s.route === 'shutoko');
  assert.equal(shutokoSeg.distanceKm, 17.2, 'tokyo_ic→wangan_kanpachi default C2 km');
});

test('D9 神奈川 wangan_route: 朝比奈→霞ヶ関 → all_company (外側本線経由)', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'wangan_route',
    entryIc: findIc(data, 'asahina'),
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_company');
  assert.equal(r.totals.deductionKmOneway, 7.3);
  // wangan_route は OUTER_TRUNK_ROUTES に含まれるので shutoko 部分も company
  const shutokoSeg = r.segments.find((s) => s.route === 'shutoko');
  assert.equal(shutokoSeg.pay, 'company');
});

test('D10 神奈川 yokohane_route: 朝比奈→霞ヶ関 → 控除 12.7km', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'yokohane_route',
    entryIc: findIc(data, 'asahina'),
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  assert.equal(r.totals.deductionKmOneway, 12.7);
});

test('D11 自己負担 都心側: 鈴ヶ森 (新規追加 IC) → 霞ヶ関 → all_self', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'none',
    entryIc: findIc(data, 'suzugamori'),
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_self');
  assert.equal(r.totals.deductionKmOneway, 0);
});

test('D12 遠 関越+外環: 桶川北本→霞ヶ関 (外環経由) → all_company / 控除片道 48.9km', () => {
  const data = loadAll();
  const entry = findIc(data, 'okegawa_kitamoto');
  entry._viaGaikan = true;
  const r = run({
    outerRoute: 'kanetsu',
    entryIc: entry,
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_company');
  assert.equal(r.totals.deductionKmOneway, 48.9);
});

test('D13 湾岸環八 特例 (会社負担): 木更津金田 (aqua) → 湾岸環八 → all_company', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'aqua',
    entryIc: findIc(data, 'kisarazu_kaneda'),
    exitIc: findIc(data, 'wangan_kanpachi'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_company');
  assert.equal(r.totals.deductionKmOneway, 15.1);
});

test('D14 浮島JCT→湾岸環八 直行 (default 6km)', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'aqua',
    entryIc: findIc(data, 'kisarazu_kaneda'),
    exitIc: findIc(data, 'wangan_kanpachi'),
  }, data);
  const shutokoSeg = r.segments.find((s) => s.route === 'shutoko');
  assert.equal(shutokoSeg.distanceKm, 6.0, 'ukishima_jct→wangan_kanpachi 湾岸直行');
});

test('D15 アクア→館山遠 (富浦 67.5km) → all_company', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'aqua',
    entryIc: findIc(data, 'tomiura'),
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_company');
  assert.equal(r.totals.deductionKmOneway, 67.5);
});

test('D16 葛西 (都心側、自己負担) → 湾岸環八 → all_self', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'none',
    entryIc: findIc(data, 'kasai'),
    exitIc: findIc(data, 'wangan_kanpachi'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_self');
  assert.equal(r.totals.deductionKmOneway, 0);
});
