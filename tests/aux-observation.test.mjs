import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import {
  buildAuxImageEntry, findPrevAuxImage, buildAuxRow,
  AUX_SCHEMA_VERSION, T3_STAND_IMAGES, POOL_IMAGES,
} from '../scripts/lib/aux-observation.mjs';

test('定数: 観測対象画像とスキーマ版', () => {
  assert.deepEqual(T3_STAND_IMAGES, ['Real106', 'Real107']);
  assert.deepEqual(POOL_IMAGES, ['Real03', 'Real04', 'Real108', 'Real109']);
  assert.equal(AUX_SCHEMA_VERSION, 1);
});

test('buildAuxImageEntry: 完全な結果 → フラットなエントリ', () => {
  const analyzeResult = {
    sha256: 'abc', size_bytes: 13961, black_ratio: 0.05, diff_from_prev: 0.03,
    roi: { edge_density: 0.12, roi_black_ratio: 0.05, luminance_mean: 180.2, luminance_std: 40.1, diff_edge_from_prev: null },
  };
  const e = buildAuxImageEntry('Real106', analyzeResult);
  assert.equal(e.name, 'Real106');
  assert.equal(e.sha256, 'abc');
  assert.equal(e.size_bytes, 13961);
  assert.equal(e.black_ratio, 0.05);
  assert.equal(e.edge_density, 0.12);
  assert.equal(e.luminance_mean, 180.2);
  assert.equal(e.luminance_std, 40.1);
  assert.equal(e.diff_from_prev, 0.03);
});

test('buildAuxImageEntry: roi 欠損 → edge_density 等は null', () => {
  const analyzeResult = { sha256: 'x', size_bytes: 100, black_ratio: 0.1, diff_from_prev: null };
  const e = buildAuxImageEntry('Real107', analyzeResult);
  assert.equal(e.edge_density, null);
  assert.equal(e.luminance_mean, null);
  assert.equal(e.luminance_std, null);
  assert.equal(e.diff_from_prev, null);
  assert.equal(e.black_ratio, 0.1);
});

test('findPrevAuxImage: prevRow null → null', () => {
  assert.equal(findPrevAuxImage(null, 't3_stand', 'Real106'), null);
});

test('findPrevAuxImage: 該当グループ・画像 → エントリ', () => {
  const prevRow = {
    t3_stand: [{ name: 'Real106', black_ratio: 0.04 }, { name: 'Real107', black_ratio: 0.08 }],
    pool: [{ name: 'Real03', black_ratio: 0.11 }],
  };
  assert.equal(findPrevAuxImage(prevRow, 't3_stand', 'Real107').black_ratio, 0.08);
  assert.equal(findPrevAuxImage(prevRow, 'pool', 'Real03').black_ratio, 0.11);
});

test('findPrevAuxImage: 該当なし → null', () => {
  const prevRow = { t3_stand: [{ name: 'Real106' }], pool: [] };
  assert.equal(findPrevAuxImage(prevRow, 't3_stand', 'Real999'), null);
  assert.equal(findPrevAuxImage(prevRow, 'pool', 'Real03'), null);
});

test('buildAuxRow: 行を組み立てる', () => {
  const row = buildAuxRow('2026-05-16T11:14:27+09:00', 1162, [{ name: 'Real106' }], [{ name: 'Real03' }]);
  assert.equal(row.schema_version, 1);
  assert.equal(row.ts, '2026-05-16T11:14:27+09:00');
  assert.equal(row.tick_seq, 1162);
  assert.equal(row.t3_stand.length, 1);
  assert.equal(row.pool.length, 1);
});
