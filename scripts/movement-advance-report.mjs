#!/usr/bin/env node
// movement-advance-report — シャドウ観測ログ(movement-shift-history.jsonl)の
// 先頭面密度(frontDensity)から、乗り場ごとの「前進カウント」を集計して表示する。
// 台数とは突き合わせない。混む乗り場ほど多く出る相対フロー指標(昼で実証済)。
//
// 使い方: node scripts/movement-advance-report.mjs [absThreshold=8] [debounceSec=120]
// 注意: 夜(行灯)は別しきい値が要る。まずは昼向けに既定 8。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { detectAdvances } from './lib/advance-counter.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY_PATH = join(ROOT, 'data/movement-shift-history.jsonl');
const ABS = Number(process.argv[2] ?? 8);
const DEBOUNCE = Number(process.argv[3] ?? 120);

function tsToEpochSec(ts) {
  return Math.floor(new Date(ts).getTime() / 1000);
}
function jstHourKey(ts) {
  return ts.slice(0, 13); // "YYYY-MM-DDTHH"
}

const rows = readFileSync(HISTORY_PATH, 'utf8').trim().split('\n')
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean)
  .filter((r) => r.stalls && Object.values(r.stalls).some((s) => typeof s.frontDensity === 'number'));

if (rows.length === 0) {
  console.log('frontDensity を含む行がまだありません(schema v2 の tick 蓄積待ち)。');
  process.exit(0);
}

const stallNames = [...new Set(rows.flatMap((r) => Object.keys(r.stalls)))];
console.log(`期間: ${rows[0].ts} 〜 ${rows[rows.length - 1].ts}  行数=${rows.length}  thr=${ABS} debounce=${DEBOUNCE}s`);

for (const name of stallNames) {
  const times = [];
  const values = [];
  for (const r of rows) {
    const fd = r.stalls?.[name]?.frontDensity;
    if (typeof fd === 'number') { times.push(tsToEpochSec(r.ts)); values.push(fd); }
  }
  if (values.length < 3) { console.log(`\n== ${name} == データ不足`); continue; }
  const { count, eventTimes } = detectAdvances(values, times, { absThreshold: ABS, debounceSec: DEBOUNCE });
  // 時間帯別
  const evSet = new Set(eventTimes);
  const hist = {};
  for (let k = 0; k < times.length; k++) {
    if (evSet.has(times[k])) {
      const r = rows.find((rr) => tsToEpochSec(rr.ts) === times[k]);
      const h = r ? jstHourKey(r.ts) : '?';
      hist[h] = (hist[h] || 0) + 1;
    }
  }
  const span = (times[times.length - 1] - times[0]) / 3600 || 1;
  const histStr = Object.keys(hist).sort().map((h) => `${h.slice(11)}:${hist[h]}`).join(' ');
  console.log(`\n== ${name} == 前進カウント計=${count}  (${(count / span).toFixed(1)}回/時)`);
  if (histStr) console.log(`  時間帯別: ${histStr}`);
}
