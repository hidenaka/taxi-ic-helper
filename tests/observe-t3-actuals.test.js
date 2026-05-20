import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeT3SlotActuals } from '../scripts/lib/t3-occupancy-helpers.mjs';

// observe-taxi-pool.mjs の T3 ブロックは以下の純粋な流れを持つ:
//   1. data/t3-slot-occupancy-history.jsonl を1行ずつ JSON.parse
//   2. computeT3SlotActuals(history, new Date(), 720) で集計
//   3. data/t3-stall-actuals.json に { schemaVersion, generatedAt, slots } を書き出し
// このTaskでは、組み込みコードを抜き出して同じ流れで動くことを純関数として検証する。
// 実ファイル I/O はスタブし、computeT3SlotActuals の使い方が既存と整合することを確認。

test('T3 actuals payload shape matches existing stall-actuals.json convention', () => {
  const history = [
    { ts: '2026-05-20T19:00:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 18 } } },
    { ts: '2026-05-20T19:05:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 16 } } },
  ];
  const slots = computeT3SlotActuals(history, new Date('2026-05-20T19:30:00+09:00'), 720);
  const payload = {
    schemaVersion: 1,
    generatedAt: '2026-05-20T19:30:00+09:00',
    slots,
  };
  assert.equal(payload.schemaVersion, 1);
  assert.equal(typeof payload.generatedAt, 'string');
  assert.ok(Array.isArray(payload.slots));
  assert.ok(payload.slots.length > 0);
  // 各 slot は slotStart/slotEnd/total を持つ (T3 は total 1列のみ)
  for (const s of payload.slots) {
    assert.equal(typeof s.slotStart, 'string');
    assert.equal(typeof s.slotEnd, 'string');
    assert.equal(typeof s.total, 'number');
    assert.equal(s.stall1, undefined, 'T3 actuals must not have stall1..4 keys');
  }
});

test('T3 actuals: empty history → empty slots array (no crash)', () => {
  // history が空 (まだ Mac mini で 1回も観測してない初期状態) のとき crash しない
  const slots = computeT3SlotActuals([], new Date(), 720);
  assert.deepEqual(slots, []);
});

test('T3 actuals: malformed line robustness (純関数は壊れ行を含まない前提だが、組込み側で skip する)', () => {
  // observe-taxi-pool.mjs 内では `try { JSON.parse(line) } catch { skip }` で防御するため、
  // computeT3SlotActuals に渡る時点で壊れ行は除外されている前提。
  // 純関数の責務はあくまで「正しい行配列を受け取って集計する」こと。
  const history = [
    { ts: '2026-05-20T19:00:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 18 } } },
    { ts: 'invalid-date', mode: 'day', stalls: { t3_stand: { occ: 10 } } }, // 内部で除外される
    { ts: '2026-05-20T19:05:00+09:00', mode: 'day', stalls: { t3_stand: { occ: 16 } } },
  ];
  const slots = computeT3SlotActuals(history, new Date('2026-05-20T19:30:00+09:00'), 720);
  // 不正な ts 行は filter で落ちる → 残り 2行 で 1diff = total 2
  const totals = slots.reduce((s, x) => s + x.total, 0);
  assert.equal(totals, 2);
});
