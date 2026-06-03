import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { bucketOfDay, buildAdvanceModel, predictAdvance, recentActualCount, lastCompletedBinRow, arrivalDemandByStall, flightFactorByStall, predictAdvanceWithFlights, learnArrivalLag } from '../scripts/lib/advance-forecast.mjs';

test('learnArrivalLag: 既知のラグを復元(合成データ)', () => {
  // stall3: 需要の2バケット後に列移動が比例して出る(lag=2)。十分なサンプル数。
  const demand = [], advance = [];
  const base = Math.floor(new Date('2026-06-01T06:00:00+09:00').getTime() / 1000);
  for (let i = 0; i < 60; i++) {
    const dEpoch = base + i * 900;
    const dv = (i % 7) + 1; // 1..7 の変動
    demand.push({ ts: new Date(dEpoch * 1000).toISOString(), stalls: { stall3: dv } });
    // 列移動は2バケット後に demand*2
    advance.push({ ts: new Date((dEpoch + 2 * 900) * 1000).toISOString(), stalls: { stall3: dv * 2 } });
  }
  const r = learnArrivalLag(demand, advance, { stalls: ['stall3'], minSamples: 20, minCorr: 0.2 });
  assert.equal(r.coeffs.stall3.lag, 2, 'lag=2を復元');
  assert.equal(r.coeffs.stall3.applied, true);
  assert.ok(r.coeffs.stall3.corr > 0.9);
});

test('learnArrivalLag: サンプル不足は未適用(lag0)', () => {
  const demand = [{ ts: '2026-06-01T08:00:00+09:00', stalls: { stall1: 3 } }];
  const advance = [{ ts: '2026-06-01T08:00:00+09:00', stalls: { stall1: 1 } }];
  const r = learnArrivalLag(demand, advance, { stalls: ['stall1'], minSamples: 40 });
  assert.equal(r.coeffs.stall1.applied, false);
  assert.equal(r.coeffs.stall1.lag, 0);
});

test('arrivalDemandByStall: poolLane(号)→stall・lobbyExitTimeのバケットにpax集計', () => {
  const arr = { flights: [
    { poolLane: 3, lobbyExitTime: '18:05', estimatedTaxiPax: 10 },
    { poolLane: 3, lobbyExitTime: '18:12', estimatedTaxiPax: 5 },  // 同じ18:00-18:15バケット
    { poolLane: 1, lobbyExitTime: '18:40', estimatedTaxiPax: 7 },
    { poolLane: 2, lobbyExitTime: null, estimatedTaxiPax: 9 },     // 無効
    { poolLane: 4, lobbyExitTime: '18:05', estimatedTaxiPax: 0 },  // pax0は無視
  ]};
  const d = arrivalDemandByStall(arr);
  const b1815 = (18 * 60) / 15; // 72
  assert.equal(d.stall3[b1815], 15);
  assert.equal(d.stall1[(18 * 60 + 40) / 15 | 0], 7);
  assert.equal(d.stall4.reduce((a, b) => a + b, 0), 0);
});

test('flightFactorByStall: 自己正規化・多い時間帯>1・便なし=1.0・clip', () => {
  const arr = { flights: [
    { poolLane: 3, lobbyExitTime: '18:05', estimatedTaxiPax: 30 }, // 多い
    { poolLane: 3, lobbyExitTime: '19:05', estimatedTaxiPax: 10 }, // 平均的
  ]};
  const ff = flightFactorByStall(arr);
  const b18 = 72, b19 = 76, b12 = 48;
  assert.ok(ff.stall3[b18] > 1.0, '多い時間帯は>1');
  assert.ok(ff.stall3[b19] < 1.0, '少ない時間帯は<1');
  assert.equal(ff.stall3[b12], 1.0, '便なしは1.0');
  assert.ok(ff.stall3[b18] <= 2.0, 'clip上限');
  // 便のない乗り場は全て1.0
  assert.ok(ff.stall1.every((v) => v === 1.0));
});

test('predictAdvanceWithFlights: 係数を掛ける/無ければ素の予測', () => {
  const model = { buckets: { 72: { rows: 2, sums: { stall3: 4 } } } };
  const ts = '2026-01-01T18:00:00+09:00';
  assert.equal(predictAdvance(model, ts, 'stall3'), 2); // 4/2
  const ff = { stall3: new Array(96).fill(1) }; ff.stall3[72] = 1.5;
  assert.equal(predictAdvanceWithFlights(model, ts, 'stall3', ff), 3); // 2*1.5
  assert.equal(predictAdvanceWithFlights(model, ts, 'stall3', null), 2); // フォールバック
});

test('flightFactorByStall: lagByStallでバケットを後ろにずらす(段階B)', () => {
  const arr = { flights: [
    { poolLane: 3, lobbyExitTime: '18:05', estimatedTaxiPax: 30 },
    { poolLane: 3, lobbyExitTime: '19:05', estimatedTaxiPax: 10 },
  ]};
  const noLag = flightFactorByStall(arr);
  assert.ok(noLag.stall3[72] > 1.0, 'lag無し: 18:00台が強い');
  const ff = flightFactorByStall(arr, { lagByStall: { stall3: 2 } }); // +2バケット=+30分
  assert.equal(ff.stall3[72], 1.0, '元18:00台は便なし扱いに');
  assert.ok(ff.stall3[74] > 1.0, '+2バケット(18:30台)へシフト');
});

// movement-shift-history 風の行を作る（60秒間隔, frontDensity 指定）
function mkRows(stall, vals, startIso) {
  const start = Math.floor(new Date(startIso).getTime() / 1000);
  return vals.map((v, i) => ({
    ts: new Date((start + i * 60) * 1000).toISOString(),
    stalls: { [stall]: { frontDensity: v } },
  }));
}

test('recentActualCount: 直近窓のfrontDensity変化から前進回数を数える', () => {
  // 100→130(上,t=120s)→…→100(下,t=300s) の2遷移。debounce120s未満を避ける間隔
  const rows = mkRows('stall1', [100, 100, 130, 130, 130, 100, 100], '2026-06-03T13:00:00Z');
  const now = Math.floor(new Date('2026-06-03T13:07:00Z').getTime() / 1000);
  const n = recentActualCount(rows, 'stall1', now, { windowMin: 15, absThreshold: 10, debounceSec: 120 });
  assert.equal(n, 2);
});

test('lastCompletedBinRow: 直前の完成15分ビンの行を返す/重複は返さない', () => {
  // 13:00:00+09:00 は epoch が900の倍数。ビン[13:00,13:15) に stall1 の遷移を仕込む
  const binStart = Math.floor(new Date('2026-06-03T13:00:00+09:00').getTime() / 1000);
  const isoZ = (ep) => new Date(ep * 1000).toISOString();
  const ms = [];
  const vals = [100, 100, 130, 130, 130, 100, 100]; // 13:00..13:06, 2遷移
  vals.forEach((v, i) => ms.push({ ts: isoZ(binStart + i * 60), stalls: { stall1: { frontDensity: v } } }));
  const now = binStart + 16 * 60; // 13:16 → 現在ビン13:15、完成ビン=13:00
  const row = lastCompletedBinRow([], ms, now, { stalls: ['stall1'], absThreshold: 10, debounceSec: 120 });
  assert.ok(row, '行が返る');
  assert.equal(row.stalls.stall1, 2);
  assert.equal(bucketOfDay(row.ts), 52); // 13:00 = 13*4 = 52

  // 既に履歴にそのビンがあれば null
  const dup = lastCompletedBinRow([{ ts: row.ts, stalls: { stall1: 2 } }], ms, now, { stalls: ['stall1'], absThreshold: 10, debounceSec: 120 });
  assert.equal(dup, null);
});

test('recentActualCount: 平坦/窓外は0', () => {
  const flat = mkRows('stall1', [100, 101, 99, 100, 100], '2026-06-03T13:00:00Z');
  const now = Math.floor(new Date('2026-06-03T13:06:00Z').getTime() / 1000);
  assert.equal(recentActualCount(flat, 'stall1', now, { windowMin: 15, absThreshold: 15, debounceSec: 120 }), 0);
  // 窓(15分)より前のデータしかない場合は0
  const old = mkRows('stall1', [100, 130, 100], '2026-06-03T11:00:00Z');
  assert.equal(recentActualCount(old, 'stall1', now, { windowMin: 15, absThreshold: 10, debounceSec: 120 }), 0);
});

test('bucketOfDay: JST時刻を15分インデックス(0..95)に', () => {
  assert.equal(bucketOfDay('2026-05-20T00:00:00+09:00'), 0);
  assert.equal(bucketOfDay('2026-05-20T12:00:00+09:00'), 48);
  assert.equal(bucketOfDay('2026-05-20T12:15:00+09:00'), 49);
  assert.equal(bucketOfDay('2026-05-20T23:45:00+09:00'), 95);
});

test('buildAdvanceModel: 同一時間帯の複数日を乗り場ごとに平均', () => {
  const rows = [
    { ts: '2026-05-20T12:00:00+09:00', stalls: { stall1: 2, stall3: 1 } },
    { ts: '2026-05-21T12:00:00+09:00', stalls: { stall1: 4 } },
    { ts: '2026-05-22T12:00:00+09:00', stalls: { stall1: 6, stall3: 3 } },
  ];
  const m = buildAdvanceModel(rows);
  // stall1 の 12:00 バケット(48) は (2+4+6)/3 = 4
  assert.equal(predictAdvance(m, '2026-06-01T12:00:00+09:00', 'stall1'), 4);
  // stall3 は 12:00 の3行で (1 + 0[欠損=0回] + 3)/3 = 1.333…
  assert.ok(Math.abs(predictAdvance(m, '2026-06-01T12:07:00+09:00', 'stall3') - 4 / 3) < 1e-9);
});

test('predictAdvance: 学習データの無い時間帯は0', () => {
  const m = buildAdvanceModel([{ ts: '2026-05-20T12:00:00+09:00', stalls: { stall1: 3 } }]);
  assert.equal(predictAdvance(m, '2026-06-01T03:00:00+09:00', 'stall1'), 0);
  assert.equal(predictAdvance(m, '2026-06-01T12:00:00+09:00', 'stall9'), 0);
});
