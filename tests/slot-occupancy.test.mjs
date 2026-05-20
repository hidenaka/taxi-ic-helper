import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import {
  slotOccupied, slotsForStall, countStallOccupancy, departuresBetween, medianOf3, isFrameAbnormal,
} from '../scripts/lib/slot-occupancy.mjs';

test('isFrameAbnormal: 真っ白 (>235) は異常', () => {
  assert.equal(isFrameAbnormal(250), true);
  assert.equal(isFrameAbnormal(236), true);
});

test('isFrameAbnormal: 真っ黒 (<18) は異常', () => {
  assert.equal(isFrameAbnormal(0), true);
  assert.equal(isFrameAbnormal(17), true);
});

test('isFrameAbnormal: 通常範囲 (18-235) は正常', () => {
  assert.equal(isFrameAbnormal(100), false);
  assert.equal(isFrameAbnormal(18), false);
  assert.equal(isFrameAbnormal(235), false);
});

test('isFrameAbnormal: NaN/非数値は異常扱い', () => {
  assert.equal(isFrameAbnormal(NaN), true);
  assert.equal(isFrameAbnormal(null), true);
  assert.equal(isFrameAbnormal(undefined), true);
});

test('slotOccupied: エッジ密度がしきい値以上なら在', () => {
  assert.equal(slotOccupied({ edge_density: 0.20 }, 0.08), true);
  assert.equal(slotOccupied({ edge_density: 0.03 }, 0.08), false);
});

test('slotOccupied: edge_density 欠落・null は不在', () => {
  assert.equal(slotOccupied({}, 0.08), false);
  assert.equal(slotOccupied(null, 0.08), false);
});

test('slotsForStall: 指定乗り場の slots を返す', () => {
  const cfg = { stalls: { stall1: { slots: [{ id: '1-1' }, { id: '1-2' }] } } };
  assert.equal(slotsForStall(cfg, 'stall1').length, 2);
  assert.deepEqual(slotsForStall(cfg, 'stall9'), []);
});

test('countStallOccupancy: 占有スロット数を数える', () => {
  const slots = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(countStallOccupancy({ a: true, b: false, c: true }, slots), 2);
  assert.equal(countStallOccupancy({}, slots), 0);
});

test('departuresBetween: 在台数が減った分が出庫、増加は0', () => {
  assert.equal(departuresBetween(8, 6), 2);
  assert.equal(departuresBetween(3, 8), 0);
  assert.equal(departuresBetween(5, 5), 0);
});

test('medianOf3: 3値の中央値（1tickフリッカ除去）', () => {
  assert.equal(medianOf3(8, 0, 8), 8);
  assert.equal(medianOf3(8, 7, 7), 7);
  assert.equal(medianOf3(5, 6, 4), 5);
});
