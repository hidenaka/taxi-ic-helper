import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { Jimp } from 'jimp';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { frontBox, meanGrayInBox, detectAdvances, binCountsByWindow, medianSmooth, detectReplenishments } from '../scripts/lib/advance-counter.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('frontBox: 先頭nスロットの外接矩形(正規化)を返す', () => {
  const slots = [{ cx: 0.1, cy: 0.2 }, { cx: 0.3, cy: 0.4 }, { cx: 0.9, cy: 0.9 }];
  assert.deepEqual(frontBox(slots, 2), { x0: 0.1, x1: 0.3, y0: 0.2, y1: 0.4 });
});

test('frontBox: nがスロット数を超えても全部で外接矩形', () => {
  const slots = [{ cx: 0.5, cy: 0.5 }, { cx: 0.2, cy: 0.8 }];
  assert.deepEqual(frontBox(slots, 6), { x0: 0.2, x1: 0.5, y0: 0.5, y1: 0.8 });
});

// detectAdvances: 共通絶対しきい値を超える「状態の切り替わり」を debounce 付きで数える
const T = (n) => Array.from({ length: n }, (_, i) => i * 60); // 60秒刻みの時刻

test('detectAdvances: 平坦な系列はイベント0', () => {
  const v = [100, 101, 99, 100, 100, 101];
  const r = detectAdvances(v, T(v.length), { absThreshold: 10, debounceSec: 120 });
  assert.equal(r.count, 0);
});

test('detectAdvances: しきい値を超える1段の変化で1イベント', () => {
  const v = [100, 100, 100, 130, 130, 130]; // +30 の段
  const r = detectAdvances(v, T(v.length), { absThreshold: 10, debounceSec: 120 });
  assert.equal(r.count, 1);
});

test('detectAdvances: 上昇→下降で2イベント(debounce以上空く)', () => {
  // index3で+30, index8で-30。60秒刻みなので間隔300秒 > debounce120
  const v = [100, 100, 100, 130, 130, 130, 130, 130, 100, 100];
  const r = detectAdvances(v, T(v.length), { absThreshold: 10, debounceSec: 120 });
  assert.equal(r.count, 2);
});

test('detectAdvances: debounce 内の連続変化は1回だけ数える', () => {
  // index1で+30, index2でさらに+30 (間隔60s < debounce120) → 2回目は無視
  const v = [100, 130, 160, 160, 160];
  const r = detectAdvances(v, T(v.length), { absThreshold: 10, debounceSec: 120 });
  assert.equal(r.count, 1);
});

test('detectAdvances: しきい値未満の小さな揺れは数えない', () => {
  const v = [100, 105, 98, 103, 97, 104];
  const r = detectAdvances(v, T(v.length), { absThreshold: 15, debounceSec: 120 });
  assert.equal(r.count, 0);
});

test('binCountsByWindow: イベント時刻を窓(秒)ごとの回数に丸める', () => {
  // 15分=900秒窓。origin=0。イベント t=100,800(窓0), 1000,1700(窓1), 2000(窓2)
  const ev = [100, 800, 1000, 1700, 2000];
  const bins = binCountsByWindow(ev, 900, 0);
  // {windowStartSec: count}
  assert.equal(bins[0], 2);
  assert.equal(bins[900], 2);
  assert.equal(bins[1800], 1);
});

test('binCountsByWindow: 空イベントは空オブジェクト', () => {
  assert.deepEqual(binCountsByWindow([], 900, 0), {});
});

test('meanGradInBox: 実カメラ画像の先頭ボックスで有限の輝度を返す', async () => {
  const img = await Jimp.read(join(ROOT, 'data/pool-cam-real01.jpg'));
  const cfg = JSON.parse(readFileSync(join(ROOT, 'scripts/lib/stall-slots.json'), 'utf8'));
  const box = frontBox(cfg.stalls.stall1.slots, 6);
  const g = meanGrayInBox(img, box, 3);
  assert.ok(Number.isFinite(g) && g > 0, `gray=${g}`);
});

// medianSmooth: k=3 のメディアン窓で1フレームの突発スパイクを潰す。プラトーは保つ。
test('medianSmooth: 1フレームのスパイクを除去する', () => {
  assert.deepEqual(medianSmooth([100, 100, 160, 100, 100], 3), [100, 100, 100, 100, 100]);
});

test('medianSmooth: 立ち上がってからのプラトーは保持する', () => {
  assert.deepEqual(medianSmooth([100, 100, 160, 160, 160], 3), [100, 100, 160, 160, 160]);
});

// detectReplenishments: 「手薄(低)→補充(高)」の立ち上がりエッジだけを数える(補充エッジ方式)。
// 下降(出庫)は数えない。一過性ブリップは持続条件で除外。
const TR = (n) => Array.from({ length: n }, (_, i) => i * 60); // 60秒刻みの時刻

test('detectReplenishments: 平坦な系列は0', () => {
  const v = [100, 101, 99, 100, 100, 101];
  const r = detectReplenishments(v, TR(v.length), { absThreshold: 10, debounceSec: 120, persistSec: 120 });
  assert.equal(r.count, 0);
});

test('detectReplenishments: 持続する1段の立ち上がりで1回', () => {
  const v = [100, 100, 100, 130, 130, 130]; // +30 が3フレーム持続
  const r = detectReplenishments(v, TR(v.length), { absThreshold: 10, debounceSec: 120, persistSec: 120 });
  assert.equal(r.count, 1);
});

test('detectReplenishments: 立ち上がり→下降は1回だけ(下降=出庫は数えない)', () => {
  // 旧 detectAdvances は双方向で2回数えた。補充エッジ方式では立ち上がりのみ=1回。
  const v = [100, 100, 100, 130, 130, 130, 130, 130, 100, 100];
  const r = detectReplenishments(v, TR(v.length), { absThreshold: 10, debounceSec: 120, persistSec: 120 });
  assert.equal(r.count, 1);
});

test('detectReplenishments: 手薄に戻ってから再補充で2回', () => {
  const v = [100, 100, 130, 130, 130, 100, 100, 130, 130, 130];
  const r = detectReplenishments(v, TR(v.length), { absThreshold: 10, debounceSec: 120, persistSec: 120 });
  assert.equal(r.count, 2);
});

test('detectReplenishments: 一過性ブリップ(すぐ手薄へ戻る)は数えない', () => {
  // 先頭をたまたま車が横切っただけ。2フレームで戻る=持続しない→0。
  const v = [100, 100, 160, 160, 100, 100];
  const r = detectReplenishments(v, TR(v.length), { absThreshold: 10, debounceSec: 120, persistSec: 120 });
  assert.equal(r.count, 0);
});

test('detectReplenishments: 連続して高くなり続けても1回(同じ補充の続き)', () => {
  // 100→130→160 と段階的に増えるのは1つの補充の継続。debounce/状態で二重計上しない。
  const v = [100, 130, 160, 160, 160, 160];
  const r = detectReplenishments(v, TR(v.length), { absThreshold: 10, debounceSec: 120, persistSec: 120 });
  assert.equal(r.count, 1);
});
