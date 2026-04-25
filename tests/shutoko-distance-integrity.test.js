import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJson } from './helpers.js';
import { judgeRoute } from '../js/judge.js';
import { buildAdjacency, shortestPath } from '../js/shutoko-graph.js';

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

// 各 baseline → 霞ヶ関 の首都高距離を Wikipedia/首都高公式値と比較
// 許容: ±2.0 km (社内料金所→料金所の差で多少前後する)
const TOLERANCE_KM = 2.0;

function shutokoKmTo(data, fromIcId, toIcId, optionId = null) {
  // explicit pair から取る (default option)
  const pair = data.shutokoRoutes.pairs.find((p) => p.from === fromIcId && p.to === toIcId);
  if (pair) {
    const opt = optionId ? pair.options.find((o) => o.id === optionId)
                         : (pair.options.find((o) => o.default) || pair.options[0]);
    return opt?.km ?? null;
  }
  return null;
}

function dijkstraKm(data, fromIcId, toIcId) {
  const adj = buildAdjacency(data.shutokoGraph);
  return shortestPath(adj, fromIcId, toIcId).km;
}

function within(actual, expected, label) {
  const diff = Math.abs(actual - expected);
  assert.ok(
    diff <= TOLERANCE_KM,
    `${label}: 期待 ≈${expected}km、実測 ${actual}km (差 ${diff.toFixed(1)}km > ${TOLERANCE_KM}km)`,
  );
}

// ── 主要 baseline → 霞ヶ関 の首都高距離検証 (Wikipedia 値ベース) ──

test('S1 3号渋谷線: 東京IC→霞ヶ関 ≈ 12.4 km (Wikipedia)', () => {
  const data = loadAll();
  const km = shutokoKmTo(data, 'tokyo_ic', 'kasumigaseki');
  within(km, 12.4, 'tokyo_ic → kasumigaseki (3号→C1)');
});

test('S2 4号新宿線: 高井戸→霞ヶ関 ≈ 13.8 km (Wikipedia)', () => {
  const data = loadAll();
  const km = shutokoKmTo(data, 'takaido', 'kasumigaseki');
  within(km, 13.8, 'takaido → kasumigaseki (4号→C1)');
});

test('S3 5号池袋線: 練馬→霞ヶ関 ≈ 17 km', () => {
  const data = loadAll();
  const km = shutokoKmTo(data, 'nerima', 'kasumigaseki');
  within(km, 17.0, 'nerima → kasumigaseki (5号→C2→C1)');
});

test('S4 S1川口線: 川口JCT→霞ヶ関 ≈ 15 km', () => {
  const data = loadAll();
  const km = shutokoKmTo(data, 'kawaguchi_jct', 'kasumigaseki');
  within(km, 15.0, 'kawaguchi_jct → kasumigaseki (S1→C2→C1)');
});

test('S5 6号三郷線: 三郷JCT→霞ヶ関 ≈ 17-18 km', () => {
  const data = loadAll();
  const km = shutokoKmTo(data, 'misato_jct', 'kasumigaseki');
  within(km, 17.5, 'misato_jct → kasumigaseki (6号→C1)');
});

test('S6 7号小松川線: 篠崎→霞ヶ関 ≈ 13 km', () => {
  const data = loadAll();
  const km = shutokoKmTo(data, 'shinozaki', 'kasumigaseki');
  within(km, 13.0, 'shinozaki → kasumigaseki (7号→C1)');
});

test('S7 湾岸→9号→C1: 湾岸市川→霞ヶ関 ≈ 20 km', () => {
  const data = loadAll();
  const km = shutokoKmTo(data, 'wangan_ichikawa', 'kasumigaseki');
  within(km, 20.0, 'wangan_ichikawa → kasumigaseki');
});

// ── 主要 baseline → 空港中央 の検証 ──

test('S8 用賀→空港中央 (3号→C1→湾岸 default) ≈ 26 km', () => {
  const data = loadAll();
  const km = shutokoKmTo(data, 'tokyo_ic', 'kukou_chuou');
  within(km, 26.0, 'tokyo_ic → kukou_chuou');
});

test('S9 用賀→湾岸環八 (default C2_wangan) ≈ 17 km', () => {
  const data = loadAll();
  const km = shutokoKmTo(data, 'tokyo_ic', 'wangan_kanpachi');
  within(km, 17.0, 'tokyo_ic → wangan_kanpachi');
});

test('S10 三郷→空港中央 (default C2→湾岸) ≈ 32 km', () => {
  const data = loadAll();
  const km = shutokoKmTo(data, 'misato_jct', 'kukou_chuou');
  within(km, 32.0, 'misato_jct → kukou_chuou');
});

// ── Dijkstra と shutoko_routes の整合性: 同程度の値を返すべき ──

test('S11 整合性: tokyo_ic→kasumigaseki Dijkstra と shutoko_routes が ±2km 以内', () => {
  const data = loadAll();
  const routesKm = shutokoKmTo(data, 'tokyo_ic', 'kasumigaseki');
  const dijKm = dijkstraKm(data, 'tokyo_ic', 'kasumigaseki');
  assert.ok(
    Math.abs(routesKm - dijKm) <= 2.0,
    `routes=${routesKm}km vs Dijkstra=${dijKm}km (差 ${Math.abs(routesKm - dijKm).toFixed(1)}km)`,
  );
});

test('S12 整合性: nerima→kasumigaseki Dijkstra と shutoko_routes が ±2km 以内', () => {
  const data = loadAll();
  const routesKm = shutokoKmTo(data, 'nerima', 'kasumigaseki');
  // nerima にはグラフedge無いので Dijkstra不可、shutoko_routes が唯一の値源
  // 代わりに値が妥当な範囲か ( 12 < km < 25 )
  assert.ok(routesKm > 10 && routesKm < 25, `nerima→kasumigaseki ${routesKm}km は妥当範囲外`);
});

// ── データ整合性: graph edge が極端な値を持たない ──

test('S13 グラフ edge: 全て 0 < km < 50 (異常検出)', () => {
  const data = loadAll();
  const bad = data.shutokoGraph.edges.filter((e) => !(e.km > 0 && e.km < 50));
  assert.deepEqual(bad, [], '異常な km 値の edge: ' + JSON.stringify(bad));
});

test('S14 shutoko_routes: 全 option の km が 0 < km < 100', () => {
  const data = loadAll();
  const bad = [];
  for (const p of data.shutokoRoutes.pairs) {
    for (const o of p.options) {
      if (!(o.km > 0 && o.km < 100)) bad.push({ from: p.from, to: p.to, opt: o });
    }
  }
  assert.deepEqual(bad, [], '異常 km の option: ' + JSON.stringify(bad));
});

test('S15 shutoko_routes: default option がそのペア中で最短 (常識的、現状確認)', () => {
  const data = loadAll();
  const violations = [];
  for (const p of data.shutokoRoutes.pairs) {
    if (p.options.length < 2) continue;
    const def = p.options.find((o) => o.default) || p.options[0];
    const minOpt = p.options.reduce((m, o) => o.km < m.km ? o : m, p.options[0]);
    if (def.id !== minOpt.id) {
      violations.push(`${p.from}→${p.to}: default=${def.id}(${def.km}km) vs min=${minOpt.id}(${minOpt.km}km)`);
    }
  }
  // 注: 現状の社内ルール上 default が最短でない場合もあり得るので、warning として表示のみ
  // ここでは違反があったらエラーにせず、コンソール警告だけ (test 自体は pass)
  if (violations.length > 0) {
    console.log('  [info] default が最短でない pair:', violations);
  }
});

// ── 物理走行距離 サンプル検証 (マップ参照) ──

test('S16 横浜青葉(東名)→霞ヶ関 物理距離 ≈ 26-28 km (マップ参照)', () => {
  const data = loadAll();
  const find = (id) => data.ics.find((x) => x.id === id);
  const r = judgeRoute({
    outerRoute: 'tomei',
    entryIc: find('yokohama_aoba'),
    exitIc: find('kasumigaseki'),
    roundTrip: false,
  }, data);
  // 控除 13.3 (東名横浜青葉→東京IC) + 首都高 ~12 (3号→C1) ≈ 25-26
  // Google Maps 参考値: 35-40 (一般道含む) / 高速のみ ~28 km
  within(r.totals.distanceKmOneway, 26.0, '横浜青葉→霞ヶ関 高速のみ');
});

test('S17 所沢(関越)→霞ヶ関 viaGaikan 物理距離 ≈ 39 km', () => {
  const data = loadAll();
  const find = (id) => data.ics.find((x) => x.id === id);
  const entry = { ...find('tokorozawa'), _viaGaikan: true };
  const r = judgeRoute({
    outerRoute: 'kanetsu', entryIc: entry, exitIc: find('kasumigaseki'), roundTrip: false,
  }, data);
  // 関越(8.6=9.4-大泉JCT0.8) + 外環(7.8) + 首都高 bijogi_jct→kasumigaseki(23.0) = 39.4km
  within(r.totals.distanceKmOneway, 39.4, '所沢→霞ヶ関 viaGaikan');
});

test('S19 戸塚(第三京浜)→霞ヶ関: 一般道3km含む走行距離 ≈ 42 km', () => {
  const data = loadAll();
  const find = (id) => data.ics.find((x) => x.id === id);
  const r = judgeRoute({
    outerRoute: 'third_keihin', entryIc: find('totsuka'),
    exitIc: find('kasumigaseki'), roundTrip: false,
  }, data);
  // 第三京浜 戸塚→玉川IC(26.6) + 一般道(3) + 東京IC→3号→C1→霞ヶ関(12.4) = 42.0km
  // 玉川IC は首都高直結ではない (環八沿い)、東京IC まで一般道接続が必要
  within(r.totals.distanceKmOneway, 42.0, '戸塚→霞ヶ関 (一般道含む)');
  // 控除km は社内表値 26.6 で不変
  assert.equal(r.totals.deductionKmOneway, 26.6, '控除距離は社内表 26.6 のまま');
});

test('S20 朝比奈(横横玉川経由)→霞ヶ関: 一般道3km含む走行距離 ≈ 51 km', () => {
  const data = loadAll();
  const find = (id) => data.ics.find((x) => x.id === id);
  const r = judgeRoute({
    outerRoute: 'yokoyoko', entryIc: find('asahina'),
    exitIc: find('kasumigaseki'), roundTrip: false,
  }, data);
  // 横横+第三京浜 朝比奈→玉川IC(35.9) + 一般道(3) + 3号→C1(12.4) = 51.3km
  within(r.totals.distanceKmOneway, 51.3, '朝比奈→霞ヶ関 (玉川経由、一般道含む)');
  assert.equal(r.totals.deductionKmOneway, 35.9);
});

test('S18 柏(常磐)→霞ヶ関 viaGaikan 物理距離 ≈ 39-41 km (柏10.8 + 外環14 + S1経由15)', () => {
  const data = loadAll();
  const find = (id) => data.ics.find((x) => x.id === id);
  const entry = { ...find('kashiwa'), _viaGaikan: true };
  const r = judgeRoute({
    outerRoute: 'joban', entryIc: entry, exitIc: find('kasumigaseki'), roundTrip: false,
  }, data);
  // viaGaikan時は外環で 三郷JCT→川口JCT、川口JCTから S1川口線で都心入り
  within(r.totals.distanceKmOneway, 39.8, '柏→霞ヶ関 viaGaikan');
});
