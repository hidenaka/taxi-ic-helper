import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { Jimp } from 'jimp';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { frontBox, meanGrayInBox, detectAdvances } from '../scripts/lib/advance-counter.mjs';

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

test('meanGradInBox: 実カメラ画像の先頭ボックスで有限の輝度を返す', async () => {
  const img = await Jimp.read(join(ROOT, 'data/pool-cam-real01.jpg'));
  const cfg = JSON.parse(readFileSync(join(ROOT, 'scripts/lib/stall-slots.json'), 'utf8'));
  const box = frontBox(cfg.stalls.stall1.slots, 6);
  const g = meanGrayInBox(img, box, 3);
  assert.ok(Number.isFinite(g) && g > 0, `gray=${g}`);
});
