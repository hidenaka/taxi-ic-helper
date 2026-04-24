import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { aggregateHeatmap } from '../scripts/lib/heatmap-aggregator.mjs';

const flights = [
  { terminal: 'T1', estimatedTime: '14:35', estimatedPax: 192 },
  { terminal: 'T1', estimatedTime: '14:42', estimatedPax: 315 },
  { terminal: 'T1', estimatedTime: '15:02', estimatedPax: 156 },
  { terminal: 'T1', estimatedTime: '15:30', estimatedPax: null },  // 機材不明
  { terminal: 'T2', estimatedTime: '14:50', estimatedPax: 100 }
];

test('指定ターミナルの30分ビン集計', () => {
  const r = aggregateHeatmap(flights, 'T1');
  assert.equal(r.length > 0, true);
  const bin1430 = r.find(b => b.bin === '14:30');
  assert.equal(bin1430.totalPax, 192 + 315);
  assert.equal(bin1430.flightCount, 2);
  assert.equal(bin1430.unknownCount, 0);
});

test('機材不明便はtotalPaxから除外され、unknownCountに加算', () => {
  const r = aggregateHeatmap(flights, 'T1');
  const bin1530 = r.find(b => b.bin === '15:30');
  assert.equal(bin1530.totalPax, 0);
  assert.equal(bin1530.flightCount, 1);
  assert.equal(bin1530.unknownCount, 1);
});

test('別ターミナルの便は除外される', () => {
  const r = aggregateHeatmap(flights, 'T1');
  const t2only = r.find(b => b.totalPax === 100);
  assert.equal(t2only, undefined);
});

test('空配列でも空配列を返す', () => {
  const r = aggregateHeatmap([], 'T1');
  assert.deepEqual(r, []);
});

test('isPeak フラグ：最大値の80%以上のビンに付く', () => {
  const r = aggregateHeatmap(flights, 'T1');
  const max = Math.max(...r.map(b => b.totalPax));
  const peak = r.filter(b => b.isPeak);
  peak.forEach(b => assert.equal(b.totalPax >= max * 0.8, true));
});
