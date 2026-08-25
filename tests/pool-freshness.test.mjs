import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { poolFreshness } from '../scripts/lib/pool-status.mjs';

const NOW = Date.parse('2026-08-26T08:30:00+09:00');
const minAgo = (m) => NOW - m * 60 * 1000;

test('poolFreshness: 写真も計測も新しければ最新', () => {
  const r = poolFreshness(minAgo(2), minAgo(4), NOW);
  assert.equal(r.stale, false);
  assert.equal(r.since, null);
});

test('poolFreshness: 写真は新しいが台数計測が止まっていれば stale (2026-08-24の実障害)', () => {
  // 配信元の解像度変更で計測だけ2日止まり、写真は1分前まで更新されていた状態
  const countAt = Date.parse('2026-08-24T06:56:00+09:00');
  const r = poolFreshness(minAgo(1), countAt, NOW);
  assert.equal(r.stale, true, '計測が止まっていれば stale');
  assert.equal(r.since, new Date(countAt).toISOString(), '「どこまで正しかったか」は計測の最終時刻');
});

test('poolFreshness: 写真が止まっていれば計測が新しくても stale', () => {
  const imgAt = minAgo(40);
  const r = poolFreshness(imgAt, minAgo(3), NOW);
  assert.equal(r.stale, true);
  assert.equal(r.since, new Date(imgAt).toISOString());
});

test('poolFreshness: 両方止まっていれば古いほうを since にする', () => {
  const imgAt = minAgo(90), countAt = minAgo(300);
  const r = poolFreshness(imgAt, countAt, NOW);
  assert.equal(r.stale, true);
  assert.equal(r.since, new Date(countAt).toISOString());
});

test('poolFreshness: 時刻が取れない(null/NaN)ときも stale として扱う', () => {
  assert.equal(poolFreshness(NaN, minAgo(1), NOW).stale, true);
  assert.equal(poolFreshness(minAgo(1), null, NOW).stale, true);
  assert.equal(poolFreshness(null, null, NOW).since, null);
});

test('poolFreshness: 境界 — 計測20分ちょうどは stale / 19分は最新', () => {
  assert.equal(poolFreshness(minAgo(1), minAgo(20), NOW).stale, true);
  assert.equal(poolFreshness(minAgo(1), minAgo(19), NOW).stale, false);
});
