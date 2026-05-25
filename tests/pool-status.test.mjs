import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { occLevel, activityLevel } from '../scripts/lib/pool-status.mjs';
import { currentOccupancy, fullRefFor, buildPoolStatus } from '../scripts/lib/pool-status.mjs';
import { currentOccupancyByStall, waitMinFor, stallTrend, buildStalls, buildTerminalArrivals } from '../scripts/lib/pool-status.mjs';

test('occLevel: occ/fullRef を 4 段階に写像', () => {
  assert.equal(occLevel(0, 50), 'empty');
  assert.equal(occLevel(10, 50), 'empty');
  assert.equal(occLevel(20, 50), 'normal');
  assert.equal(occLevel(35, 50), 'crowded');
  assert.equal(occLevel(46, 50), 'full');
  assert.equal(occLevel(5, 0), 'empty');
});

test('activityLevel: 比で active/normal/low + arrow', () => {
  assert.deepEqual(activityLevel(38, 28), { ratio: 1.36, level: 'active', arrow: 'up' });
  assert.deepEqual(activityLevel(28, 28), { ratio: 1, level: 'normal', arrow: 'flat' });
  assert.deepEqual(activityLevel(10, 28), { ratio: 0.36, level: 'low', arrow: 'down' });
  assert.deepEqual(activityLevel(5, 0), { ratio: 0, level: 'normal', arrow: 'flat' });
});

function occRow(ts, s1, s2, s3, s4, back) {
  return { ts, mode: 'day', stalls: {
    stall1: { occ: s1 }, stall2: { occ: s2 }, stall3: { occ: s3 },
    stall4: { occ: s4 }, stall4_back: { occ: back } } };
}

test('currentOccupancy: 直近 N tick の中央値を group 別に', () => {
  const base = Date.parse('2026-05-25T12:00:00+09:00');
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(occRow(new Date(base + i * 30000).toISOString(), 10, 8, 12, 4, 8));
  const cur = currentOccupancy(rows, new Date(base + 5 * 30000), 5);
  assert.equal(cur.real01, 34);
  assert.equal(cur.real02, 8);
});

test('fullRefFor: group occ の92%ile・下限クランプ', () => {
  const base = Date.parse('2026-05-25T08:00:00+09:00');
  const rows = [];
  for (let i = 0; i < 50; i++) rows.push(occRow(new Date(base + i * 60000).toISOString(), i % 16, 0, 0, 0, 0));
  const fr = fullRefFor(rows, 'real01', { days: 7, pct: 0.92, min: 20, now: new Date(base + 50 * 60000) });
  assert.equal(fr, 20);
});

test('buildPoolStatus: スキーマ通りに組み立つ', () => {
  const base = Date.parse('2026-05-25T12:00:00+09:00');
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(occRow(new Date(base + i * 30000).toISOString(), 12, 10, 14, 4, 8));
  const st = buildPoolStatus(rows, new Date(base + 20 * 30000));
  assert.ok(['empty', 'normal', 'crowded', 'full'].includes(st.cameras.real01.level));
  assert.equal(st.cameras.real02.occ, 8);
  assert.ok(typeof st.total.occ === 'number');
  assert.ok(['low', 'normal', 'active'].includes(st.activity.level));
  assert.ok(st.generatedAt);
  assert.ok(st.generatedAt.includes('+09:00'), 'generatedAt は JST(+09:00)表記'); // UTCずれ防止
});

test('currentOccupancyByStall: 乗り場別中央値・第4は back を合算', () => {
  const base = Date.parse('2026-05-25T12:00:00+09:00');
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(occRow(new Date(base + i * 30000).toISOString(), 10, 8, 12, 4, 8));
  const cur = currentOccupancyByStall(rows, new Date(base + 5 * 30000), 5);
  assert.equal(cur.stall1, 10);
  assert.equal(cur.stall2, 8);
  assert.equal(cur.stall3, 12);
  assert.equal(cur.stall4, 12); // stall4(4) + stall4_back(8)
});

test('waitMinFor: 在台×60÷直近1h出庫。出庫0は null', () => {
  assert.equal(waitMinFor(10, 30), 20);   // 10*60/30
  assert.equal(waitMinFor(9, 4), 135);    // 9*60/4 = 135
  assert.equal(waitMinFor(5, 0), null);   // 出庫0 → 算出不能
  assert.equal(waitMinFor(0, 12), 0);     // 在台0 → 0分
});

test('stallTrend: 直近30/前30 の比で up/flat/down。前30が0は flat', () => {
  assert.equal(stallTrend(10, 4), 'up');    // 2.5 >= 1.25
  assert.equal(stallTrend(5, 4), 'up');     // 1.25 ちょうど
  assert.equal(stallTrend(4, 4), 'flat');   // 1.0
  assert.equal(stallTrend(2, 4), 'down');   // 0.5 < 0.75
  assert.equal(stallTrend(3, 4), 'flat');   // 0.75 ちょうどは flat（<0.75 のみ down）
  assert.equal(stallTrend(8, 0), 'flat');   // 前30=0 は基準不足 → flat
});

test('buildStalls: 4乗り場のスキーマとターミナル対応。出庫無しは waitMin=null/trend=flat', () => {
  const base = Date.parse('2026-05-25T12:00:00+09:00');
  const rows = [];
  // 在台一定（出庫が発生しない）データ
  for (let i = 0; i < 20; i++) rows.push(occRow(new Date(base + i * 30000).toISOString(), 10, 8, 12, 4, 8));
  const stalls = buildStalls(rows, new Date(base + 20 * 30000));
  assert.deepEqual(Object.keys(stalls), ['stall1', 'stall2', 'stall3', 'stall4']);
  assert.equal(stalls.stall1.label, '第1乗り場');
  assert.equal(stalls.stall1.terminal, 'T1');
  assert.equal(stalls.stall3.terminal, 'T2');
  assert.equal(stalls.stall4.occ, 12);          // stall4 + back
  assert.equal(stalls.stall1.recent1hDep, 0);   // 在台一定 → 出庫0
  assert.equal(stalls.stall1.waitMin, null);    // 出庫0 → null
  assert.equal(stalls.stall1.trend, 'flat');
});

test('buildTerminalArrivals: lobbyExitTime で next30/next60 を terminal別に集計', () => {
  const now = new Date(Date.parse('2026-05-25T12:00:00+09:00'));
  const arrivals = { flights: [
    { terminal: 'T1', lobbyExitTime: '12:20', estimatedTaxiPax: 5 },  // next30 ⊂ next60
    { terminal: 'T1', lobbyExitTime: '12:50', estimatedTaxiPax: 3 },  // next60 のみ
    { terminal: 'T2', lobbyExitTime: '12:10', estimatedTaxiPax: 7 },  // next30 ⊂ next60
    { terminal: 'T3', lobbyExitTime: '12:15', estimatedTaxiPax: 9 },  // 対象外
    { terminal: 'T1', lobbyExitTime: '11:55', estimatedTaxiPax: 4 },  // 過去 → 除外
    { terminal: 'T2', lobbyExitTime: '13:30', estimatedTaxiPax: 8 },  // 60分超 → 除外
  ] };
  const ta = buildTerminalArrivals(arrivals, now);
  assert.deepEqual(ta.T1, { next30: 5, next60: 8 });
  assert.deepEqual(ta.T2, { next30: 7, next60: 7 });
});

test('buildTerminalArrivals: flights 無し/不正でも 0 を返す', () => {
  const now = new Date(Date.parse('2026-05-25T12:00:00+09:00'));
  assert.deepEqual(buildTerminalArrivals(null, now), { T1: { next30: 0, next60: 0 }, T2: { next30: 0, next60: 0 } });
});
