import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { computeSlotActuals, slotOccupancyToForecastRows } from '../scripts/lib/slot-actuals.mjs';

function row(ts, occ) {
  return { schema_version: 1, ts, stalls: {
    stall1: { occ: occ[0] }, stall2: { occ: occ[1] },
    stall3: { occ: occ[2] }, stall4: { occ: occ[3] } } };
}

test('computeSlotActuals: 在台数の持続的な減少を15分スロットの出庫に集計', () => {
  const now = new Date('2026-05-19T19:00:00+09:00');
  // 8台が続いた後 6台に下がって持続 → 平滑化 (median5+持続3) 後も 8→6 の減少が
  // 出庫2として残る。 一瞬の谷ではなく持続した減少だけが計上されることを確認。
  const history = [
    row('2026-05-19T18:01:00+09:00', [8, 0, 0, 0]),
    row('2026-05-19T18:02:00+09:00', [8, 0, 0, 0]),
    row('2026-05-19T18:03:00+09:00', [8, 0, 0, 0]),
    row('2026-05-19T18:04:00+09:00', [8, 0, 0, 0]),
    row('2026-05-19T18:05:00+09:00', [8, 0, 0, 0]),
    row('2026-05-19T18:06:00+09:00', [6, 0, 0, 0]),
    row('2026-05-19T18:07:00+09:00', [6, 0, 0, 0]),
    row('2026-05-19T18:08:00+09:00', [6, 0, 0, 0]),
    row('2026-05-19T18:09:00+09:00', [6, 0, 0, 0]),
    row('2026-05-19T18:10:00+09:00', [6, 0, 0, 0]),
  ];
  const r = computeSlotActuals(history, now);
  assert.equal(r.length, 1);
  assert.equal(r[0].slotStart, '18:00');
  assert.equal(r[0].stall1, 2);
  assert.equal(r[0].total, 2);
});

test('computeSlotActuals: 在台数の増加（列移動の補充）は出庫に数えない', () => {
  const now = new Date('2026-05-19T19:00:00+09:00');
  const history = [
    row('2026-05-19T18:02:00+09:00', [2, 0, 0, 0]),
    row('2026-05-19T18:05:00+09:00', [2, 0, 0, 0]),
    row('2026-05-19T18:08:00+09:00', [8, 0, 0, 0]),
    row('2026-05-19T18:11:00+09:00', [8, 0, 0, 0]),
  ];
  const r = computeSlotActuals(history, now);
  assert.equal(r.length === 0 || r[0].stall1 === 0, true);
});

test('computeSlotActuals: 空・窓外のみ → 空配列', () => {
  const now = new Date('2026-05-19T19:00:00+09:00');
  assert.deepEqual(computeSlotActuals([], now), []);
  assert.deepEqual(computeSlotActuals(undefined, now), []);
});

test('computeSlotActuals: stall4_back の occ は stall4 に合算', () => {
  const now = new Date('2026-05-19T19:00:00+09:00');
  // 先頭2台+後ろ8台=10台が続いた後、 先頭1台+後ろ8台=9台に下がって持続 → 出庫1台。
  function row4(ts, front, back) {
    return { schema_version: 1, ts, stalls: {
      stall1: { occ: 0 }, stall2: { occ: 0 }, stall3: { occ: 0 },
      stall4: { occ: front }, stall4_back: { occ: back },
    } };
  }
  const history = [
    row4('2026-05-19T18:01:00+09:00', 2, 8),
    row4('2026-05-19T18:02:00+09:00', 2, 8),
    row4('2026-05-19T18:03:00+09:00', 2, 8),
    row4('2026-05-19T18:04:00+09:00', 2, 8),
    row4('2026-05-19T18:05:00+09:00', 2, 8),
    row4('2026-05-19T18:06:00+09:00', 1, 8),
    row4('2026-05-19T18:07:00+09:00', 1, 8),
    row4('2026-05-19T18:08:00+09:00', 1, 8),
    row4('2026-05-19T18:09:00+09:00', 1, 8),
    row4('2026-05-19T18:10:00+09:00', 1, 8),
  ];
  const r = computeSlotActuals(history, now);
  // 合計在台数 10 が続いた後 9 に持続的減少 → 18:00-18:15 ビンで stall4=1
  assert.equal(r.length, 1);
  assert.equal(r[0].stall4, 1);
  assert.equal(r[0].total, 1);
});

// 夜 (mode:'night') の per-slot 持続判定の回帰テスト。
// 30秒刻みで night 行を生成。 slots に true/false を並べてフリッカを再現する。
function nightRow(ms, occupiedFlags) {
  const slots = {};
  occupiedFlags.forEach((v, i) => { slots[`stall1-${i + 1}`] = v; });
  const occ = occupiedFlags.filter(Boolean).length;
  return {
    schema_version: 1, mode: 'night',
    ts: new Date(ms + 9 * 3600 * 1000).toISOString().replace('Z', '+09:00'),
    stalls: { stall1: { occ, slots }, stall2: { occ: 0, slots: {} },
      stall3: { occ: 0, slots: {} }, stall4: { occ: 0, slots: {} } },
  };
}

test('computeSlotActuals: 夜の消灯フリッカ(持続判定窓内の谷)は出庫に数えない', () => {
  const base = new Date('2026-05-21T18:00:00+09:00').getTime();
  const STEP = 30 * 1000;
  const full = [true, true, true, true];
  const empty = [false, false, false, false];
  const rows = [];
  let t = base;
  for (let i = 0; i < 10; i++) rows.push(nightRow(t += STEP, full));   // 満車
  for (let i = 0; i < 6; i++) rows.push(nightRow(t += STEP, empty));    // 6tick消灯(窓20内のフリッカ)
  for (let i = 0; i < 10; i++) rows.push(nightRow(t += STEP, full));    // また満車
  const now = new Date(t + 60 * 1000);
  const r = computeSlotActuals(rows, now, 120);
  // 実際には車は居続けている (消灯フリッカ) → 偽出庫は0
  const total = r.reduce((s, a) => s + a.total, 0);
  assert.equal(total, 0);
});

test('computeSlotActuals: 夜でも持続的な出庫(持続判定窓を超える消灯)は計上する', () => {
  const base = new Date('2026-05-21T18:00:00+09:00').getTime();
  const STEP = 30 * 1000;
  const full = [true, true, true, true];
  const empty = [false, false, false, false];
  const rows = [];
  let t = base;
  for (let i = 0; i < 10; i++) rows.push(nightRow(t += STEP, full));   // 満車(4台)
  for (let i = 0; i < 30; i++) rows.push(nightRow(t += STEP, empty));   // 30tick消灯 (窓20超 = 真の退出)
  const now = new Date(t + 60 * 1000);
  const r = computeSlotActuals(rows, now, 120);
  // 4台が持続的に消灯=退出 → 合計出庫4
  const total = r.reduce((s, a) => s + a.total, 0);
  assert.equal(total, 4);
});

test('slotOccupancyToForecastRows: schema3形・昼luminance・出庫は負diff', () => {
  // 昼: stall1 が 8台続く→6台に持続減少。平滑後 8→6 の減少が負 diff で出る。
  const base = Date.parse('2026-05-21T10:00:00+09:00');
  const STEP = 30 * 1000;
  const rows = [];
  let t = base;
  const mk = (occ) => ({ ts: new Date(t).toISOString(), mode: 'day',
    stalls: { stall1: { occ }, stall2: { occ: 0 }, stall3: { occ: 0 }, stall4: { occ: 0 } } });
  for (let i = 0; i < 8; i++) { rows.push(mk(8)); t += STEP; }
  for (let i = 0; i < 8; i++) { rows.push(mk(6)); t += STEP; }
  const out = slotOccupancyToForecastRows(rows);
  assert.equal(out.length, 16);
  assert.equal(out[0].schema_version, 3);
  assert.equal(out[0].img1.roi.luminance_mean, 100);          // 昼=ゲート通過
  // diff の総和(stall1) = 平滑後の純変化 = 8→6 = -2 (出庫2)
  const sumDiff = out.reduce((s, r) => s + r.stalls.stall1.diff_occupied_from_prev, 0);
  assert.equal(sumDiff, -2);
});

test('slotOccupancyToForecastRows: 夜はluminance=0でゲート除外、mode切替diffは0', () => {
  const base = Date.parse('2026-05-21T19:00:00+09:00');
  const rows = [
    { ts: new Date(base).toISOString(), mode: 'day', stalls: { stall1: { occ: 5 }, stall2: { occ: 0 }, stall3: { occ: 0 }, stall4: { occ: 0 } } },
    { ts: new Date(base + 30000).toISOString(), mode: 'night', stalls: { stall1: { occ: 0, slots: {} }, stall2: { occ: 0, slots: {} }, stall3: { occ: 0, slots: {} }, stall4: { occ: 0, slots: {} } } },
  ];
  const out = slotOccupancyToForecastRows(rows);
  assert.equal(out[1].img1.roi.luminance_mean, 0);            // 夜=ゲート除外
  assert.equal(out[1].stalls.stall1.diff_occupied_from_prev, 0); // mode切替=擬似出庫を出さない
});

test('slotOccupancyToForecastRows: 空入力→空配列', () => {
  assert.deepEqual(slotOccupancyToForecastRows([]), []);
  assert.deepEqual(slotOccupancyToForecastRows(undefined), []);
});
