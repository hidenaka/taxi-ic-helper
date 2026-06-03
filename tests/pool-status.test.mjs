import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { occLevel, activityLevel } from '../scripts/lib/pool-status.mjs';
import { currentOccupancy, fullRefFor, buildPoolStatus } from '../scripts/lib/pool-status.mjs';
import { currentOccupancyByStall, waitMinFor, stallTrend, buildStalls, buildTerminalArrivals } from '../scripts/lib/pool-status.mjs';
import { sameConditionCompare } from '../scripts/lib/pool-status.mjs';
import { buildStallRankHint } from '../scripts/lib/pool-status.mjs';
import { buildTerminalArrivalsList, buildNoribaArrivalsList } from '../scripts/lib/pool-status.mjs';

test('buildNoribaArrivalsList: poolLane(号)別・60分内・欠航除外・lobbyExit順', () => {
  const now = new Date(Date.parse('2026-05-25T12:00:00+09:00'));
  const arrivals = { flights: [
    { terminal: 'T1', poolLane: 1, flightNumber: 'JL024', airline: 'JAL', fromName: '伊丹', seatCount: 200, lobbyExitTime: '12:10' },
    { terminal: 'T1', poolLane: 2, flightNumber: 'JL918', airline: 'JAL', fromName: '那覇', seatCount: 369, lobbyExitTime: '12:05' },
    { terminal: 'T2', poolLane: 3, flightNumber: 'NH032', airline: 'ANA', fromName: '新千歳', seatCount: 195, lobbyExitTime: '12:08' },
    { terminal: 'T3', poolLane: 4, flightNumber: 'JL001', airline: 'JAL', fromName: 'ホノルル', seatCount: 244, lobbyExitTime: '12:20' }, // 号4(国際)も含む
    { terminal: 'T2', poolLane: 4, flightNumber: 'NH640', airline: 'ANA', fromName: '岩国', seatCount: 194, status: '欠航', lobbyExitTime: '12:15' }, // 欠航除外
    { terminal: 'T1', flightNumber: 'JL999', airline: 'JAL', fromName: '小松', seatCount: 166, lobbyExitTime: '12:30' }, // poolLane無し→除外
  ] };
  const r = buildNoribaArrivalsList(arrivals, now);
  assert.equal(r[1].length, 1);
  assert.equal(r[1][0].flightNumber, 'JL024');
  assert.equal(r[2][0].flightNumber, 'JL918');
  assert.equal(r[3][0].flightNumber, 'NH032');
  assert.equal(r[4].length, 1); // 欠航NH640除外、T3 JL001のみ
  assert.equal(r[4][0].flightNumber, 'JL001');
  assert.equal(r[1][0].lobbyExitMinutes, 10);
});

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

test('buildPoolStatus: stalls を必ず含み、arrivals 未指定なら terminalArrivals は null', () => {
  const base = Date.parse('2026-05-25T12:00:00+09:00');
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(occRow(new Date(base + i * 30000).toISOString(), 12, 10, 14, 4, 8));
  const st = buildPoolStatus(rows, new Date(base + 20 * 30000));
  assert.equal(Object.keys(st.stalls).length, 4);
  assert.equal(st.stalls.stall4.terminal, 'T2');
  assert.equal(st.terminalArrivals, null); // 後方互換: arrivals 省略時
});

test('buildPoolStatus: arrivals を渡すと terminalArrivals が入る', () => {
  const now = new Date(Date.parse('2026-05-25T12:00:00+09:00'));
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(occRow(new Date(now.getTime() - (20 - i) * 30000).toISOString(), 12, 10, 14, 4, 8));
  const arrivals = { flights: [{ terminal: 'T1', lobbyExitTime: '12:20', estimatedTaxiPax: 5 }] };
  const st = buildPoolStatus(rows, now, arrivals);
  assert.equal(st.terminalArrivals.T1.next30, 5);
});

const TEST_HOLIDAYS = [
  { date: '2026-05-03', name: '憲法記念日' },
  { date: '2026-05-04', name: 'みどりの日' },
  { date: '2026-05-05', name: 'こどもの日' },
  { date: '2026-05-06', name: '振替休日' },
];

function buildHistoryRows(daysAgoList, depPerHour) {
  // 過去 daysAgoList[i] 日前の 12:00 JST の前後1h分、深さ depPerHour の出庫が発生するように
  // 在台が depPerHour 台減るような行を1分毎に生成する。簡略のため、まず full 在台 で開始し、
  // 終端で depPerHour 台減らす。
  const rows = [];
  for (const d of daysAgoList) {
    const targetBase = Date.parse('2026-05-12T12:00:00+09:00') - d * 86400000;
    // 11:00〜12:00 の60分間、毎分1tick。在台が depPerHour 台減るよう線形に減少
    const startOcc = 30;
    const endOcc = 30 - depPerHour;
    for (let i = 0; i <= 60; i++) {
      const ts = new Date(targetBase - (60 - i) * 60000).toISOString();
      const occ = Math.max(0, Math.round(startOcc - (startOcc - endOcc) * (i / 60)));
      rows.push({ ts, mode: 'day', stalls: {
        stall1: { occ }, stall2: { occ: 0 }, stall3: { occ: 0 }, stall4: { occ: 0 }, stall4_back: { occ: 0 }
      }});
    }
  }
  return rows;
}

test('sameConditionCompare: 同曜日(火)平日のサンプル3つ以上で percent と label が出る', () => {
  // 2026-05-12(火)平日。過去同曜日: 5/5(火・連休最終)→除外
  // 使うのは 4/28(2週前), 4/21(3週前), 4/14(4週前) の3サンプル
  // 全部 8台/h で安定 → today=12 なら +50%, today=4 なら -50%, today=8 なら 0%
  const now = new Date('2026-05-12T12:00:00+09:00');
  const past = buildHistoryRows([7 * 2, 7 * 3, 7 * 4], 8); // 2,3,4週前の火曜（全て平日）
  const today = buildHistoryRows([0], 12);
  const r = sameConditionCompare([...past, ...today], now, TEST_HOLIDAYS);
  assert.equal(r.peers_typical, 8);
  assert.equal(r.percent, 50);
  assert.equal(r.label, 'いつもより活発');
  assert.equal(r.dayLabel, '火曜平日');
});

test('sameConditionCompare: percentがしきい値以内なら "いつも通り"', () => {
  const now = new Date('2026-05-12T12:00:00+09:00');
  const past = buildHistoryRows([14, 21, 28], 10); // 2,3,4週前（全て平日火曜）
  const today = buildHistoryRows([0], 11); // +10%
  const r = sameConditionCompare([...past, ...today], now, TEST_HOLIDAYS);
  assert.equal(r.label, 'いつも通り');
});

test('sameConditionCompare: -15%以下で "いつもより少なめ"', () => {
  const now = new Date('2026-05-12T12:00:00+09:00');
  const past = buildHistoryRows([14, 21, 28], 10); // 2,3,4週前（全て平日火曜）
  const today = buildHistoryRows([0], 8); // -20%
  const r = sameConditionCompare([...past, ...today], now, TEST_HOLIDAYS);
  assert.equal(r.label, 'いつもより少なめ');
});

test('sameConditionCompare: サンプル不足(<3)は fallback (label=null, percent=null)', () => {
  const now = new Date('2026-05-12T12:00:00+09:00');
  // 2週前(4/28)のデータのみ存在。1週前(5/5)は祝日除外。3,4週前はデータなしでスキップ → 1サンプル → fallback
  const past = buildHistoryRows([14], 10);
  const today = buildHistoryRows([0], 12);
  const r = sameConditionCompare([...past, ...today], now, TEST_HOLIDAYS);
  assert.equal(r.peers_typical, null);
  assert.equal(r.percent, null);
  assert.equal(r.label, null);
  assert.equal(r.dayLabel, '火曜平日'); // dayLabel は常に返す
});

test('buildStallRankHint: 最大に most-active、最小に most-low', () => {
  const stalls = {
    stall1: { recent1hDep: 10 },
    stall2: { recent1hDep: 25 },
    stall3: { recent1hDep: 5 },
    stall4: { recent1hDep: 15 },
  };
  const h = buildStallRankHint(stalls);
  assert.equal(h.stall1, null);
  assert.equal(h.stall2, 'most-active');
  assert.equal(h.stall3, 'most-low');
  assert.equal(h.stall4, null);
});

test('buildStallRankHint: 全て0なら全て null', () => {
  const stalls = {
    stall1: { recent1hDep: 0 }, stall2: { recent1hDep: 0 },
    stall3: { recent1hDep: 0 }, stall4: { recent1hDep: 0 },
  };
  const h = buildStallRankHint(stalls);
  assert.deepEqual(h, { stall1: null, stall2: null, stall3: null, stall4: null });
});

test('buildStallRankHint: 同率最大は全部 most-active', () => {
  const stalls = {
    stall1: { recent1hDep: 10 }, stall2: { recent1hDep: 10 },
    stall3: { recent1hDep: 5 }, stall4: { recent1hDep: 8 },
  };
  const h = buildStallRankHint(stalls);
  assert.equal(h.stall1, 'most-active');
  assert.equal(h.stall2, 'most-active');
  assert.equal(h.stall3, 'most-low');
  assert.equal(h.stall4, null);
});

test('buildTerminalArrivalsList: T1/T2のlobbyExitTime順、各最大5便、T3除外、過去・60分超は除外', () => {
  const now = new Date(Date.parse('2026-05-25T12:00:00+09:00'));
  const arrivals = { flights: [
    { terminal: 'T1', flightNumber: 'JL024', airline: 'JAL', fromName: '関西', seatCount: 244, lobbyExitTime: '12:10' },
    { terminal: 'T1', flightNumber: 'JL026', airline: 'JAL', fromName: '福岡', seatCount: 322, lobbyExitTime: '12:45' },
    { terminal: 'T2', flightNumber: 'NH032', airline: 'ANA', fromName: '新千歳', seatCount: 195, lobbyExitTime: '12:08' },
    { terminal: 'T3', flightNumber: 'JL001', airline: 'JAL', fromName: 'SFO', seatCount: 244, lobbyExitTime: '12:15' }, // 除外
    { terminal: 'T1', flightNumber: 'JL022', airline: 'JAL', fromName: '伊丹', seatCount: 244, lobbyExitTime: '11:55' }, // 過去
    { terminal: 'T2', flightNumber: 'NH128', airline: 'ANA', fromName: '那覇', seatCount: 381, lobbyExitTime: '13:30' }, // 60分超
  ] };
  const r = buildTerminalArrivalsList(arrivals, now);
  assert.equal(r.T1.length, 2);
  assert.equal(r.T1[0].flightNumber, 'JL024');
  assert.equal(r.T1[0].lobbyExitMinutes, 10);
  assert.equal(r.T1[0].fromName, '関西');
  assert.equal(r.T1[0].seatCount, 244);
  assert.equal(r.T1[0].lobbyExitTime, '12:10');
  assert.equal(r.T1[1].flightNumber, 'JL026');
  assert.equal(r.T2.length, 1);
  assert.equal(r.T2[0].flightNumber, 'NH032');
});

test('buildTerminalArrivalsList: 各ターミナル最大5便（6便目は捨てる）', () => {
  const now = new Date(Date.parse('2026-05-25T12:00:00+09:00'));
  const flights = [];
  for (let i = 0; i < 7; i++) {
    flights.push({ terminal: 'T1', flightNumber: `JL10${i}`, airline: 'JAL', fromName: '伊丹', seatCount: 244, lobbyExitTime: `12:${String(5 + i * 5).padStart(2, '0')}` });
  }
  const r = buildTerminalArrivalsList({ flights }, now);
  assert.equal(r.T1.length, 5);
  assert.equal(r.T1[4].flightNumber, 'JL104');
});

test('buildTerminalArrivalsList: flights 無し/null は空配列', () => {
  const now = new Date(Date.parse('2026-05-25T12:00:00+09:00'));
  assert.deepEqual(buildTerminalArrivalsList(null, now), { T1: [], T2: [] });
  assert.deepEqual(buildTerminalArrivalsList({ flights: [] }, now), { T1: [], T2: [] });
});

test('buildPoolStatus: 新フィールド統合（後方互換も維持）', () => {
  const base = Date.parse('2026-05-12T12:00:00+09:00');
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(occRow(new Date(base + i * 30000).toISOString(), 12, 10, 14, 4, 8));
  const arrivals = { flights: [
    { terminal: 'T1', flightNumber: 'JL024', airline: 'JAL', fromName: '関西', seatCount: 244, lobbyExitTime: '12:20' }, // now=12:10なので10分後
  ] };
  const st = buildPoolStatus(rows, new Date(base + 20 * 30000), arrivals, TEST_HOLIDAYS);
  // 既存フィールド維持
  assert.ok(st.cameras);
  assert.ok(st.total);
  assert.ok(st.activity);
  assert.ok(st.stalls);
  assert.ok(st.terminalArrivals); // 既存・後方互換
  // 新フィールド
  assert.ok('sameConditionCompare' in st.activity);
  assert.equal(typeof st.stalls.stall1.rankHint, 'object'); // null or string
  assert.ok(Array.isArray(st.terminalArrivalsList.T1));
  assert.equal(st.terminalArrivalsList.T1[0].flightNumber, 'JL024');
});

test('buildPoolStatus: holidays 省略時も sameConditionCompare は null fallback', () => {
  const base = Date.parse('2026-05-12T12:00:00+09:00');
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(occRow(new Date(base + i * 30000).toISOString(), 12, 10, 14, 4, 8));
  const st = buildPoolStatus(rows, new Date(base + 20 * 30000)); // arrivals/holidays 省略
  assert.equal(st.activity.sameConditionCompare, null);
  assert.equal(st.terminalArrivals, null);
  assert.deepEqual(st.terminalArrivalsList, { T1: [], T2: [] });
});

test('buildStallRankHint: stalls=undefined でクラッシュせず全null', () => {
  assert.deepEqual(buildStallRankHint(undefined), { stall1: null, stall2: null, stall3: null, stall4: null });
});

test('sameConditionCompare: stallKey 指定で stall別出庫の中央値で比較', () => {
  // 過去3週(2,3,4週前)の火曜平日 stall3 dep を 10/10/10、今日の stall3 dep を 15 にする
  const now = new Date('2026-05-12T12:00:00+09:00');
  const past = [];
  for (const d of [14, 21, 28]) {
    const targetBase = now.getTime() - d * 86400000;
    // 11:00〜12:00 の60分間、stall3 だけ毎分1tickで occ が 20→10 に線形減少（stall3で10台出庫）
    const startOcc = 20, endOcc = 10;
    for (let i = 0; i <= 60; i++) {
      const ts = new Date(targetBase - (60 - i) * 60000).toISOString();
      const occ3 = Math.max(0, Math.round(startOcc - (startOcc - endOcc) * (i / 60)));
      past.push({ ts, mode: 'day', stalls: {
        stall1: { occ: 0 }, stall2: { occ: 0 }, stall3: { occ: occ3 }, stall4: { occ: 0 }, stall4_back: { occ: 0 }
      }});
    }
  }
  // 今日: stall3 dep を 15 にする (occ 27→10 で平滑化後、past混在でも15台出庫)
  const today = [];
  const todayBase = now.getTime();
  for (let i = 0; i <= 60; i++) {
    const ts = new Date(todayBase - (60 - i) * 60000).toISOString();
    const occ3 = Math.max(0, Math.round(27 - 17 * (i / 60)));
    today.push({ ts, mode: 'day', stalls: {
      stall1: { occ: 0 }, stall2: { occ: 0 }, stall3: { occ: occ3 }, stall4: { occ: 0 }, stall4_back: { occ: 0 }
    }});
  }
  const r = sameConditionCompare([...past, ...today], now, TEST_HOLIDAYS, 4, 'stall3');
  // peers_typical = median(10, 10, 10) = 10、percent = (15/10 - 1) * 100 = 50
  assert.equal(r.peers_typical, 10);
  assert.equal(r.percent, 50);
  assert.equal(r.label, 'いつもより活発');
  assert.equal(r.dayLabel, '火曜平日');
});

test('sameConditionCompare: stallKey null（既定）は既存挙動（全体合計）', () => {
  // Task A3 の既存テストを引数明示なしと null 明示で結果が同じことを確認
  const now = new Date('2026-05-12T12:00:00+09:00');
  const past = buildHistoryRows([14, 21, 28], 8);
  const today = buildHistoryRows([0], 12);
  const rows = [...past, ...today];
  const r1 = sameConditionCompare(rows, now, TEST_HOLIDAYS);
  const r2 = sameConditionCompare(rows, now, TEST_HOLIDAYS, 4, null);
  assert.deepEqual(r1, r2);
});

test('buildStalls: holidays 指定時、各 stall に sameConditionCompare フィールドが付く', () => {
  const now = new Date('2026-05-12T12:00:00+09:00');
  // 過去3週(火曜平日)で stall1 dep=8 のサンプルを作る
  const past = [];
  for (const d of [14, 21, 28]) {
    const targetBase = now.getTime() - d * 86400000;
    const startOcc = 20, endOcc = 12;
    for (let i = 0; i <= 60; i++) {
      const ts = new Date(targetBase - (60 - i) * 60000).toISOString();
      const occ1 = Math.max(0, Math.round(startOcc - (startOcc - endOcc) * (i / 60)));
      past.push({ ts, mode: 'day', stalls: {
        stall1: { occ: occ1 }, stall2: { occ: 0 }, stall3: { occ: 0 }, stall4: { occ: 0 }, stall4_back: { occ: 0 }
      }});
    }
  }
  // 今日: stall1 dep=8 にする (普段通り → percent ≈ 0)
  const today = [];
  for (let i = 0; i <= 60; i++) {
    const ts = new Date(now.getTime() - (60 - i) * 60000).toISOString();
    const occ1 = Math.max(0, Math.round(20 - 8 * (i / 60)));
    today.push({ ts, mode: 'day', stalls: {
      stall1: { occ: occ1 }, stall2: { occ: 0 }, stall3: { occ: 0 }, stall4: { occ: 0 }, stall4_back: { occ: 0 }
    }});
  }
  const stalls = buildStalls([...past, ...today], now, TEST_HOLIDAYS);
  assert.ok(stalls.stall1.sameConditionCompare);
  assert.equal(stalls.stall1.sameConditionCompare.dayLabel, '火曜平日');
  assert.equal(typeof stalls.stall1.sameConditionCompare.percent, 'number');
  assert.ok(stalls.stall1.sameConditionCompare.label);
  // 他stallはdep=0（peers_typical=0）で percent/label は null
  assert.ok(stalls.stall2.sameConditionCompare !== undefined);
  assert.equal(stalls.stall2.sameConditionCompare.percent, null);
  assert.equal(stalls.stall2.sameConditionCompare.label, null);
  assert.equal(stalls.stall2.sameConditionCompare.dayLabel, '火曜平日');
});

test('buildStalls: holidays 未指定（既存呼び出し）でも壊れず、sameConditionCompare=null', () => {
  const base = Date.parse('2026-05-12T12:00:00+09:00');
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(occRow(new Date(base + i * 30000).toISOString(), 12, 10, 14, 4, 8));
  const stalls = buildStalls(rows, new Date(base + 20 * 30000)); // holidays 省略
  assert.equal(stalls.stall1.sameConditionCompare, null);
  assert.equal(stalls.stall3.sameConditionCompare, null);
  // 既存フィールド（label/terminal/occ/recent1hDep/waitMin/trend）は維持
  assert.equal(stalls.stall1.label, '第1乗り場');
  assert.equal(stalls.stall1.terminal, 'T1');
});
