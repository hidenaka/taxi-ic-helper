import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { buildLogEntry } from '../scripts/lib/forecast-logger.mjs';

function makeForecast(slots) {
  // slots: [[s1,s2,s3,s4], ...]
  return {
    slots: slots.map((v, i) => ({
      slotStart: `${String(8 + Math.floor(i / 12)).padStart(2, '0')}:${String((i % 12) * 5).padStart(2, '0')}`,
      slotEnd: '',
      stall1: v[0], stall2: v[1], stall3: v[2], stall4: v[3],
      total: v[0] + v[1] + v[2] + v[3],
    })),
  };
}

test('buildLogEntry: forecast / patternMatch 両方空 slot → null (記録しない)', () => {
  const r = buildLogEntry({ slots: [] }, { historicalCurve: [] }, 100, '2026-06-01T17:00:00+09:00');
  assert.equal(r, null);
});

test('buildLogEntry: 正常な forecast/patternMatch → ts/tickSeq/forecast/patternMatch を持つ行', () => {
  const fc = makeForecast([[1, 0, 2, 1], [0, 1, 0, 0]]);
  const pm = { historicalCurve: [
    { slotStart: '08:00', stall1: 2, stall2: 0, stall3: 1, stall4: 1, total: 4 },
    { slotStart: '08:05', stall1: 0, stall2: 0, stall3: 1, stall4: 0, total: 1 },
  ] };
  const r = buildLogEntry(fc, pm, 100, '2026-06-01T17:00:00+09:00');
  assert.equal(r.ts, '2026-06-01T17:00:00+09:00');
  assert.equal(r.tickSeq, 100);
  assert.equal(r.forecast.length, 2);
  assert.equal(r.patternMatch.length, 2);
});

test('buildLogEntry: slot から slotStart/stall1-4/total のみ抽出 (slotEnd 等は捨てる)', () => {
  const fc = makeForecast([[1, 0, 2, 1]]);
  const r = buildLogEntry(fc, { historicalCurve: [] }, 100, '2026-06-01T17:00:00+09:00');
  const s = r.forecast[0];
  assert.deepEqual(Object.keys(s).sort(), ['slotStart', 'stall1', 'stall2', 'stall3', 'stall4', 'total'].sort());
});

test('buildLogEntry: forecast のみ存在し patternMatch 空 → patternMatch は空配列', () => {
  const fc = makeForecast([[1, 0, 2, 1]]);
  const r = buildLogEntry(fc, null, 100, '2026-06-01T17:00:00+09:00');
  assert.equal(r.forecast.length, 1);
  assert.deepEqual(r.patternMatch, []);
});
