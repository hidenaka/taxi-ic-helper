import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { summarizeArrivalsWindow } from '../scripts/lib/arrivals-window-summary.mjs';

// 共通フィクスチャ
function mkFlight(opts) {
  return {
    flightNumber: opts.flightNumber ?? 'XX000',
    scheduledTime: opts.scheduledTime ?? null,
    estimatedTime: opts.estimatedTime ?? null,
    estimatedPax: opts.estimatedPax ?? null,
    estimatedTaxiPax: opts.estimatedTaxiPax ?? null,
    reachTier: opts.reachTier ?? null
  };
}

// 全てのテストで JST 13:00 を「現在」として使う (窓 = 12:30 〜 14:00)
const NOW = new Date('2026-05-11T13:00:00+09:00');

test('全便が窓内 → 合計値が正確', () => {
  const arrivals = {
    flights: [
      mkFlight({ flightNumber: 'A1', estimatedTime: '12:45', estimatedPax: 100, estimatedTaxiPax: 15, reachTier: 'high' }),
      mkFlight({ flightNumber: 'A2', estimatedTime: '13:30', estimatedPax: 200, estimatedTaxiPax: 30, reachTier: 'mid' })
    ]
  };
  const r = summarizeArrivalsWindow(arrivals, NOW);
  assert.equal(r.flight_count, 2);
  assert.equal(r.estimated_pax_sum, 300);
  assert.equal(r.estimated_taxi_pax_sum, 45);
  assert.equal(r.reach_none_count, 0);
});

test('窓外の便はカウントされない', () => {
  const arrivals = {
    flights: [
      mkFlight({ flightNumber: 'IN',  estimatedTime: '13:30', estimatedPax: 100, estimatedTaxiPax: 10 }),
      mkFlight({ flightNumber: 'OUT', estimatedTime: '15:00', estimatedPax: 999, estimatedTaxiPax: 99 })
    ]
  };
  const r = summarizeArrivalsWindow(arrivals, NOW);
  assert.equal(r.flight_count, 1);
  assert.equal(r.estimated_pax_sum, 100);
  assert.equal(r.estimated_taxi_pax_sum, 10);
});

test('estimatedTime 優先、なければ scheduledTime', () => {
  const arrivals = {
    flights: [
      // estimatedTime が窓外 (15:00) だが scheduledTime は窓内 (13:30) → estimatedTime を見るので除外
      mkFlight({ flightNumber: 'D1', scheduledTime: '13:30', estimatedTime: '15:00', estimatedPax: 100 }),
      // estimatedTime なし、scheduledTime が窓内 → カウント
      mkFlight({ flightNumber: 'S1', scheduledTime: '12:45', estimatedPax: 50, estimatedTaxiPax: 8 })
    ]
  };
  const r = summarizeArrivalsWindow(arrivals, NOW);
  assert.equal(r.flight_count, 1);
  assert.equal(r.estimated_pax_sum, 50);
  assert.equal(r.estimated_taxi_pax_sum, 8);
});

test('"24:30" 表記は翌日 00:30 として扱う (深夜便)', () => {
  // 現在を JST 23:50 として、24:30 (翌日 00:30) は now+60 分以内
  const now = new Date('2026-05-11T23:50:00+09:00');
  const arrivals = {
    flights: [
      mkFlight({ flightNumber: 'NIGHT', estimatedTime: '24:30', estimatedPax: 150, estimatedTaxiPax: 25 })
    ]
  };
  const r = summarizeArrivalsWindow(arrivals, now);
  assert.equal(r.flight_count, 1);
  assert.equal(r.estimated_taxi_pax_sum, 25);
});

test('estimatedPax / estimatedTaxiPax が null の便は合計に寄与しない', () => {
  const arrivals = {
    flights: [
      mkFlight({ flightNumber: 'N1', estimatedTime: '13:00', estimatedPax: null, estimatedTaxiPax: null, reachTier: 'none' })
    ]
  };
  const r = summarizeArrivalsWindow(arrivals, NOW);
  assert.equal(r.flight_count, 1);
  assert.equal(r.estimated_pax_sum, 0);
  assert.equal(r.estimated_taxi_pax_sum, 0);
  assert.equal(r.reach_none_count, 1);
});

test('窓内 0 便 → 全フィールドが 0 (null ではなく)', () => {
  const arrivals = { flights: [] };
  const r = summarizeArrivalsWindow(arrivals, NOW);
  assert.equal(r.flight_count, 0);
  assert.equal(r.estimated_pax_sum, 0);
  assert.equal(r.estimated_taxi_pax_sum, 0);
  assert.equal(r.reach_none_count, 0);
  // from / to も返ること
  assert.ok(r.from);
  assert.ok(r.to);
});
