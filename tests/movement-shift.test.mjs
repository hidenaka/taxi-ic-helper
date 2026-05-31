import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { Jimp } from 'jimp';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bestShift, laneSamplePoints, accumulateForwardShift, sampleProfile, profileForSlots } from '../scripts/lib/movement-shift.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 列の1次元輝度プロファイル。山(車/行灯)が並ぶ。
const A = [0, 0, 9, 8, 0, 0, 7, 9, 0, 0];

test('bestShift: 同一プロファイルはラグ0・高スコア', () => {
  const { lag, score } = bestShift(A, A, 3);
  assert.equal(lag, 0);
  assert.ok(score > 0.9, `score=${score}`);
});

test('bestShift: bがaを右に2ずらした波形ならラグ+2', () => {
  // b[i] ≈ a[i-2]
  const B = [0, 0, 0, 0, 9, 8, 0, 0, 7, 9];
  const { lag } = bestShift(A, B, 3);
  assert.equal(lag, 2);
});

test('bestShift: bがaを左に1ずらした波形ならラグ-1', () => {
  // b[i] ≈ a[i+1]
  const B = [0, 9, 8, 0, 0, 7, 9, 0, 0, 0];
  const { lag } = bestShift(A, B, 3);
  assert.equal(lag, -1);
});

test('bestShift: maxLag を超えるシフトは探索範囲内に丸める', () => {
  const B = [0, 0, 0, 0, 0, 0, 9, 8, 0, 0]; // 右に4
  const { lag } = bestShift(A, B, 3);
  assert.ok(Math.abs(lag) <= 3);
});

test('bestShift: 平坦(動きなし)プロファイルは低スコア', () => {
  const flat = [3, 3, 3, 3, 3, 3, 3, 3, 3, 3];
  const { score } = bestShift(flat, flat, 3);
  assert.ok(score < 0.5, `flat score=${score}`);
});

test('laneSamplePoints: oversample=1 はスロット中心をそのまま順に返す', () => {
  const slots = [{ cx: 0.1, cy: 0.2 }, { cx: 0.3, cy: 0.4 }];
  const pts = laneSamplePoints(slots, 1);
  assert.deepEqual(pts, [{ cx: 0.1, cy: 0.2 }, { cx: 0.3, cy: 0.4 }]);
});

test('laneSamplePoints: oversample=2 は各区間に中点を補間する', () => {
  const slots = [{ cx: 0, cy: 0 }, { cx: 1, cy: 1 }];
  const pts = laneSamplePoints(slots, 2);
  // 端点2 + 中点1 = 3点
  assert.equal(pts.length, 3);
  assert.deepEqual(pts[1], { cx: 0.5, cy: 0.5 });
});

test('accumulateForwardShift: 一方向に進むプロファイル列は前進量を積算する', () => {
  // 毎フレーム右に1ずつ進む山(=列が1つ前進)を head=+ 方向とする
  const base = [0, 0, 9, 8, 0, 0, 0, 0, 0, 0];
  const shiftRight = (p, k) => {
    const out = new Array(p.length).fill(0);
    for (let i = 0; i < p.length; i++) { const j = i - k; if (j >= 0 && j < p.length) out[i] = p[j]; }
    return out;
  };
  const profiles = [base, shiftRight(base, 1), shiftRight(base, 2), shiftRight(base, 3)];
  const r = accumulateForwardShift(profiles, { maxLag: 3, minScore: 0.5, forwardSign: 1 });
  assert.equal(r.totalShift, 3); // 1+1+1
  assert.equal(r.advances, 3);
});

test('sampleProfile: radius=0 は各サンプル点の輝度をそのまま並べる', () => {
  const pts = [{ cx: 0, cy: 0 }, { cx: 1, cy: 1 }];
  const getLum = (x, y) => x * 10 + y; // (0,0)=0 / (9,9)=99
  const prof = sampleProfile(pts, getLum, 10, 10, 0);
  assert.deepEqual(prof, [0, 99]);
});

test('sampleProfile: radius>0 は近傍の平均を取る(画像端でクランプ)', () => {
  const pts = [{ cx: 0.5, cy: 0.5 }]; // px=py=round(0.5*9)=5 (整数)
  const getLum = (x) => x; // x方向の値
  const prof = sampleProfile(pts, getLum, 10, 10, 1); // x∈{4,5,6} 平均=5
  assert.equal(prof.length, 1);
  assert.ok(Math.abs(prof[0] - 5) < 1e-9, `got ${prof[0]}`);
});

test('profileForSlots: 実カメラ画像から有限値のプロファイルを返す', async () => {
  const img = await Jimp.read(join(ROOT, 'data/pool-cam-real01.jpg'));
  const cfg = JSON.parse(readFileSync(join(ROOT, 'scripts/lib/stall-slots.json'), 'utf8'));
  const slots = cfg.stalls.stall1.slots;
  const prof = profileForSlots(img, slots, { oversample: 3, radius: 1 });
  assert.equal(prof.length, (slots.length - 1) * 3 + 1);
  assert.ok(prof.every(Number.isFinite), 'すべて有限');
  assert.ok(prof.some((v) => v > 0), '少なくとも一部に輝度がある');
});

test('accumulateForwardShift: 低スコア(ノイズ)のシフトは積算しない', () => {
  const noiseA = [1, 4, 2, 5, 1, 3, 2, 4, 1, 2];
  const noiseB = [3, 1, 5, 2, 4, 1, 3, 5, 2, 1];
  const r = accumulateForwardShift([noiseA, noiseB], { maxLag: 3, minScore: 0.8, forwardSign: 1 });
  assert.equal(r.totalShift, 0);
  assert.equal(r.advances, 0);
});
