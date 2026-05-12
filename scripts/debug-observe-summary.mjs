#!/usr/bin/env node
/**
 * 使い方: node scripts/debug-observe-summary.mjs [N]
 * 最新 N tick (default 20) の vehicles / departures / lane_state を一覧表示する。
 * 検証用: 連続 tick で departures が実際に出ているか目視確認するためのもの。
 */
import { readFileSync } from 'node:fs';

const N = parseInt(process.argv[2], 10) || 20;
const HISTORY = './data/taxi-pool-history.jsonl';

const lines = readFileSync(HISTORY, 'utf8').trim().split('\n').slice(-N);
const rows = lines.map(l => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

console.log(`=== 最新 ${rows.length} tick ===\n`);
console.log('tick  ts        v  real01 real02 dep  第一 第二 第三 第四');
console.log('----  --------  -  ------ ------ ---  ---- ---- ---- ----');
let totalDep = 0;
let firstV3 = null, lastV3 = null;
for (const r of rows) {
  const ts = (r.ts || '').slice(11, 19);
  const v = r.schema_version ?? '?';
  const real01 = r.vehicles?.real01_line?.length ?? '-';
  const real02 = r.vehicles?.real02?.length ?? '-';
  const dep = r.departures?.length ?? 0;
  totalDep += dep;
  const ls = r.lane_state ?? {};
  const f = (id) => {
    const s = ls[id];
    if (!s) return '-';
    return `${s.queue_count}${s.front_row_occupied ? '*' : ''}`;
  };
  console.log(
    `${String(r.tick_seq ?? '?').padStart(4)}  ${ts}  ${v}  ${String(real01).padStart(6)} ${String(real02).padStart(6)} ${String(dep).padStart(3)}  ${f('第一').padEnd(4)} ${f('第二').padEnd(4)} ${f('第三').padEnd(4)} ${f('第四').padEnd(4)}`
  );
  if (r.schema_version === 3) {
    firstV3 ??= r;
    lastV3 = r;
  }
}

console.log(`\n=== サマリ ===`);
console.log(`schema v3 tick数: ${rows.filter(r => r.schema_version === 3).length} / ${rows.length}`);
console.log(`departures 合計: ${totalDep}`);
if (firstV3 && lastV3 && firstV3.tick_seq !== lastV3.tick_seq) {
  const minutes = (new Date(lastV3.ts) - new Date(firstV3.ts)) / 60000;
  console.log(`v3観測期間: ${minutes.toFixed(1)} 分 (tick_seq ${firstV3.tick_seq} → ${lastV3.tick_seq})`);
  console.log(`出庫レート: ${(totalDep / Math.max(minutes, 1)).toFixed(2)} 出庫/分`);
}
console.log(`\n注: '*' = front_row_occupied true / '4*' = 4台でfront_row埋まっている`);
