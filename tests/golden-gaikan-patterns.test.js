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

// ── G1-G3: 外環直乗り → 全区間 self ──────────────────────────────

test('G1 外環直乗り: 大泉IC→霞ヶ関 → all_self / 控除0 / 外環+首都高 self', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'gaikan_direct',
    entryIc: findIc(data, 'oizumi'),
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_self');
  assert.equal(r.totals.deductionKmOneway, 0);
  const gaikanSeg = r.segments.find((s) => s.route === 'gaikan');
  assert.ok(gaikanSeg, '外環道 segment が存在すべき');
  assert.equal(gaikanSeg.pay, 'self');
  const shutokoSeg = r.segments.find((s) => s.route === 'shutoko');
  assert.equal(shutokoSeg.pay, 'self');
});

test('G2 外環直乗り: 大泉JCT→霞ヶ関 → all_self', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'gaikan_direct',
    entryIc: findIc(data, 'oizumi_jct'),
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_self');
  assert.equal(r.totals.deductionKmOneway, 0);
});

test('G3 外環直乗り: 美女木JCT→霞ヶ関 → all_self', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'gaikan_direct',
    entryIc: findIc(data, 'bijogi_jct'),
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_self');
  assert.equal(r.totals.deductionKmOneway, 0);
});

// ── G4-G6: 関越 (optional) 外環経由 vs 直接 ─────────────────────

test('G4 関越外環経由: 所沢→霞ヶ関 viaGaikan → all_company / 外環道 segment あり', () => {
  const data = loadAll();
  const entry = { ...findIc(data, 'tokorozawa'), _viaGaikan: true };
  const r = run({
    outerRoute: 'kanetsu',
    entryIc: entry,
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_company');
  assert.equal(r.totals.deductionKmOneway, 9.4);
  const gaikanSeg = r.segments.find((s) => s.route === 'gaikan');
  assert.ok(gaikanSeg, '外環道 segment が存在すべき');
  assert.equal(gaikanSeg.pay, 'company');
});

test('G5 関越 外環なし: 所沢→霞ヶ関 NO gaikan → all_company / 外環 segment 無し', () => {
  const data = loadAll();
  const entry = { ...findIc(data, 'tokorozawa'), _viaGaikan: false };
  const r = run({
    outerRoute: 'kanetsu',
    entryIc: entry,
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_company');
  assert.equal(r.totals.deductionKmOneway, 9.4);
  const gaikanSeg = r.segments.find((s) => s.route === 'gaikan');
  assert.equal(gaikanSeg, undefined, '外環道 segment は無いはず');
});

test('G6 関越 遠 外環経由: 桶川北本→霞ヶ関 viaGaikan → all_company / 控除 48.9km', () => {
  const data = loadAll();
  const entry = { ...findIc(data, 'okegawa_kitamoto'), _viaGaikan: true };
  const r = run({
    outerRoute: 'kanetsu',
    entryIc: entry,
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_company');
  assert.equal(r.totals.deductionKmOneway, 48.9);
  assert.ok(r.segments.find((s) => s.route === 'gaikan'));
});

// ── G7-G8: 常磐 (optional) 外環経由 vs 直接 ───────────────────

test('G7 常磐外環経由: 柏→霞ヶ関 viaGaikan → all_company / 外環道 segment あり', () => {
  const data = loadAll();
  const entry = { ...findIc(data, 'kashiwa'), _viaGaikan: true };
  const r = run({
    outerRoute: 'joban',
    entryIc: entry,
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_company');
  assert.equal(r.totals.deductionKmOneway, 10.8);
  const gaikanSeg = r.segments.find((s) => s.route === 'gaikan');
  assert.ok(gaikanSeg);
  assert.equal(gaikanSeg.pay, 'company');
});

test('G8 常磐 外環なし: 柏→霞ヶ関 NO gaikan → all_company / 外環 segment 無し', () => {
  const data = loadAll();
  const entry = { ...findIc(data, 'kashiwa'), _viaGaikan: false };
  const r = run({
    outerRoute: 'joban',
    entryIc: entry,
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_company');
  assert.equal(r.totals.deductionKmOneway, 10.8);
  assert.equal(r.segments.find((s) => s.route === 'gaikan'), undefined);
});

// ── G9-G10: 東北 (常に外環経由、needs_gaikan_transit=true) ──

test('G9 東北 (常に外環経由): 浦和→霞ヶ関 → all_company / 外環道 segment 自動付与', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'tohoku',
    entryIc: findIc(data, 'urawa'),
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_company');
  assert.equal(r.totals.deductionKmOneway, 3.2);
  const gaikanSeg = r.segments.find((s) => s.route === 'gaikan');
  assert.ok(gaikanSeg, '東北方面は viaGaikan フラグ無くても自動で外環セグメントが入る');
  assert.equal(gaikanSeg.pay, 'company');
});

test('G10 東北 遠 (加須 33km): all_company / 外環道 segment あり', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'tohoku',
    entryIc: findIc(data, 'kazo'),
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_company');
  assert.equal(r.totals.deductionKmOneway, 33.4);
  assert.ok(r.segments.find((s) => s.route === 'gaikan'));
});

// ── G11: 外環直乗り + 別の出口 ──────────────────────────────

test('G11 外環直乗り→湾岸環八: 大泉→湾岸環八 → all_self', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'gaikan_direct',
    entryIc: findIc(data, 'oizumi'),
    exitIc: findIc(data, 'wangan_kanpachi'),
  }, data);
  assert.equal(r.totals.paySummary, 'all_self');
  assert.equal(r.totals.deductionKmOneway, 0);
});

// ── G12: 区間内訳の構造検証 ─────────────────────────────────

test('G12 区間内訳: 関越 viaGaikan は (関越道, 外環道, 首都高) の 3 segments', () => {
  const data = loadAll();
  const entry = { ...findIc(data, 'tokorozawa'), _viaGaikan: true };
  const r = run({
    outerRoute: 'kanetsu',
    entryIc: entry,
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  const routes = r.segments.map((s) => s.route);
  assert.deepEqual(routes, ['kanetsu', 'gaikan', 'shutoko']);
});

test('G13 区間内訳: 関越 NO gaikan は (関越道, 首都高) の 2 segments', () => {
  const data = loadAll();
  const entry = { ...findIc(data, 'tokorozawa'), _viaGaikan: false };
  const r = run({
    outerRoute: 'kanetsu',
    entryIc: entry,
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  const routes = r.segments.map((s) => s.route);
  assert.deepEqual(routes, ['kanetsu', 'shutoko']);
});

test('G14 区間内訳: 外環直乗り は (外環道, 首都高) の 2 segments、kanetsu/joban/tohoku 無し', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'gaikan_direct',
    entryIc: findIc(data, 'oizumi'),
    exitIc: findIc(data, 'kasumigaseki'),
  }, data);
  const routes = r.segments.map((s) => s.route);
  assert.deepEqual(routes, ['gaikan', 'shutoko']);
});
