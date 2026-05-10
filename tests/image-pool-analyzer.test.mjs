import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Jimp } from 'jimp';
import { analyzePoolImage } from '../scripts/lib/image-pool-analyzer.mjs';

// 全黒の 10x10 画像を作って Buffer 化
async function blackBuffer() {
  const img = new Jimp({ width: 10, height: 10, color: 0x000000ff });
  return await img.getBuffer('image/jpeg');
}

// 全白の 10x10 画像
async function whiteBuffer() {
  const img = new Jimp({ width: 10, height: 10, color: 0xffffffff });
  return await img.getBuffer('image/jpeg');
}

test('analyzePoolImage: 全黒画像で black_ratio が 1.0 に近い', async () => {
  const buf = await blackBuffer();
  const r = await analyzePoolImage(buf, null);
  assert.ok(r.black_ratio > 0.95, `black_ratio=${r.black_ratio}`);
  assert.equal(typeof r.sha256, 'string');
  assert.equal(r.sha256.length, 64);
  assert.equal(typeof r.size_bytes, 'number');
  assert.equal(r.diff_from_prev, null, 'prev=null なら diff_from_prev も null');
});

test('analyzePoolImage: 全白画像で black_ratio が 0 に近い', async () => {
  const buf = await whiteBuffer();
  const r = await analyzePoolImage(buf, null);
  assert.ok(r.black_ratio < 0.05, `black_ratio=${r.black_ratio}`);
});

test('analyzePoolImage: prev に同じ画像を渡すと diff_from_prev が 0', async () => {
  const buf = await blackBuffer();
  const prev = await analyzePoolImage(buf, null);
  const curr = await analyzePoolImage(buf, prev);
  assert.equal(curr.diff_from_prev, 0);
});

test('analyzePoolImage: prev に異なる画像 (黒 vs 白) を渡すと diff_from_prev > 0.9', async () => {
  const black = await blackBuffer();
  const white = await whiteBuffer();
  const prev = await analyzePoolImage(black, null);
  const curr = await analyzePoolImage(white, prev);
  assert.ok(curr.diff_from_prev > 0.9, `diff_from_prev=${curr.diff_from_prev}`);
});

test('analyzePoolImage: 同じ Buffer で sha256 が deterministic', async () => {
  const buf = await blackBuffer();
  const r1 = await analyzePoolImage(buf, null);
  const r2 = await analyzePoolImage(buf, null);
  assert.equal(r1.sha256, r2.sha256);
});
