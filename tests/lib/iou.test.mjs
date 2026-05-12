import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { iou } from '../../scripts/lib/iou.mjs';

// bbox は [x, y, w, h] 形式

test('完全一致は 1.0', () => {
  assert.equal(iou([10, 10, 100, 100], [10, 10, 100, 100]), 1.0);
});

test('完全非交差は 0.0', () => {
  assert.equal(iou([0, 0, 50, 50], [100, 100, 50, 50]), 0);
});

test('半分重なる場合は 1/3', () => {
  // 100x100 と 100x100、横方向に50ずれ
  // 交差面積 50*100=5000, 結合面積 100*100 + 50*100 = 15000
  const r = iou([0, 0, 100, 100], [50, 0, 100, 100]);
  assert.ok(Math.abs(r - 5000/15000) < 1e-6);
});

test('片方が他方に内包される場合', () => {
  // 100x100 の中に 50x50
  // 交差 2500, 結合 10000
  const r = iou([0, 0, 100, 100], [25, 25, 50, 50]);
  assert.ok(Math.abs(r - 2500/10000) < 1e-6);
});

test('境界接触は 0.0', () => {
  // 100x100 と 100x100、x=100で接する
  assert.equal(iou([0, 0, 100, 100], [100, 0, 100, 100]), 0);
});
