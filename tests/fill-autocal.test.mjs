import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { computeDynamicFullRef } from '../scripts/lib/fill-autocal.mjs';

function rows(frs, { stall = 'stall1', baseMs = Date.parse('2026-05-23T12:00:00+09:00'), stepMs = 30000 } = {}) {
  return frs.map((fr, i) => ({
    ts: new Date(baseMs + i * stepMs).toISOString(),
    stalls: { [stall]: { fill: fr } },
  }));
}

test('computeDynamicFullRef: 高パーセンタイルを full_ref に採用', () => {
  // 0.10..0.79 の 30 サンプル → 92%ile ≒ 上位
  const frs = Array.from({ length: 30 }, (_, i) => 0.10 + i * 0.02); // 0.10..0.68
  const now = Date.parse('2026-05-23T12:00:00+09:00') + 30 * 30000;
  const r = computeDynamicFullRef(rows(frs), ['stall1'], { nowMs: now, minSamples: 10 });
  // 92%ile of 0.10..0.68 ≒ 0.64 付近、クランプ域内なのでそのまま
  assert.ok(r.stall1 >= 0.6 && r.stall1 <= 0.68, `got ${r.stall1}`);
});

test('computeDynamicFullRef: 下限/上限にクランプ', () => {
  const now = Date.parse('2026-05-23T12:00:00+09:00') + 40 * 30000;
  // 全て低い → 下限 0.35 に
  const lowR = computeDynamicFullRef(rows(Array(40).fill(0.05)), ['stall1'], { nowMs: now, minSamples: 10 });
  assert.equal(lowR.stall1, 0.35);
  // 全て高い → 上限 0.85 に
  const hiR = computeDynamicFullRef(rows(Array(40).fill(0.99)), ['stall1'], { nowMs: now, minSamples: 10 });
  assert.equal(hiR.stall1, 0.85);
});

test('computeDynamicFullRef: サンプル不足は fallback', () => {
  const now = Date.parse('2026-05-23T12:00:00+09:00') + 5 * 30000;
  const r = computeDynamicFullRef(rows([0.4, 0.5, 0.6]), ['stall1'], {
    nowMs: now, minSamples: 20, fallback: { stall1: 0.55 },
  });
  assert.equal(r.stall1, 0.55);
});

test('computeDynamicFullRef: 窓外の古いサンプルは無視', () => {
  // 12h より前の高 fr は無視され、窓内の低 fr のみで判定 → fallback (サンプル不足)
  const oldBase = Date.parse('2026-05-22T00:00:00+09:00');
  const old = rows(Array(40).fill(0.8), { baseMs: oldBase });
  const now = Date.parse('2026-05-23T12:00:00+09:00');
  const r = computeDynamicFullRef(old, ['stall1'], {
    nowMs: now, windowMs: 12 * 3600 * 1000, minSamples: 20, fallback: { stall1: 0.5 },
  });
  assert.equal(r.stall1, 0.5);
});

test('computeDynamicFullRef: fill 無し乗り場は fallback/null', () => {
  const now = Date.parse('2026-05-23T12:00:00+09:00') + 40 * 30000;
  const r = computeDynamicFullRef(rows(Array(40).fill(0.5)), ['stall2'], { nowMs: now, minSamples: 10 });
  assert.equal(r.stall2, null);
});
