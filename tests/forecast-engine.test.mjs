import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import {
  slotKey, clip, computeBaseline, SLOTS_PER_DAY, flightDemand,
} from '../scripts/lib/forecast-engine.mjs';

test('slotKey: 17:30 → 17*12 + 6 = 210', () => {
  assert.equal(slotKey(17, 30), 210);
});

test('slotKey: 0:00 → 0、23:55 → 287', () => {
  assert.equal(slotKey(0, 0), 0);
  assert.equal(slotKey(23, 55), 287);
});

test('clip: 範囲内はそのまま、範囲外はクランプ、NaN は 1.0', () => {
  assert.equal(clip(0.5, 0.3, 3.0), 0.5);
  assert.equal(clip(0.1, 0.3, 3.0), 0.3);
  assert.equal(clip(5.0, 0.3, 3.0), 3.0);
  assert.equal(clip(NaN, 0.3, 3.0), 1.0);
  assert.equal(clip(Infinity, 0.3, 3.0), 1.0);
});

// --- computeBaseline ---

function makeRow(ts, lum, stall1Diff, stall2Diff, stall3Diff, stall4Diff) {
  return {
    schema_version: 3,
    ts,
    img1: { roi: { luminance_mean: lum } },
    stalls: {
      stall1: { diff_occupied_from_prev: stall1Diff, occupied_estimate: 5, capacity: 8 },
      stall2: { diff_occupied_from_prev: stall2Diff, occupied_estimate: 5, capacity: 7 },
      stall3: { diff_occupied_from_prev: stall3Diff, occupied_estimate: 5, capacity: 8 },
      stall4: { diff_occupied_from_prev: stall4Diff, occupied_estimate: 5, capacity: 8 },
    },
  };
}

test('computeBaseline: 信頼サブセット 0 行 → 全 slot null + sampleCount 0', () => {
  const r = computeBaseline([]);
  assert.equal(r.sampleCount, 0);
  assert.equal(r.slots.length, SLOTS_PER_DAY);
  for (const s of r.slots) {
    for (const stall of ['stall1', 'stall2', 'stall3', 'stall4']) {
      assert.equal(s[stall], null);
    }
  }
});

test('computeBaseline: 同 slot に複数サンプル → 平均が返る (-値だけ集計)', () => {
  const history = [
    makeRow('2026-05-13T12:00:00+09:00', 100, -2, 0, 0, 0),
    makeRow('2026-05-13T12:00:00+09:00', 100, -4, 0, 0, 0),
  ];
  const r = computeBaseline(history);
  const slot = r.slots[slotKey(12, 0)];
  assert.equal(slot.stall1, 3);
  assert.equal(slot.stall2, 0);
  assert.equal(r.sampleCount, 2);
});

test('computeBaseline: 夜間 (luminance<30) は除外', () => {
  const history = [
    makeRow('2026-05-13T03:00:00+09:00', 10, -5, 0, 0, 0),
    makeRow('2026-05-13T03:00:00+09:00', 100, -1, 0, 0, 0),
  ];
  const r = computeBaseline(history);
  const slot = r.slots[slotKey(3, 0)];
  assert.equal(slot.stall1, 1);
  assert.equal(r.sampleCount, 1);
});

test('computeBaseline: 正の diff (入庫) は出庫としてカウントしない', () => {
  const history = [
    makeRow('2026-05-13T12:00:00+09:00', 100, 3, 0, 0, 0),
    makeRow('2026-05-13T12:00:00+09:00', 100, -2, 0, 0, 0),
  ];
  const r = computeBaseline(history);
  const slot = r.slots[slotKey(12, 0)];
  assert.equal(slot.stall1, 1);
});

// --- computeForecast ---

import { computeForecast, FORECAST_SLOT_COUNT, FORECAST_SCHEMA_VERSION } from '../scripts/lib/forecast-engine.mjs';

function makeArrivals(flights) {
  return { flights };
}

test('computeForecast: baseline 全 0 → 全 slot 予測 0', () => {
  const baseline = {
    slots: Array.from({ length: 288 }, () => ({ stall1: 0, stall2: 0, stall3: 0, stall4: 0 })),
    sampleCount: 100,
  };
  const r = computeForecast(baseline, [], makeArrivals([]), new Date('2026-05-15T12:00:00+09:00'));
  assert.equal(r.slots.length, FORECAST_SLOT_COUNT);
  assert.equal(r.slots[0].total, 0);
  assert.equal(r.slots[0].stall1, 0);
});

test('computeForecast: baseline=1.0, trendFactor=1, flightFactor=1 → 予測 1', () => {
  const slots = Array.from({ length: 288 }, () => ({ stall1: 1.0, stall2: 0, stall3: 0, stall4: 0 }));
  const baseline = { slots, sampleCount: 100 };
  const recent = Array.from({ length: 12 }, (_, i) => {
    const min = i * 5;
    return {
      ts: new Date(2026, 4, 15, 11, min, 0).toISOString().replace('Z', '+09:00'),
      total_outflow: 1.0,
    };
  });
  const r = computeForecast(baseline, recent, makeArrivals([]), new Date('2026-05-15T12:00:00+09:00'));
  assert.equal(r.slots[0].stall1, 1);
  assert.equal(r.slots[0].total, 1);
});

test('computeForecast: trendFactor 計算 (直近実測が期待値の 2 倍)', () => {
  const slots = Array.from({ length: 288 }, () => ({ stall1: 1.0, stall2: 0, stall3: 0, stall4: 0 }));
  const baseline = { slots, sampleCount: 100 };
  const recent = Array.from({ length: 12 }, (_, i) => {
    return {
      ts: new Date(2026, 4, 15, 11, i * 5, 0).toISOString().replace('Z', '+09:00'),
      total_outflow: 2.0,
    };
  });
  const r = computeForecast(baseline, recent, makeArrivals([]), new Date('2026-05-15T12:00:00+09:00'));
  assert.equal(r.slots[0].stall1, 2);
  assert.equal(r.trendFactor, 2);
});

test('computeForecast: recent 不足 (12 行未満) → trendFactor=1.0', () => {
  const slots = Array.from({ length: 288 }, () => ({ stall1: 1.0, stall2: 0, stall3: 0, stall4: 0 }));
  const baseline = { slots, sampleCount: 100 };
  const r = computeForecast(baseline, [], makeArrivals([]), new Date('2026-05-15T12:00:00+09:00'));
  assert.equal(r.trendFactor, 1.0);
  assert.equal(r.slots[0].stall1, 1);
});

test('computeForecast: flightFactor 計算 (1 slot に大型便ピーク)', () => {
  const slots = Array.from({ length: 288 }, () => ({ stall1: 1.0, stall2: 0, stall3: 0, stall4: 0 }));
  const baseline = { slots, sampleCount: 100 };
  // 現在 12:00 → forecast slot 0 = 12:05 (slotKey(12,5)=144+1=145、しかし target = (slotKey(12,0)+1)%288 = 145)
  // lobbyExit 12:05 で slot 0 にヒット
  const arrivals = makeArrivals([
    { lobbyExitTime: '12:05', estimatedTaxiPax: 24 },
  ]);
  const r = computeForecast(baseline, [], arrivals, new Date('2026-05-15T12:00:00+09:00'));
  assert.equal(r.slots[0].flightFactor, 3.0);
  assert.equal(r.slots[0].stall1, 3);
});

test('computeForecast: 出力 JSON スキーマ - 必須フィールドが揃う', () => {
  const slots = Array.from({ length: 288 }, () => ({ stall1: 0.5, stall2: 0.5, stall3: 0.5, stall4: 0.5 }));
  const baseline = { slots, sampleCount: 500 };
  const r = computeForecast(baseline, [], makeArrivals([]), new Date('2026-05-15T17:30:00+09:00'));
  assert.equal(r.schemaVersion, FORECAST_SCHEMA_VERSION);
  assert.ok(r.generatedAt);
  assert.equal(typeof r.trendFactor, 'number');
  assert.equal(r.baselineSampleCount, 500);
  assert.equal(r.slots.length, FORECAST_SLOT_COUNT);
  const s = r.slots[0];
  assert.equal(s.slotStart, '17:35');
  assert.equal(s.slotEnd, '17:40');
  assert.equal(typeof s.flightFactor, 'number');
  assert.equal(typeof s.stall1, 'number');
  assert.equal(typeof s.total, 'number');
});

// --- computeForecast: trackTrend (Phase G-1) ---

// 11:00〜11:55 の 12 tick ぶんの recent を作る
function make12Recent(totalOutflow) {
  return Array.from({ length: 12 }, (_, i) => ({
    ts: new Date(2026, 4, 15, 11, i * 5, 0).toISOString().replace('Z', '+09:00'),
    total_outflow: totalOutflow,
  }));
}

test('computeForecast: trackTrend あり → track 経路で trendFactor = clip(actual/(k*expected))', () => {
  const slots = Array.from({ length: 288 }, () => ({ stall1: 1.0, stall2: 0, stall3: 0, stall4: 0 }));
  const baseline = { slots, sampleCount: 100 };
  const recent = make12Recent(99); // net-diff 値は track 経路では無視される
  // expected = 12 slot × 1.0 = 12、k=2、actual=12 → trendFactor = clip(12/(2*12)) = 0.5
  const trackTrend = { k: 2, actual: 12 };
  const r = computeForecast(baseline, recent, makeArrivals([]), new Date('2026-05-15T12:00:00+09:00'), trackTrend);
  assert.equal(r.trendFactor, 0.5);
  assert.equal(r.trendWindow.source, 'track');
  assert.equal(r.trendWindow.k, 2);
  assert.equal(r.trendWindow.actual, 12);
});

test('computeForecast: trackTrend null → net-diff 経路、source=netdiff, k=null', () => {
  const slots = Array.from({ length: 288 }, () => ({ stall1: 1.0, stall2: 0, stall3: 0, stall4: 0 }));
  const baseline = { slots, sampleCount: 100 };
  const recent = make12Recent(2);
  const r = computeForecast(baseline, recent, makeArrivals([]), new Date('2026-05-15T12:00:00+09:00'), null);
  assert.equal(r.trendFactor, 2); // net-diff: 24/12
  assert.equal(r.trendWindow.source, 'netdiff');
  assert.equal(r.trendWindow.k, null);
});

test('computeForecast: trackTrend あっても recent 12 未満 → net-diff 経路にフォールバック', () => {
  const slots = Array.from({ length: 288 }, () => ({ stall1: 1.0, stall2: 0, stall3: 0, stall4: 0 }));
  const baseline = { slots, sampleCount: 100 };
  const r = computeForecast(baseline, [], makeArrivals([]), new Date('2026-05-15T12:00:00+09:00'), { k: 2, actual: 12 });
  assert.equal(r.trendFactor, 1.0);
  assert.equal(r.trendWindow.source, 'netdiff');
});

test('computeForecast: trackTrend.k が 0 以下 → net-diff 経路にフォールバック', () => {
  const slots = Array.from({ length: 288 }, () => ({ stall1: 1.0, stall2: 0, stall3: 0, stall4: 0 }));
  const baseline = { slots, sampleCount: 100 };
  const recent = make12Recent(2);
  const r = computeForecast(baseline, recent, makeArrivals([]), new Date('2026-05-15T12:00:00+09:00'), { k: 0, actual: 12 });
  assert.equal(r.trendWindow.source, 'netdiff');
  assert.equal(r.trendFactor, 2);
});

test('computeForecast: 4 引数呼び出し (trackTrend 省略) は従来どおり動く', () => {
  const slots = Array.from({ length: 288 }, () => ({ stall1: 1.0, stall2: 0, stall3: 0, stall4: 0 }));
  const baseline = { slots, sampleCount: 100 };
  const recent = make12Recent(2);
  const r = computeForecast(baseline, recent, makeArrivals([]), new Date('2026-05-15T12:00:00+09:00'));
  assert.equal(r.trendFactor, 2);
  assert.equal(r.trendWindow.source, 'netdiff');
});

test('computeForecast: baseline 小数値を丸めず保持する (早すぎる四捨五入バグ回帰)', () => {
  // baseline stall1 = 0.3、recent なし → trendFactor=1.0、便なし → flightFactor=1.0
  // 予測値 = 0.3 * 1 * 1 = 0.3。Math.round で 0 に潰れてはいけない。
  const slots = Array.from({ length: 288 }, () => ({ stall1: 0.3, stall2: 0, stall3: 0, stall4: 0 }));
  const baseline = { slots, sampleCount: 100 };
  const r = computeForecast(baseline, [], makeArrivals([]), new Date('2026-05-15T12:00:00+09:00'));
  assert.equal(r.slots[0].stall1, 0.3);
  assert.equal(r.slots[0].total, 0.3);
});

test('flightDemand: 将来スロット別の便需要と直近窓の便需要を返す', () => {
  // now=12:00 → nowSlot=slotKey(12,0)=144。将来スロット0 = slot145 = 12:05。
  // 直近窓 = nowSlot-11..nowSlot = slot133..144 = 11:05..12:00。
  const arrivals = { flights: [
    { lobbyExitTime: '12:05', estimatedTaxiPax: 30 }, // 将来 slot0
    { lobbyExitTime: '12:10', estimatedTaxiPax: 12 }, // 将来 slot1
    { lobbyExitTime: '11:30', estimatedTaxiPax: 20 }, // 直近窓内
    { lobbyExitTime: '11:35', estimatedTaxiPax: 8 },  // 直近窓内
    { lobbyExitTime: '09:00', estimatedTaxiPax: 99 }, // 窓外 → 無視
  ] };
  const r = flightDemand(arrivals, slotKey(12, 0));
  assert.equal(r.futureSums.length, 24);
  assert.equal(r.futureSums[0], 30);
  assert.equal(r.futureSums[1], 12);
  assert.equal(r.recentSum, 28); // 20 + 8
});

test('flightDemand: arrivals が null → 全0', () => {
  const r = flightDemand(null, slotKey(12, 0));
  assert.equal(r.futureSums.length, 24);
  assert.equal(r.futureSums.every(v => v === 0), true);
  assert.equal(r.recentSum, 0);
});
