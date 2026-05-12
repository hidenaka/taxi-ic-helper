import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { calibrate } from '../scripts/calibrate-transit-share.mjs';

const TRANSIT_SHARE = {
  _meta: { source: 'test' },
  buckets: [
    { id: 'early', fromHHMM: '07:00', toHHMM: '09:00', rates: { T1: 0.08, T2: 0.08, T3: 0.10 } },
    { id: 'morning', fromHHMM: '09:00', toHHMM: '12:00', rates: { T1: 0.11, T2: 0.11, T3: 0.12 } },
    { id: 'noon', fromHHMM: '12:00', toHHMM: '15:00', rates: { T1: 0.14, T2: 0.14, T3: 0.16 } },
    { id: 'afternoon', fromHHMM: '15:00', toHHMM: '17:00', rates: { T1: 0.18, T2: 0.18, T3: 0.20 } },
    { id: 'peak1', fromHHMM: '17:00', toHHMM: '19:00', rates: { T1: 0.24, T2: 0.24, T3: 0.22 } },
    { id: 'evening', fromHHMM: '19:00', toHHMM: '21:30', rates: { T1: 0.14, T2: 0.14, T3: 0.18 } },
    { id: 'peak2', fromHHMM: '21:30', toHHMM: '24:00', rates: { T1: 0.32, T2: 0.32, T3: 0.32 } },
    { id: 'midnight', fromHHMM: '24:00', toHHMM: '27:00', rates: { T1: 0.30, T2: 0.30, T3: 0.30 } }
  ]
};

// 60 tick / bucket / ターミナル分布あり (>50 でサンプル要件クリア)
function generateTicks() {
  const lines = [];
  for (let day = 0; day < 14; day++) {
    for (let h = 7; h < 22; h++) {
      for (let m = 0; m < 60; m++) {
        const dStr = `2026-05-${String(28 + day).padStart(2, '0')}`;
        const ts = `${dStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`;
        const departures = [];
        if (m % 2 === 0) departures.push({ lane: '第一', terminal: 'T1' });
        if (m % 3 === 0) departures.push({ lane: '第三', terminal: 'T2' });
        const taxi_pax_sum = 30 + Math.floor(Math.random() * 60);
        lines.push({
          schema_version: 3,
          ts,
          tick_seq: day * 900 + (h - 7) * 60 + m,
          departures,
          arrivals_window: { flight_count: 5, estimated_taxi_pax_sum: taxi_pax_sum }
        });
      }
    }
  }
  return lines;
}

const TICKS = generateTicks();

test('calibrate: T3 は変更されない', () => {
  const result = calibrate(TICKS, TRANSIT_SHARE, { alpha: 0.2 });
  for (const b of result.buckets) {
    const orig = TRANSIT_SHARE.buckets.find(x => x.id === b.id);
    assert.equal(b.rates.T3, orig.rates.T3);
  }
});

test('calibrate: morning bucket の rates が更新される', () => {
  const result = calibrate(TICKS, TRANSIT_SHARE, { alpha: 0.2 });
  const morning = result.buckets.find(b => b.id === 'morning');
  const origMorning = TRANSIT_SHARE.buckets.find(b => b.id === 'morning');
  const changed = morning.rates.T1 !== origMorning.rates.T1 || morning.rates.T2 !== origMorning.rates.T2;
  assert.ok(changed, `morning.rates should change: T1 ${origMorning.rates.T1}→${morning.rates.T1}, T2 ${origMorning.rates.T2}→${morning.rates.T2}`);
});

test('calibrate: _meta.calibratedAt が追加される', () => {
  const result = calibrate(TICKS, TRANSIT_SHARE, { alpha: 0.2 });
  assert.ok(result._meta.calibratedAt);
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(result._meta.calibratedAt));
  assert.equal(result._meta.calibrationSampleDays, 14);
});

test('calibrate: schema v3 でない tick は無視', () => {
  const mixed = [
    { schema_version: 2, ts: '2026-05-28T10:00:00+09:00', departures: [{ lane: '第一', terminal: 'T1' }] },
    ...TICKS
  ];
  const r1 = calibrate(TICKS, TRANSIT_SHARE, { alpha: 0.2 });
  const r2 = calibrate(mixed, TRANSIT_SHARE, { alpha: 0.2 });
  // v2 tick を加えても出力は同じ (v2 は無視される)
  assert.deepEqual(r1.buckets.find(b => b.id === 'morning').rates, r2.buckets.find(b => b.id === 'morning').rates);
});

test('calibrate: サンプル不足の bucket は previous を維持', () => {
  const fewTicks = [
    { schema_version: 3, ts: '2026-05-28T10:00:00+09:00', departures: [{ lane: '第一', terminal: 'T1' }], arrivals_window: { estimated_taxi_pax_sum: 30 } }
  ];
  const result = calibrate(fewTicks, TRANSIT_SHARE, { alpha: 0.2 });
  const morning = result.buckets.find(b => b.id === 'morning');
  const orig = TRANSIT_SHARE.buckets.find(b => b.id === 'morning');
  assert.equal(morning.rates.T1, orig.rates.T1);
  assert.equal(morning.rates.T2, orig.rates.T2);
});
