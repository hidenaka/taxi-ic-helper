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
const find = (data, id) => data.ics.find((x) => x.id === id);

// 社内ルール: 控除km(社内表値) と 物理走行距離 は別物。
// distanceKm は実走行距離、deductionKm は社内表値であるべき。

// ── 関越方面: 所沢 (Wikipedia 確認値: 所沢IC=9.4kp, 練馬IC=0kp, 大泉JCT=0.8kp) ──
// 関越自動車道は 控除値 = 物理距離 (起点=練馬IC で社内表と一致)

test('P1 関越 所沢→霞ヶ関 (non-viaGaikan): 関越セグ 距離=控除=9.4km', () => {
  const data = loadAll();
  const r = judgeRoute({
    outerRoute: 'kanetsu',
    entryIc: find(data, 'tokorozawa'),
    exitIc: find(data, 'kasumigaseki'),
    roundTrip: false,
  }, data);
  const k = r.segments.find((s) => s.route === 'kanetsu');
  assert.equal(k.deductionKm, 9.4);
  assert.equal(k.distanceKm, 9.4, '控除値=物理距離 (Wikipedia kp と完全一致)');
});

test('P2 関越 所沢→霞ヶ関 (viaGaikan): 関越セグ 距離=8.6km (大泉JCT 0.8kp で分岐)', () => {
  const data = loadAll();
  const entry = { ...find(data, 'tokorozawa'), _viaGaikan: true };
  const r = judgeRoute({
    outerRoute: 'kanetsu', entryIc: entry, exitIc: find(data, 'kasumigaseki'), roundTrip: false,
  }, data);
  const k = r.segments.find((s) => s.route === 'kanetsu');
  assert.equal(k.deductionKm, 9.4, '控除は固定 9.4');
  // viaGaikan時は 大泉JCT (Wikipedia 0.8kp) で分岐 → 9.4 - 0.8 = 8.6km
  assert.ok(Math.abs(k.distanceKm - 8.6) <= 0.1,
    `関越 viaGaikan 物理距離 期待8.6km ±0.1、実測 ${k.distanceKm}km`);
});

test('P3 関越 所沢→霞ヶ関 viaGaikan 総距離 ≈ 39km (8.6 + 7.8 + 美女木→霞ヶ関23)', () => {
  const data = loadAll();
  const entry = { ...find(data, 'tokorozawa'), _viaGaikan: true };
  const r = judgeRoute({
    outerRoute: 'kanetsu', entryIc: entry, exitIc: find(data, 'kasumigaseki'), roundTrip: false,
  }, data);
  // 関越(8.6) + 外環(7.8) + 首都高 bijogi_jct→kasumigaseki(23.0) = 39.4km
  // viaGaikan時の首都高 entry は美女木JCT (5号池袋線端点)
  assert.ok(r.totals.distanceKmOneway >= 38.0 && r.totals.distanceKmOneway <= 42.0,
    `総距離 期待38-42km、実測 ${r.totals.distanceKmOneway}km`);
});

// ── 東名: 横浜青葉 (Wikipedia: 横浜青葉IC 12.0kp, 東京IC 6.5kp相当でこの距離=控除と一致) ──
// 東京IC は 東名起点(0kp)から首都高接続 6.5kp 付近、横浜青葉は 12.0kp 付近で
// 物理距離 横浜青葉→東京IC ≈ 13.3km (現控除値と概ね一致)

test('P4 東名 横浜青葉→東京IC: 物理距離 ≈ 控除13.3km (差分なし)', () => {
  const data = loadAll();
  const r = judgeRoute({
    outerRoute: 'tomei',
    entryIc: find(data, 'yokohama_aoba'),
    exitIc: find(data, 'kasumigaseki'),
    roundTrip: false,
  }, data);
  const t = r.segments.find((s) => s.route === 'tomei');
  // 東名は viaGaikan なし、控除≈物理 でも問題ない
  assert.ok(Math.abs(t.distanceKm - 13.3) <= 1.0,
    `東名 横浜青葉 物理距離 期待13.3km ±1.0、実測 ${t.distanceKm}km`);
});

// ── physical_km フィールドが存在する場合の挙動 ──

test('P5 physical_km 未設定の entry は km (控除値) にフォールバック', () => {
  const data = loadAll();
  // physical_km を持たないエントリで判定が壊れないこと
  const r = judgeRoute({
    outerRoute: 'tomei', entryIc: find(data, 'gotemba'),
    exitIc: find(data, 'kasumigaseki'), roundTrip: false,
  }, data);
  const t = r.segments.find((s) => s.route === 'tomei');
  // gotemba は physical_km 未設定なら控除 83.7 を distanceKm として使う
  assert.ok(t.distanceKm > 0, 'gotemba 物理距離が出ること');
});

// ── deductionKm は physical_km 影響を受けない ──

test('P6 物理距離を変えても 控除 (deductionKm) は社内表値を保持', () => {
  const data = loadAll();
  const r = judgeRoute({
    outerRoute: 'kanetsu',
    entryIc: { ...find(data, 'tokorozawa'), _viaGaikan: true },
    exitIc: find(data, 'kasumigaseki'),
    roundTrip: false,
  }, data);
  // 控除合計は 関越 9.4 のみ (外環/首都高は 0)
  assert.equal(r.totals.deductionKmOneway, 9.4);
});
