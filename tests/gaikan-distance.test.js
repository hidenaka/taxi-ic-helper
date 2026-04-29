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
const run = (opts, data) => judgeRoute({ roundTrip: true, ...opts }, data);

// 外環セグメントの distanceKm が gaikan_distances.json の値と一致すること
// 控除km は引き続き 0 のまま (社内ルール: 外環は控除対象外)

test('T1 関越 viaGaikan: 外環セグメント distanceKm = 7.8 (oizumi_jct↔bijogi_jct)', () => {
  const data = loadAll();
  const entry = { ...find(data, 'tokorozawa'), _viaGaikan: true };
  const r = run({
    outerRoute: 'kanetsu', entryIc: entry, exitIc: find(data, 'kasumigaseki'),
  }, data);
  const g = r.segments.find((s) => s.route === 'gaikan');
  assert.equal(g.distanceKm, 7.8);
  assert.equal(g.deductionKm, 0, '控除は 0 のまま');
});

test('T2 常磐 viaGaikan: 外環セグメント distanceKm = 14.0 (misato_jct↔kawaguchi_jct)', () => {
  const data = loadAll();
  const entry = { ...find(data, 'kashiwa'), _viaGaikan: true };
  const r = run({
    outerRoute: 'joban', entryIc: entry, exitIc: find(data, 'kasumigaseki'),
  }, data);
  const g = r.segments.find((s) => s.route === 'gaikan');
  assert.equal(g.distanceKm, 14.0);
  assert.equal(g.deductionKm, 0);
});

test('T3 東北 (常に外環): 外環セグメント distanceKm = 12.1 (kawaguchi_jct↔bijogi_jct)', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'tohoku', entryIc: find(data, 'urawa'), exitIc: find(data, 'kasumigaseki'),
  }, data);
  const g = r.segments.find((s) => s.route === 'gaikan');
  assert.equal(g.distanceKm, 12.1);
  assert.equal(g.deductionKm, 0);
});

test('T4 外環直乗り 大泉IC: 外環セグメント distanceKm = 7.8 (大泉→美女木)', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'gaikan_direct', entryIc: find(data, 'oizumi'), exitIc: find(data, 'kasumigaseki'),
  }, data);
  const g = r.segments.find((s) => s.route === 'gaikan');
  assert.equal(g.distanceKm, 7.8);
  assert.equal(g.deductionKm, 0);
});

test('T5 外環直乗り 大泉JCT: 外環セグメント distanceKm = 7.8 (大泉JCT→美女木JCT)', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'gaikan_direct', entryIc: find(data, 'oizumi_jct'), exitIc: find(data, 'kasumigaseki'),
  }, data);
  const g = r.segments.find((s) => s.route === 'gaikan');
  assert.equal(g.distanceKm, 7.8);
});

test('T6 外環直乗り 美女木JCT: 外環セグメント distanceKm = 0 (既に5号境界)', () => {
  const data = loadAll();
  const r = run({
    outerRoute: 'gaikan_direct', entryIc: find(data, 'bijogi_jct'), exitIc: find(data, 'kasumigaseki'),
  }, data);
  const g = r.segments.find((s) => s.route === 'gaikan');
  assert.equal(g.distanceKm, 0);
});

test('T7 関越 viaGaikan 総距離: 関越(8.6) + 外環(7.8) + 首都高 美女木→霞ヶ関(25.9) = 42.3km片道', () => {
  const data = loadAll();
  const entry = { ...find(data, 'tokorozawa'), _viaGaikan: true };
  const r = run({
    outerRoute: 'kanetsu', entryIc: entry, exitIc: find(data, 'kasumigaseki'),
  }, data);
  // 関越=9.4-0.8(大泉JCT分岐)=8.6 + 外環=7.8 + 首都高(bijogi_jct→kasumigaseki 5号→C1)=25.9 = 42.3km
  // viaGaikan時は本線baseline(練馬IC)ではなく外環接続点(美女木JCT)で首都高に乗る
  assert.equal(r.totals.distanceKmOneway, 42.3);
});
