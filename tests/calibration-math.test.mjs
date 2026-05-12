import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { aggregateDepartures, computeUpdatedRate } from '../scripts/lib/calibration-math.mjs';

const BUCKETS = [
  { id: 'early',   fromHHMM: '07:00', toHHMM: '09:00' },
  { id: 'morning', fromHHMM: '09:00', toHHMM: '12:00' }
];

test('aggregateDepartures: 時間帯×ターミナル別に集計', () => {
  const ticks = [
    { ts: '2026-05-12T08:00:00+09:00', departures: [
      { lane: '第一', terminal: 'T1' },
      { lane: '第三', terminal: 'T2' }
    ]},
    { ts: '2026-05-12T08:30:00+09:00', departures: [
      { lane: '第一', terminal: 'T1' }
    ]},
    { ts: '2026-05-12T10:00:00+09:00', departures: [
      { lane: '第二', terminal: 'T1' }
    ]}
  ];
  const agg = aggregateDepartures(ticks, BUCKETS);
  assert.equal(agg.early.T1, 2);
  assert.equal(agg.early.T2, 1);
  assert.equal(agg.morning.T1, 1);
  assert.equal(agg.morning.T2, 0);
});

test('aggregateDepartures: bucket範囲外のtickは無視', () => {
  const ticks = [
    { ts: '2026-05-12T05:00:00+09:00', departures: [{ lane: '第一', terminal: 'T1' }] }, // bucket外
    { ts: '2026-05-12T08:00:00+09:00', departures: [{ lane: '第一', terminal: 'T1' }] }
  ];
  const agg = aggregateDepartures(ticks, BUCKETS);
  assert.equal(agg.early.T1, 1);
});

test('aggregateDepartures: departures が undefined のtickも安全に処理', () => {
  const ticks = [
    { ts: '2026-05-12T08:00:00+09:00' }, // departures field なし
    { ts: '2026-05-12T08:30:00+09:00', departures: [{ lane: '第一', terminal: 'T1' }] }
  ];
  const agg = aggregateDepartures(ticks, BUCKETS);
  assert.equal(agg.early.T1, 1);
});

test('computeUpdatedRate: 通常更新 (EMA α=0.2, observed=previous なら変化なし)', () => {
  const result = computeUpdatedRate({
    observedDepartures: 80,
    estimatedPaxTerminal: 400,
    previousRate: 0.20,
    alpha: 0.2,
    sampleCount: 100
  });
  assert.ok(Math.abs(result.newRate - 0.20) < 1e-6);
  assert.equal(result.skipped, false);
});

test('computeUpdatedRate: サンプル<50 はスキップ', () => {
  const result = computeUpdatedRate({
    observedDepartures: 5, estimatedPaxTerminal: 50,
    previousRate: 0.20, alpha: 0.2, sampleCount: 30
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'insufficient_samples');
  assert.equal(result.newRate, 0.20);
});

test('computeUpdatedRate: 分母ゼロはスキップ', () => {
  const result = computeUpdatedRate({
    observedDepartures: 10, estimatedPaxTerminal: 0,
    previousRate: 0.20, alpha: 0.2, sampleCount: 100
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'zero_denominator');
});

test('computeUpdatedRate: ±50%超は半分のみ反映', () => {
  // observed_rate = 200/400 = 0.5, previous = 0.2
  // drift = (0.5 - 0.2) / 0.2 = 1.5 → > 0.5 → 半分のみ
  // adjusted_observed = 0.2 + (0.5 - 0.2) * 0.5 = 0.35
  // new = 0.2 * 0.35 + 0.8 * 0.2 = 0.07 + 0.16 = 0.23
  const result = computeUpdatedRate({
    observedDepartures: 200, estimatedPaxTerminal: 400,
    previousRate: 0.20, alpha: 0.2, sampleCount: 100
  });
  assert.ok(Math.abs(result.newRate - 0.23) < 1e-6, `got ${result.newRate}`);
  assert.equal(result.warning, 'large_drift_clamped');
});

test('computeUpdatedRate: clamp 上限 0.95', () => {
  const result = computeUpdatedRate({
    observedDepartures: 1000, estimatedPaxTerminal: 10,
    previousRate: 0.2, alpha: 0.2, sampleCount: 100
  });
  assert.equal(result.newRate, 0.95);
});

test('computeUpdatedRate: clamp 下限 0.01', () => {
  const result = computeUpdatedRate({
    observedDepartures: 0, estimatedPaxTerminal: 1000,
    previousRate: 0.01, alpha: 0.2, sampleCount: 100
  });
  // observed_rate=0, drift = (0 - 0.01) / 0.01 = -1 → > 0.5 → half reflect
  // adjusted_observed = 0.01 + (0 - 0.01) * 0.5 = 0.005
  // new = 0.2*0.005 + 0.8*0.01 = 0.001 + 0.008 = 0.009 → clamp 0.01
  assert.equal(result.newRate, 0.01);
});
