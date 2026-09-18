import { test } from "node:test";
import assert from "node:assert";
import { parseRowEvents, rowsInWindow, applyStall4Rows } from "../scripts/lib/stall4-rows.mjs";

const ev = parseRowEvents([
  JSON.stringify({ ts: "2026-09-17T11:55:00+09:00", rows: 1 }),
  JSON.stringify({ ts: "2026-09-17T12:02:00+09:00", rows: 2 }),
  "broken line",
  JSON.stringify({ ts: "2026-09-17T12:20:00+09:00", rows: 1 }),
].join("\n"));

test("parseRowEvents: 壊れた行は捨てる", () => {
  assert.strictEqual(ev.length, 3);
});

test("rowsInWindow: ビン内の列数を合計(2列移動は2)", () => {
  const start = Math.floor(new Date("2026-09-17T11:45:00+09:00").getTime() / 1000);
  assert.strictEqual(rowsInWindow(ev, start, start + 900), 1);                 // 11:45-12:00
  assert.strictEqual(rowsInWindow(ev, start + 900, start + 1800), 2);         // 12:00-12:15
  assert.strictEqual(rowsInWindow(ev, start + 1800, start + 2700), 1);        // 12:15-12:30
  assert.strictEqual(rowsInWindow(ev, start + 2700, start + 3600), 0);
});

test("applyStall4Rows: stall4 を列移動由来に置き換え、他の乗り場は触らない", () => {
  const bin = { ts: "2026-09-17T12:00:00+09:00", stalls: { stall3: 2, stall4: 5 } };
  const out = applyStall4Rows(bin, ev);
  assert.deepStrictEqual(out.stalls, { stall3: 2, stall4: 2 });
  assert.deepStrictEqual(bin.stalls, { stall3: 2, stall4: 5 });               // 入力は不変
});

test("applyStall4Rows: イベントが無いビンは stall4 を落とす / events=null は従来のまま", () => {
  const bin = { ts: "2026-09-17T13:00:00+09:00", stalls: { stall2: 1, stall4: 3 } };
  assert.deepStrictEqual(applyStall4Rows(bin, ev).stalls, { stall2: 1 });
  assert.deepStrictEqual(applyStall4Rows(bin, null).stalls, { stall2: 1, stall4: 3 });
});
