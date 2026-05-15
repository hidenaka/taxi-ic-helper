import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { buildActualMap, slotKeyOf } from '../scripts/lib/accuracy-evaluator.mjs';

function makeRow(ts, lum, s1d, s2d, s3d, s4d) {
  return {
    schema_version: 3,
    ts,
    img1: { roi: { luminance_mean: lum } },
    stalls: {
      stall1: { diff_occupied_from_prev: s1d },
      stall2: { diff_occupied_from_prev: s2d },
      stall3: { diff_occupied_from_prev: s3d },
      stall4: { diff_occupied_from_prev: s4d },
    },
  };
}

test('slotKeyOf: 日付 + slotIdx の合成キー', () => {
  assert.equal(slotKeyOf('2026-06-01', 210), '2026-06-01#210');
});

test('buildActualMap: 信頼サブセットの出庫を date#slotIdx で引ける', () => {
  const history = [
    makeRow('2026-06-01T12:00:00+09:00', 100, -2, 0, -1, 0),
    makeRow('2026-06-01T12:05:00+09:00', 100, 0, -3, 0, 0),
  ];
  const m = buildActualMap(history);
  assert.deepEqual(m.get('2026-06-01#144'), [2, 0, 1, 0]);
  assert.deepEqual(m.get('2026-06-01#145'), [0, 3, 0, 0]);
});

test('buildActualMap: 夜間 (luminance<30) は除外', () => {
  const history = [
    makeRow('2026-06-01T03:00:00+09:00', 10, -5, 0, 0, 0),
  ];
  const m = buildActualMap(history);
  assert.equal(m.has('2026-06-01#36'), false);
});

// --- evaluateAccuracy ---

import { evaluateAccuracy } from '../scripts/lib/accuracy-evaluator.mjs';

function makeLogEntry(ts, tickSeq, fcSlots, pmSlots) {
  return { ts, tickSeq, forecast: fcSlots, patternMatch: pmSlots };
}
// 発行時刻 (issueH:issueM JST) から leadMin 分後の slot を作る。
function slotAtJst(issueH, issueM, leadMin, s1, s2, s3, s4) {
  const total = issueH * 60 + issueM + leadMin;
  const hh = String(Math.floor(total / 60) % 24).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return { slotStart: `${hh}:${mm}`, stall1: s1, stall2: s2, stall3: s3, stall4: s4, total: s1 + s2 + s3 + s4 };
}
// 発行 ts は JST 文字列を直接渡す (12:00 JST → slotIdx 144)
const ISSUE_TS = '2026-06-01T12:00:00+09:00';
const NOW_TS = new Date('2026-06-01T13:00:00+09:00');

test('evaluateAccuracy: logEntries 0 件 → 全バケット n=0', () => {
  const r = evaluateAccuracy([], new Map(), new Date('2026-06-01T19:00:00+09:00'));
  assert.equal(r.recent24h.forecast.lead30.n, 0);
  assert.equal(r.recent24h.forecast.lead30.mae_total, null);
  assert.equal(r.allPeriod.patternMatch.lead60.n, 0);
});

test('evaluateAccuracy: 予測 = 実測 → MAE 0', () => {
  // 12:00 発行、30 分後 = 12:30 = slotIdx 150
  const fcSlot = slotAtJst(12, 0, 30, 1, 1, 1, 1);
  const log = [makeLogEntry(ISSUE_TS, 1, [fcSlot], [])];
  const actual = new Map([['2026-06-01#150', [1, 1, 1, 1]]]);
  const r = evaluateAccuracy(log, actual, NOW_TS);
  assert.equal(r.allPeriod.forecast.lead30.mae_total, 0);
  assert.equal(r.allPeriod.forecast.lead30.n, 1);
});

test('evaluateAccuracy: 予測ズレ → MAE が絶対誤差', () => {
  const fcSlot = slotAtJst(12, 0, 30, 3, 0, 0, 0);
  const log = [makeLogEntry(ISSUE_TS, 1, [fcSlot], [])];
  const actual = new Map([['2026-06-01#150', [1, 0, 0, 0]]]);
  const r = evaluateAccuracy(log, actual, NOW_TS);
  assert.equal(r.allPeriod.forecast.lead30.mae_total, 2);
});

test('evaluateAccuracy: 実測なし slot はスキップ (n に数えない)', () => {
  const fcSlot = slotAtJst(12, 0, 30, 1, 1, 1, 1);
  const log = [makeLogEntry(ISSUE_TS, 1, [fcSlot], [])];
  const r = evaluateAccuracy(log, new Map(), NOW_TS);
  assert.equal(r.allPeriod.forecast.lead30.n, 0);
});

test('evaluateAccuracy: winner 判定 (forecast の MAE 小 → "forecast")', () => {
  const fcSlot = slotAtJst(12, 0, 30, 1, 0, 0, 0);
  const pmSlot = slotAtJst(12, 0, 30, 5, 0, 0, 0);
  const log = [makeLogEntry(ISSUE_TS, 1, [fcSlot], [pmSlot])];
  const actual = new Map([['2026-06-01#150', [1, 0, 0, 0]]]);
  const r = evaluateAccuracy(log, actual, NOW_TS);
  assert.equal(r.allPeriod.winner.lead30, 'forecast');
});
