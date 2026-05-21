import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import {
  slotOccupied, slotsForStall, countStallOccupancy, departuresBetween, medianOf3, isFrameAbnormal,
  expandRoiVertical, medianSmooth, rollingMaxDelay,
} from '../scripts/lib/slot-occupancy.mjs';

test('medianSmooth: 単発スパイク (谷) を中央値で除去', () => {
  assert.deepEqual(medianSmooth([11, 2, 11, 11], 3), [11, 11, 11, 11]);
});

test('medianSmooth: 端は窓を縮める (長さ保持)', () => {
  const out = medianSmooth([10, 0, 10, 10, 10], 5);
  assert.equal(out.length, 5);
  assert.equal(out[1], 10); // 単発の 0 は周囲に埋もれる
});

test('medianSmooth: win<=1 は無平滑化のコピー', () => {
  const s = [3, 1, 4];
  assert.deepEqual(medianSmooth(s, 1), s);
  assert.notEqual(medianSmooth(s, 1), s); // 別配列を返す
});

test('rollingMaxDelay: 一瞬の谷を埋める (k=3)', () => {
  assert.deepEqual(rollingMaxDelay([10, 10, 3, 10], 3), [10, 10, 10, 10]);
});

test('rollingMaxDelay: 持続した減少は k tick 後に反映', () => {
  assert.deepEqual(rollingMaxDelay([10, 5, 5, 5], 3), [10, 10, 10, 5]);
});

test('rollingMaxDelay: 増加は即時反映', () => {
  assert.deepEqual(rollingMaxDelay([2, 8, 8], 3), [2, 8, 8]);
});

test('rollingMaxDelay: k<=1 は無変化のコピー', () => {
  const s = [1, 2, 3];
  assert.deepEqual(rollingMaxDelay(s, 1), s);
  assert.notEqual(rollingMaxDelay(s, 1), s);
});

test('isFrameAbnormal: 真っ白 (>235) は異常', () => {
  assert.equal(isFrameAbnormal(250), true);
  assert.equal(isFrameAbnormal(236), true);
});

test('isFrameAbnormal: 真っ黒 (<5) は異常', () => {
  assert.equal(isFrameAbnormal(0), true);
  assert.equal(isFrameAbnormal(4), true);
});

test('isFrameAbnormal: 夜の暗い画像 (avg 5-30) は正常', () => {
  assert.equal(isFrameAbnormal(5), false);
  assert.equal(isFrameAbnormal(15), false); // 羽田 real02 夜
  assert.equal(isFrameAbnormal(25), false);
});

test('isFrameAbnormal: 通常範囲 (5-235) は正常', () => {
  assert.equal(isFrameAbnormal(100), false);
  assert.equal(isFrameAbnormal(235), false);
});

test('isFrameAbnormal: NaN/非数値は異常扱い', () => {
  assert.equal(isFrameAbnormal(NaN), true);
  assert.equal(isFrameAbnormal(null), true);
  assert.equal(isFrameAbnormal(undefined), true);
});

test('slotOccupied (昼): edge_density がしきい値以上なら在', () => {
  assert.equal(slotOccupied({ edge_density: 0.20 }, { edgeThreshold: 0.08 }), true);
  assert.equal(slotOccupied({ edge_density: 0.03 }, { edgeThreshold: 0.08 }), false);
});

test('slotOccupied (昼): edge_density 欠落・null は不在', () => {
  assert.equal(slotOccupied({}, { edgeThreshold: 0.08 }), false);
  assert.equal(slotOccupied(null, { edgeThreshold: 0.08 }), false);
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

test('expandRoiVertical: factor=2 で height が 2倍、y が上にシフト', () => {
  const r = expandRoiVertical({ x: 100, y: 100, width: 20, height: 20 }, 2, 800, 600);
  assert.deepEqual(r, { x: 100, y: 90, width: 20, height: 40 });
});

test('expandRoiVertical: 画像上端で y を 0 にクリップ', () => {
  const r = expandRoiVertical({ x: 100, y: 5, width: 20, height: 20 }, 2, 800, 600);
  assert.equal(r.y, 0);
  assert.equal(r.x, 100);
  assert.equal(r.width, 20);
  assert.ok(r.height <= 40 && r.height >= 20);
});

test('expandRoiVertical: 画像下端で height を縮める', () => {
  const r = expandRoiVertical({ x: 100, y: 580, width: 20, height: 20 }, 2, 800, 600);
  assert.equal(r.y, 570);
  assert.equal(r.height, 30);
});

test('expandRoiVertical: factor=1 は不変', () => {
  const orig = { x: 100, y: 100, width: 20, height: 20 };
  const r = expandRoiVertical(orig, 1, 800, 600);
  assert.deepEqual(r, orig);
});

test('slotOccupied (夜): lantern_pixel_ratio が閾値以上なら在', () => {
  assert.equal(
    slotOccupied({ lantern_pixel_ratio: 0.010 }, { isNight: true, nightLanternRatio: 0.005 }),
    true
  );
  assert.equal(
    slotOccupied({ lantern_pixel_ratio: 0.003 }, { isNight: true, nightLanternRatio: 0.005 }),
    false
  );
});

test('slotOccupied (夜): lantern_pixel_ratio 境界 (= ratio) で在', () => {
  assert.equal(
    slotOccupied({ lantern_pixel_ratio: 0.005 }, { isNight: true, nightLanternRatio: 0.005 }),
    true
  );
});

test('slotOccupied (夜): lantern_pixel_ratio 欠落は不在', () => {
  assert.equal(
    slotOccupied({}, { isNight: true, nightLanternRatio: 0.005 }),
    false
  );
});

test('slotOccupied (夜): isNight=true なら edge_density は無視', () => {
  assert.equal(
    slotOccupied({ edge_density: 1.0, lantern_pixel_ratio: 0 }, { isNight: true, nightLanternRatio: 0.005 }),
    false
  );
});

test('slotOccupied (昼): isNight 未指定は false 扱いで edge_density 判定', () => {
  assert.equal(
    slotOccupied({ edge_density: 0.20 }, { edgeThreshold: 0.08 }),
    true
  );
});
