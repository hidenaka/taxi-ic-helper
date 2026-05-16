import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import {
  clipFactor, applyLevelCorrection, buildEffectiveTransitShare,
} from '../scripts/lib/correction-engine.mjs';

// --- clipFactor ---

test('clipFactor: 範囲内はそのまま', () => {
  assert.equal(clipFactor(1.5, 0.5, 2.0), 1.5);
});

test('clipFactor: 範囲外はクリップ', () => {
  assert.equal(clipFactor(5, 0.5, 2.0), 2.0);
  assert.equal(clipFactor(0.1, 0.5, 2.0), 0.5);
});

test('clipFactor: NaN/非数は 1.0', () => {
  assert.equal(clipFactor(NaN, 0.5, 2.0), 1.0);
  assert.equal(clipFactor('x', 0.5, 2.0), 1.0);
});

// --- applyLevelCorrection ---

function makeForecast(stallsPerSlot) {
  // stallsPerSlot: [[s1,s2,s3,s4], ...] 24 slot 想定だが任意長で可
  return {
    schemaVersion: 1,
    trendFactor: 1.0,
    slots: stallsPerSlot.map((v, i) => ({
      slotStart: `${String(8 + Math.floor((i + 1) / 12)).padStart(2, '0')}:${String(((i + 1) % 12) * 5).padStart(2, '0')}`,
      flightFactor: 1.0,
      stall1: v[0], stall2: v[1], stall3: v[2], stall4: v[3],
      total: v[0] + v[1] + v[2] + v[3],
    })),
  };
}

test('applyLevelCorrection: corrections null → forecast そのまま', () => {
  const fc = makeForecast([[2, 1, 0, 0]]);
  const r = applyLevelCorrection(fc, null);
  assert.equal(r.slots[0].stall1, 2);
  assert.equal(r.slots[0].total, 3);
});

test('applyLevelCorrection: factor 1.0 → 値不変・他キー保持', () => {
  const fc = makeForecast([[2, 1, 0, 0]]);
  const corrections = { level: { lead30: { factor: 1.0 }, lead60: { factor: 1.0 }, lead120: { factor: 1.0 } } };
  const r = applyLevelCorrection(fc, corrections);
  assert.equal(r.slots[0].stall1, 2);
  assert.equal(r.slots[0].flightFactor, 1.0);
  assert.equal(r.trendFactor, 1.0);
});

test('applyLevelCorrection: lead30 factor 1.5 → round 乗算・total 再計算', () => {
  const fc = makeForecast([[2, 1, 3, 0]]); // slot0 = lead 5min → lead30
  const corrections = { level: { lead30: { factor: 1.5 }, lead60: { factor: 1.0 }, lead120: { factor: 1.0 } } };
  const r = applyLevelCorrection(fc, corrections);
  assert.equal(r.slots[0].stall1, 3); // round(2*1.5)
  assert.equal(r.slots[0].stall3, 5); // round(3*1.5=4.5)
  assert.equal(r.slots[0].total, 3 + 2 + 5 + 0);
});

test('applyLevelCorrection: 入力 forecast を破壊しない', () => {
  const fc = makeForecast([[2, 1, 0, 0]]);
  const corrections = { level: { lead30: { factor: 2.0 }, lead60: { factor: 1.0 }, lead120: { factor: 1.0 } } };
  applyLevelCorrection(fc, corrections);
  assert.equal(fc.slots[0].stall1, 2); // 元は不変
});

// --- buildEffectiveTransitShare ---

function makeTransitShare() {
  return {
    buckets: [
      { id: 'noon', fromHHMM: '12:00', toHHMM: '15:00', rates: { T1: 0.035, T2: 0.035, T3: 0.040 } },
      { id: 'peak1', fromHHMM: '17:00', toHHMM: '19:00', rates: { T1: 0.060, T2: 0.060, T3: 0.055 } },
    ],
    maxRatio: 0.40,
    fallbackRate: 0.025,
  };
}

test('buildEffectiveTransitShare: corrections null → マスターと同値・別オブジェクト', () => {
  const master = makeTransitShare();
  const eff = buildEffectiveTransitShare(master, null);
  assert.equal(eff.buckets[0].rates.T1, 0.035);
  assert.equal(eff.maxRatio, 0.40);
  assert.notEqual(eff, master);
});

test('buildEffectiveTransitShare: factor 適用 → rates 乗算・maxRatio 不変・マスター非破壊', () => {
  const master = makeTransitShare();
  const corrections = { share: { noon: { factor: 2.0 }, peak1: { factor: 1.0 } } };
  const eff = buildEffectiveTransitShare(master, corrections);
  assert.equal(eff.buckets[0].rates.T1, 0.070); // 0.035 * 2.0
  assert.equal(eff.buckets[0].rates.T3, 0.080); // 0.040 * 2.0
  assert.equal(eff.buckets[1].rates.T1, 0.060); // peak1 factor 1.0
  assert.equal(eff.maxRatio, 0.40);
  assert.equal(master.buckets[0].rates.T1, 0.035); // マスター不変
});
