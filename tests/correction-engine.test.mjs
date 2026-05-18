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

test('applyLevelCorrection: lead30 factor 1.5 → 小数乗算・total 再計算 (丸めない)', () => {
  const fc = makeForecast([[2, 1, 3, 0]]); // slot0 = lead 5min → lead30
  const corrections = { level: { lead30: { factor: 1.5 }, lead60: { factor: 1.0 }, lead120: { factor: 1.0 } } };
  const r = applyLevelCorrection(fc, corrections);
  // 早すぎる四捨五入を行わない。整数化は書き出し時の applyThroughputScale で1回だけ。
  assert.equal(r.slots[0].stall1, 3);   // 2 * 1.5
  assert.equal(r.slots[0].stall3, 4.5); // 3 * 1.5 — round で 5 に潰してはいけない
  assert.equal(r.slots[0].total, 3 + 1.5 + 4.5 + 0); // 9
});

test('applyLevelCorrection: 小数の forecast 値を factor 1.0 で 0 に潰さない (早すぎる四捨五入バグ回帰)', () => {
  // computeForecast は小数を出す。factor=1.0 (学習20件未満のブートストラップ既定) で
  // round すると 0.333 → 0 に潰れ stall-ensemble.json がほぼ0になる。丸めてはいけない。
  const fc = makeForecast([[1 / 3, 0, 0, 0]]);
  const corrections = { level: { lead30: { factor: 1.0 }, lead60: { factor: 1.0 }, lead120: { factor: 1.0 } } };
  const r = applyLevelCorrection(fc, corrections);
  assert.equal(r.slots[0].stall1, 1 / 3);
  assert.equal(r.slots[0].total, 1 / 3);
});

test('applyLevelCorrection: 入力 forecast を破壊しない', () => {
  const fc = makeForecast([[2, 1, 0, 0]]);
  const corrections = { level: { lead30: { factor: 2.0 }, lead60: { factor: 1.0 }, lead120: { factor: 1.0 } } };
  applyLevelCorrection(fc, corrections);
  assert.equal(fc.slots[0].stall1, 2); // 元は不変
});

// --- buildEffectiveTransitShare (端末別 / Phase D-4) ---

function makeTransitShare() {
  return {
    buckets: [
      { id: 'noon', fromHHMM: '12:00', toHHMM: '15:00', rates: { T1: 0.040, T2: 0.040, T3: 0.040 } },
      { id: 'peak1', fromHHMM: '17:00', toHHMM: '19:00', rates: { T1: 0.060, T2: 0.060, T3: 0.055 } },
    ],
    maxRatio: 0.40,
    fallbackRate: 0.025,
  };
}

test('buildEffectiveTransitShare: corrections null → マスターと同値・別オブジェクト', () => {
  const master = makeTransitShare();
  const eff = buildEffectiveTransitShare(master, null);
  assert.equal(eff.buckets[0].rates.T1, 0.040);
  assert.equal(eff.maxRatio, 0.40);
  assert.notEqual(eff, master);
});

test('buildEffectiveTransitShare: v2 端末別 → rates が端末別に乗算・マスター非破壊', () => {
  const master = makeTransitShare();
  const corrections = {
    schemaVersion: 2,
    share: {
      noon: {
        T1: { factor: 2.0, source: 'learning' },
        T2: { factor: 0.5, source: 'learning' },
        T3: { factor: 1.0, source: 'unobservable' },
      },
    },
  };
  const eff = buildEffectiveTransitShare(master, corrections);
  assert.equal(eff.buckets[0].rates.T1, 0.080); // 0.040 * 2.0
  assert.equal(eff.buckets[0].rates.T2, 0.020); // 0.040 * 0.5
  assert.equal(eff.buckets[0].rates.T3, 0.040); // 0.040 * 1.0
  assert.equal(eff.buckets[1].rates.T1, 0.060); // peak1 は補正なし
  assert.equal(eff.maxRatio, 0.40);
  assert.equal(master.buckets[0].rates.T1, 0.040); // マスター不変
});

test('buildEffectiveTransitShare: 旧 v1 一律形状 → 全端末に同じ factor を適用', () => {
  const master = makeTransitShare();
  const corrections = { schemaVersion: 1, share: { noon: { factor: 2.0, source: 'learning' } } };
  const eff = buildEffectiveTransitShare(master, corrections);
  assert.equal(eff.buckets[0].rates.T1, 0.080); // 0.040 * 2.0
  assert.equal(eff.buckets[0].rates.T2, 0.080);
  assert.equal(eff.buckets[0].rates.T3, 0.080);
});

test('buildEffectiveTransitShare: factor 未定義端末 → 1.0 (補正なし)', () => {
  const master = makeTransitShare();
  // noon に T1 のみ補正、T2/T3 エントリなし
  const corrections = { schemaVersion: 2, share: { noon: { T1: { factor: 1.5 } } } };
  const eff = buildEffectiveTransitShare(master, corrections);
  assert.equal(eff.buckets[0].rates.T1, 0.060); // 0.040 * 1.5
  assert.equal(eff.buckets[0].rates.T2, 0.040); // 補正なし
  assert.equal(eff.buckets[0].rates.T3, 0.040);
});

// --- computeLevelCorrection ---

import { computeLevelCorrection } from '../scripts/lib/correction-engine.mjs';

// 発行時刻 issueH:issueM (JST) から leadMin 分後の予測 slot を作る。
function predSlotJst(issueH, issueM, leadMin, s1, s2, s3, s4) {
  const total = issueH * 60 + issueM + leadMin;
  const hh = String(Math.floor(total / 60) % 24).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return { slotStart: `${hh}:${mm}`, stall1: s1, stall2: s2, stall3: s3, stall4: s4, total: s1 + s2 + s3 + s4 };
}
function logEntry(ts, fcSlots) {
  return { ts, tickSeq: 1, forecast: fcSlots, patternMatch: [] };
}
// actualMap キー: "YYYY-MM-DD#slotIdx"
function actualKey(dateStr, hh, mm) {
  return `${dateStr}#${hh * 12 + Math.floor(mm / 5)}`;
}
const NOW = new Date('2026-06-01T13:00:00+09:00');

test('computeLevelCorrection: logEntries 0 件 → 全バケット fallback', () => {
  const r = computeLevelCorrection([], new Map(), NOW);
  assert.equal(r.lead30.source, 'fallback');
  assert.equal(r.lead30.factor, 1.0);
  assert.equal(r.lead30.n, 0);
  assert.equal(r.lead120.source, 'fallback');
});

test('computeLevelCorrection: 予測 = 実測 → factor 1.0', () => {
  // 12:00 発行、30 分後 (12:30) に total 4 を予測、実測も 4。MIN_SAMPLE 達成のため 25 件。
  const entries = [];
  for (let i = 0; i < 25; i++) {
    entries.push(logEntry('2026-06-01T12:00:00+09:00', [predSlotJst(12, 0, 30, 1, 1, 1, 1)]));
  }
  const actualMap = new Map([[actualKey('2026-06-01', 12, 30), [1, 1, 1, 1]]]);
  const r = computeLevelCorrection(entries, actualMap, NOW);
  assert.equal(r.lead30.factor, 1.0);
  assert.equal(r.lead30.source, 'learning');
  assert.equal(r.lead30.n, 25);
});

test('computeLevelCorrection: 予測過小 (実測 > 予測) → factor > 1', () => {
  const entries = [];
  for (let i = 0; i < 25; i++) {
    entries.push(logEntry('2026-06-01T12:00:00+09:00', [predSlotJst(12, 0, 30, 1, 0, 0, 0)]));
  }
  const actualMap = new Map([[actualKey('2026-06-01', 12, 30), [2, 0, 0, 0]]]);
  const r = computeLevelCorrection(entries, actualMap, NOW);
  assert.equal(r.lead30.factor, 2.0); // 実測50 / 予測25
  assert.equal(r.lead30.source, 'learning');
});

test('computeLevelCorrection: ペア数 < MIN_SAMPLE → fallback', () => {
  const entries = [logEntry('2026-06-01T12:00:00+09:00', [predSlotJst(12, 0, 30, 1, 0, 0, 0)])];
  const actualMap = new Map([[actualKey('2026-06-01', 12, 30), [3, 0, 0, 0]]]);
  const r = computeLevelCorrection(entries, actualMap, NOW);
  assert.equal(r.lead30.source, 'fallback');
  assert.equal(r.lead30.factor, 1.0);
  assert.equal(r.lead30.n, 1);
});

test('computeLevelCorrection: 実測過小 → factor は下限 0.5 でクリップ', () => {
  const entries = [];
  for (let i = 0; i < 25; i++) {
    entries.push(logEntry('2026-06-01T12:00:00+09:00', [predSlotJst(12, 0, 30, 10, 0, 0, 0)]));
  }
  const actualMap = new Map([[actualKey('2026-06-01', 12, 30), [1, 0, 0, 0]]]);
  const r = computeLevelCorrection(entries, actualMap, NOW);
  assert.equal(r.lead30.factor, 0.5); // 実測25/予測250 = 0.1 → クリップ 0.5
});

// --- computeShareCorrection (端末別 / Phase D-4) ---

import { computeShareCorrection } from '../scripts/lib/correction-engine.mjs';

// transit-share フィクスチャ (noon バケットのみ使用)
const SHARE_TS = {
  buckets: [
    { id: 'noon', fromHHMM: '12:00', toHHMM: '15:00', rates: { T1: 0.035, T2: 0.035, T3: 0.040 } },
  ],
};
// 1 便: estimatedTaxiPax + terminal、lobbyExitTime 13:00 (noon バケット)
function flight(fn, taxiPax, terminal) {
  return { flightNumber: fn, estimatedTaxiPax: taxiPax, lobbyExitTime: '13:00', terminal };
}
function snapshotRow(ts, flights) {
  return { ts, tick_seq: 1, flights };
}
// actualMap: noon バケット (slotIdx 144-179) に stall 別 outflow を置く
function noonActualMap(dateStr, s1, s2, s3, s4) {
  const m = new Map();
  for (let idx = 144; idx < 180; idx++) {
    m.set(`${dateStr}#${idx}`, [s1, s2, s3, s4]);
  }
  return m;
}
const SHARE_NOW = new Date('2026-06-03T10:00:00+09:00');

test('computeShareCorrection: snapshotRows 0 件 → T1/T2 fallback・T3 unobservable', () => {
  const r = computeShareCorrection([], new Map(), SHARE_TS, SHARE_NOW);
  assert.equal(r.noon.T1.source, 'fallback');
  assert.equal(r.noon.T1.factor, 1.0);
  assert.equal(r.noon.T2.source, 'fallback');
  assert.equal(r.noon.T3.source, 'unobservable');
  assert.equal(r.noon.T3.factor, 1.0);
});

test('computeShareCorrection: T1 便 × stall1+2 outflow → T1 factor 算出', () => {
  // 6/2 完了日: T1 便 25 × estimatedTaxiPax 4 = Σ推定 100。
  // stall1=3 + stall2=2 = 5/slot × 36 slot = Σ実測 180。T1 factor = 1.8。
  const flights = [];
  for (let i = 0; i < 25; i++) flights.push(flight(`T1F${i}`, 4, 'T1'));
  const rows = [snapshotRow('2026-06-02T13:00:00+09:00', flights)];
  const actualMap = noonActualMap('2026-06-02', 3, 2, 0, 0);
  const r = computeShareCorrection(rows, actualMap, SHARE_TS, SHARE_NOW);
  assert.equal(r.noon.T1.factor, 1.8);
  assert.equal(r.noon.T1.source, 'learning');
  assert.equal(r.noon.T1.flightCount, 25);
  // T2 便なし → T2 fallback
  assert.equal(r.noon.T2.source, 'fallback');
});

test('computeShareCorrection: T2 便 × stall3+4 outflow → T2 factor 算出', () => {
  // T2 便 25 × 4 = Σ推定 100。stall3=4 + stall4=1 = 5/slot × 36 = 180。T2 factor 1.8。
  const flights = [];
  for (let i = 0; i < 25; i++) flights.push(flight(`T2F${i}`, 4, 'T2'));
  const rows = [snapshotRow('2026-06-02T13:00:00+09:00', flights)];
  const actualMap = noonActualMap('2026-06-02', 0, 0, 4, 1);
  const r = computeShareCorrection(rows, actualMap, SHARE_TS, SHARE_NOW);
  assert.equal(r.noon.T2.factor, 1.8);
  assert.equal(r.noon.T2.source, 'learning');
});

test('computeShareCorrection: T1/T2 混在 → 端末別に独立算出', () => {
  // T1: 25 便 × 4 = 100、stall1+2 = 2/slot × 36 = 72 → factor 0.72。
  // T2: 25 便 × 4 = 100、stall3+4 = 6/slot × 36 = 216 → factor 2.16。
  const flights = [];
  for (let i = 0; i < 25; i++) flights.push(flight(`T1F${i}`, 4, 'T1'));
  for (let i = 0; i < 25; i++) flights.push(flight(`T2F${i}`, 4, 'T2'));
  const rows = [snapshotRow('2026-06-02T13:00:00+09:00', flights)];
  const actualMap = noonActualMap('2026-06-02', 1, 1, 3, 3);
  const r = computeShareCorrection(rows, actualMap, SHARE_TS, SHARE_NOW);
  assert.equal(r.noon.T1.factor, 0.72);
  assert.equal(r.noon.T2.factor, 2.16);
});

test('computeShareCorrection: T3 便は集計除外・常に unobservable', () => {
  const flights = [];
  for (let i = 0; i < 25; i++) flights.push(flight(`T3F${i}`, 4, 'T3'));
  const rows = [snapshotRow('2026-06-02T13:00:00+09:00', flights)];
  const r = computeShareCorrection(rows, noonActualMap('2026-06-02', 3, 2, 0, 0), SHARE_TS, SHARE_NOW);
  assert.equal(r.noon.T3.source, 'unobservable');
  assert.equal(r.noon.T3.factor, 1.0);
  // T3 便は T1/T2 に数えない
  assert.equal(r.noon.T1.flightCount, 0);
  assert.equal(r.noon.T2.flightCount, 0);
});

test('computeShareCorrection: 端末別の便数不足 → 当該端末のみ fallback', () => {
  // T1 便 2 のみ (< 20) → T1 fallback。T2 便 25 → T2 learning。
  const flights = [flight('T1a', 4, 'T1'), flight('T1b', 4, 'T1')];
  for (let i = 0; i < 25; i++) flights.push(flight(`T2F${i}`, 4, 'T2'));
  const rows = [snapshotRow('2026-06-02T13:00:00+09:00', flights)];
  const r = computeShareCorrection(rows, noonActualMap('2026-06-02', 1, 1, 3, 3), SHARE_TS, SHARE_NOW);
  assert.equal(r.noon.T1.source, 'fallback');
  assert.equal(r.noon.T1.flightCount, 2);
  assert.equal(r.noon.T2.source, 'learning');
});

test('computeShareCorrection: 当日のデータは無視 (完了日のみ)', () => {
  // SHARE_NOW = 6/3。6/3 のスナップショットは未完了日。
  const flights = [];
  for (let i = 0; i < 25; i++) flights.push(flight(`T1F${i}`, 4, 'T1'));
  const rows = [snapshotRow('2026-06-03T13:00:00+09:00', flights)];
  const r = computeShareCorrection(rows, noonActualMap('2026-06-03', 3, 2, 0, 0), SHARE_TS, SHARE_NOW);
  assert.equal(r.noon.T1.source, 'fallback');
});

// --- computeT3DirectionalCorrection (Phase E-2) ---

import { computeT3DirectionalCorrection } from '../scripts/lib/correction-engine.mjs';

// transit-share フィクスチャ (noon/peak1/evening バケット)
const T3_TS = {
  buckets: [
    { id: 'noon', fromHHMM: '12:00', toHHMM: '15:00', rates: { T1: 0.035, T2: 0.035, T3: 0.040 } },
    { id: 'peak1', fromHHMM: '17:00', toHHMM: '19:00', rates: { T1: 0.060, T2: 0.060, T3: 0.055 } },
    { id: 'evening', fromHHMM: '19:00', toHHMM: '21:30', rates: { T1: 0.035, T2: 0.035, T3: 0.045 } },
  ],
};
const T3_NOW = new Date('2026-06-03T10:00:00+09:00');

// hhmm (例 '13:00') の完了日 (6/2) tick を n 件、Real106 black_ratio=br で作る
function t3Rows(hhmm, n, br) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      ts: `2026-06-02T${hhmm}:00+09:00`,
      t3_stand: [{ name: 'Real106', black_ratio: br }, { name: 'Real107', black_ratio: 0.1 }],
      pool: [],
    });
  }
  return rows;
}

test('computeT3DirectionalCorrection: 0 件 → 全バケット fallback', () => {
  const r = computeT3DirectionalCorrection([], T3_TS, T3_NOW);
  assert.equal(r.noon.source, 'fallback');
  assert.equal(r.noon.factor, 1.0);
  assert.equal(r.peak1.source, 'fallback');
});

test('computeT3DirectionalCorrection: 当日データのみ → fallback (完了日なし)', () => {
  const rows = [];
  for (let i = 0; i < 30; i++) {
    rows.push({ ts: '2026-06-03T13:00:00+09:00', t3_stand: [{ name: 'Real106', black_ratio: 0.1 }], pool: [] });
  }
  const r = computeT3DirectionalCorrection(rows, T3_TS, T3_NOW);
  assert.equal(r.noon.source, 'fallback');
});

test('computeT3DirectionalCorrection: 全バケット均一活性 → factor ≈ 1.0', () => {
  const rows = [...t3Rows('13:00', 25, 0.1), ...t3Rows('18:00', 25, 0.1)];
  const r = computeT3DirectionalCorrection(rows, T3_TS, T3_NOW);
  assert.equal(r.noon.factor, 1.0);
  assert.equal(r.noon.source, 'directional');
  assert.equal(r.peak1.factor, 1.0);
});

test('computeT3DirectionalCorrection: 相対的に活性高→factor<1、低→factor>1', () => {
  // noon black_ratio 0.2、peak1 0.1。overall=0.15。
  // noon relative=1.333 → factor=1-0.2*0.333=0.9333。peak1 relative=0.667 → factor=1.0667。
  const rows = [...t3Rows('13:00', 25, 0.2), ...t3Rows('18:00', 25, 0.1)];
  const r = computeT3DirectionalCorrection(rows, T3_TS, T3_NOW);
  assert.ok(r.noon.factor < 1.0, `noon factor ${r.noon.factor} < 1`);
  assert.ok(r.peak1.factor > 1.0, `peak1 factor ${r.peak1.factor} > 1`);
  assert.equal(r.noon.source, 'directional');
});

test('computeT3DirectionalCorrection: tick 数 < T3_MIN_TICKS → そのバケット fallback', () => {
  const rows = [...t3Rows('13:00', 5, 0.2), ...t3Rows('18:00', 25, 0.1)];
  const r = computeT3DirectionalCorrection(rows, T3_TS, T3_NOW);
  assert.equal(r.noon.source, 'fallback'); // 5 件 < 20
  assert.equal(r.noon.factor, 1.0);
  assert.equal(r.peak1.source, 'directional');
});

test('computeT3DirectionalCorrection: factor は bound [0.8, 1.2] でクリップ', () => {
  // noon 0.9、peak1 0.0、evening 0.0。overall=0.3。noon relative=3.0 → 素 factor=0.6 → クリップ 0.8。
  const rows = [...t3Rows('13:00', 25, 0.9), ...t3Rows('18:00', 25, 0.0), ...t3Rows('20:00', 25, 0.0)];
  const r = computeT3DirectionalCorrection(rows, T3_TS, T3_NOW);
  assert.equal(r.noon.factor, 0.8);
  assert.equal(r.peak1.factor, 1.2);
  assert.equal(r.evening.factor, 1.2);
});
