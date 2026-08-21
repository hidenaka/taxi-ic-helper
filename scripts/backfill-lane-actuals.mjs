#!/usr/bin/env node
// backfill-lane-actuals — 現地掲示の履歴(pool-notice-history.jsonl)から
// 「その便が実際にどの号に着いたか」の実績を再構築し data/lane-actuals.jsonl に書く。
//
// 掲示は毎晩そのとき限りで消えるため、実績として残さないと学習できない。
// 既存の履歴(2026-06〜)を一度で遡り、以後は observe ループが追記する。
//
// 使い方:
//   node scripts/backfill-lane-actuals.mjs           # dry-run(件数と学習結果の要約のみ)
//   node scripts/backfill-lane-actuals.mjs --write   # data/lane-actuals.jsonl を作り直す

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseFlightNotice } from './lib/notice-flights.mjs';
import { extractLaneActuals, dedupeActuals, learnByFlight, learnByFlightBand, learnByPattern } from './lib/lane-actuals.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HIST = join(ROOT, 'data/pool-notice-history.jsonl');
const OUT = join(ROOT, 'data/lane-actuals.jsonl');
const write = process.argv.includes('--write');

if (!existsSync(HIST)) {
  console.error('[backfill-lane] 掲示履歴が無い: ' + HIST);
  process.exit(0);
}

const rows = [];
let noticeRows = 0;
for (const line of readFileSync(HIST, 'utf8').trim().split('\n')) {
  let r;
  try { r = JSON.parse(line); } catch { continue; }
  if (!r.hasFlightNotice || !r.flightNoticeText) continue;
  noticeRows += 1;
  const parsed = parseFlightNotice(r.flightNoticeText);
  rows.push(...extractLaneActuals(r, parsed));
}
// 手動復元行(便名なし掲示を到着便データと突き合わせて人手で確定したもの等)は
// パーサでは再現できないので、既存ファイルから引き継ぐ(後勝ち=手動行が優先)
let preserved = [];
if (existsSync(OUT)) {
  preserved = readFileSync(OUT, 'utf8').trim().split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.source && r.source !== 'notice');
}
const actuals = dedupeActuals([...rows, ...preserved]);
console.log(`[backfill-lane] 掲示行 ${noticeRows} → 実績 ${actuals.length}件 (便番号+号が揃ったもの)`);
if (actuals.length) {
  console.log(`  期間: ${actuals[0].date} 〜 ${actuals[actuals.length - 1].date}`);
}

const byFlight = learnByFlight(actuals);
const byFlightBand = learnByFlightBand(actuals);
const byPattern = learnByPattern(actuals);
console.log(`\n[A] 便別に傾向が出た便: ${Object.keys(byFlight).length}`);
for (const [fno, e] of Object.entries(byFlight).sort((a, b) => b[1].n - a[1].n)) {
  const dist = Object.entries(e.dist).map(([k, v]) => `${k}号×${v}`).join(' ');
  console.log(`  ${fno.padEnd(8)} ${e.n}回 → 最多${e.stall}号 (${Math.round(e.share * 100)}%) [${dist}] 最終${e.lastDate}`);
}
console.log(`\n[A'] 便×時間帯で傾向が出た組合せ: ${Object.keys(byFlightBand).length}`);
for (const [key, e] of Object.entries(byFlightBand).sort((a, b) => b[1].n - a[1].n)) {
  const dist = Object.entries(e.dist).map(([k, v]) => `${k}号×${v}`).join(' ');
  console.log(`  ${key.padEnd(16)} ${e.n}回 → ${e.stall}号 (${Math.round(e.share * 100)}%) [${dist}]`);
}
console.log(`\n[B] パターン別に傾向が出た組合せ: ${Object.keys(byPattern).length}`);
for (const [key, e] of Object.entries(byPattern).sort((a, b) => b[1].n - a[1].n)) {
  const dist = Object.entries(e.dist).map(([k, v]) => `${k}号×${v}`).join(' ');
  console.log(`  ${key.padEnd(14)} ${e.n}回 → 最多${e.stall}号 (${Math.round(e.share * 100)}%) [${dist}]`);
}

// 号の分布(全体像)
const all = {};
for (const r of actuals) all[r.stall] = (all[r.stall] || 0) + 1;
console.log('\n実績全体の号分布: ' + Object.entries(all).sort().map(([k, v]) => `${k}号:${v}`).join(' '));

if (write) {
  writeFileSync(OUT, actuals.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`\n[backfill-lane] 書き出し: ${OUT}`);
} else {
  console.log('\n[backfill-lane] dry-run (書き出しは --write)');
}
