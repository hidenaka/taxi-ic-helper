import test from 'node:test';
import assert from 'node:assert/strict';
import { pickFillRate, capacityFor } from '../scripts/lib/fill-select.mjs';

// --- 主系は路面ベース ---
test('pickFillRate: 昼の1〜3号は路面ベースを使う', () => {
  const r = pickFillRate({ surface: 0.55, occ: 2, capacity: 32 });
  assert.equal(r.fillRate, 0.55);
  assert.equal(r.fillMethod, 'surface');
});

test('pickFillRate: 満車の1号が台数では9%でも路面ベースなら実態が出る', () => {
  // 2026-08-30 16:00 の実例: 台数2/容量32=6% だが実際は半分以上埋まっていた
  const count = pickFillRate({ occ: 2, capacity: 32 });
  const surface = pickFillRate({ surface: 0.55, occ: 2, capacity: 32 });
  assert.ok(count.fillRate < 0.1);
  assert.ok(surface.fillRate > 0.5);
});

test('pickFillRate: 路面ベースは1.0を超えない', () => {
  assert.equal(pickFillRate({ surface: 1.4 }).fillRate, 1);
});

// --- 4号は設計上ずっと台数方式 ---
test('pickFillRate: 4号は路面ベースがあっても台数を使う', () => {
  const r = pickFillRate({ surface: 0.9, occ: 7, capacity: 46, isStall4: true });
  assert.equal(r.fillMethod, 'count');
  assert.equal(r.fillRate, 0.1522);
});

// --- 夜は行灯が正規・昼の欠測だけが「退避」 ---
test('pickFillRate: 夜に路面ベースが無いのは正常(lantern)', () => {
  assert.equal(pickFillRate({ occ: 20, capacity: 32, isNight: true }).fillMethod, 'lantern');
});

test('pickFillRate: 昼に路面ベースが無いのは異常(count-fallback)', () => {
  assert.equal(pickFillRate({ occ: 20, capacity: 32, isNight: false }).fillMethod, 'count-fallback');
});

// --- 出せないときは黙って0にせずnullにする ---
test('pickFillRate: 容量が無ければ null(0%と偽らない)', () => {
  assert.deepEqual(pickFillRate({ occ: 5, capacity: 0 }), { fillRate: null, fillMethod: null });
  assert.deepEqual(pickFillRate({ occ: undefined, capacity: 32 }), { fillRate: null, fillMethod: null });
});

// --- 昼夜で容量を使い分ける ---
test('capacityFor: 昼は day の容量を使う', () => {
  const cap = { stall1: 32, day: { stall1: 13 } };
  assert.equal(capacityFor(cap, 'stall1', false), 13);
  assert.equal(capacityFor(cap, 'stall1', true), 32);
});

test('capacityFor: 昼の容量が未設定の号は夜の容量に落とす', () => {
  const cap = { stall2: 87, day: {} };
  assert.equal(capacityFor(cap, 'stall2', false), 87);
});

test('capacityFor: 夜の容量で昼を割ると上限に届かない(この分離の理由)', () => {
  const cap = { stall1: 32, day: { stall1: 13 } };
  const dayMaxCount = 13;   // 新カメラ期間の昼の観測最大
  const wrong = pickFillRate({ occ: dayMaxCount, capacity: capacityFor(cap, 'stall1', true) });
  const right = pickFillRate({ occ: dayMaxCount, capacity: capacityFor(cap, 'stall1', false) });
  assert.ok(wrong.fillRate < 0.45);   // 満車でも41%止まりだった
  assert.equal(right.fillRate, 1);
});
