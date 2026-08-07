#!/usr/bin/env node
// rebuild-advance-count-history — 列移動カウント履歴を movement-shift/slot-occupancy の
// 生履歴から現行ルールで再構築する。
//
// 用途: カウント規則を変えたとき(例: 2026-08-08 のfall先行ペア条件+運用時間ゲート)に、
// 過去ぶんの advance-count-history.jsonl を新規則で作り直し、時間帯目安(通常基準)の
// 学習データを新旧混在させないため。
//
// 実行(Mac mini):
//   node scripts/rebuild-advance-count-history.mjs           # dry-run(件数比較のみ)
//   node scripts/rebuild-advance-count-history.mjs --write   # .bak退避して書き換え
//
// 旧ファイルは advance-count-history.bak.<epoch>.jsonl に退避する。

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { binAdvanceCounts, medianOccForBin } from './lib/advance-forecast.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MS = join(ROOT, 'data/movement-shift-history.jsonl');
const OCC = join(ROOT, 'data/slot-occupancy-history.jsonl');
const OUT = join(ROOT, 'data/advance-count-history.jsonl');
const THR = 8;               // publish-advance-forecast と同じ
const PAIR_WINDOW_SEC = 360; // fall先行ペア条件
const STALLS = ['stall1', 'stall2', 'stall3', 'stall4'];
const BIN = 900;

const write = process.argv.includes('--write');

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function epochToJstIso(ep) {
  const z = (n) => String(n).padStart(2, '0');
  const j = new Date((ep + 9 * 3600) * 1000);
  return `${j.getUTCFullYear()}-${z(j.getUTCMonth() + 1)}-${z(j.getUTCDate())}T${z(j.getUTCHours())}:${z(j.getUTCMinutes())}:00+09:00`;
}

const ep = (r) => Math.floor(new Date(r.ts).getTime() / 1000);
const msRows = readJsonl(MS).map((r) => ({ ...r, e: ep(r) }))
  .filter((r) => Number.isFinite(r.e)).sort((a, b) => a.e - b.e);
const occRows = readJsonl(OCC).map((r) => ({ ...r, e: ep(r) })).filter((r) => Number.isFinite(r.e));
const oldRows = readJsonl(OUT);
console.log(`[rebuild] ms=${msRows.length} occ=${occRows.length} 旧advance=${oldRows.length}`);

// 完成ビンのみ(現在進行中ビンは対象外)
const first = Math.ceil(msRows[0].e / BIN) * BIN;
const last = Math.floor(Date.now() / 1000 / BIN) * BIN - BIN;

// occRows をビンごとに引けるよう座標化(全走査を避ける)
let occIdx = 0;
const rebuilt = [];
let msIdx = 0;
for (let bs = first; bs <= last; bs += BIN) {
  // 該当窓の行(ペア文脈ぶん遡る)
  while (msIdx < msRows.length && msRows[msIdx].e < bs - PAIR_WINDOW_SEC) msIdx++;
  const rows = [];
  for (let i = msIdx; i < msRows.length && msRows[i].e < bs + BIN; i++) rows.push(msRows[i]);
  const binRows = rows.filter((r) => r.e >= bs);
  if (binRows.length < 2) continue; // 観測なしビンは(従来同様)出力しない
  while (occIdx < occRows.length && occRows[occIdx].e < bs - 300) occIdx++;
  const occWin = [];
  for (let i = occIdx; i < occRows.length && occRows[i].e < bs + BIN + 300; i++) occWin.push(occRows[i]);
  const occByStall = medianOccForBin(occWin, STALLS, bs, bs + BIN);
  const stalls = binAdvanceCounts(rows, STALLS, {
    absThreshold: THR, debounceSec: 120, occByStall, occRows: occWin,
    pairWindowSec: PAIR_WINDOW_SEC, countAfterEpoch: bs,
  });
  rebuilt.push({ ts: epochToJstIso(bs), stalls });
}

const sum = (rows) => {
  const t = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.stalls || {})) t[k] = (t[k] || 0) + v;
  return t;
};
console.log('[rebuild] 旧合計:', JSON.stringify(sum(oldRows)));
console.log('[rebuild] 新合計:', JSON.stringify(sum(rebuilt)), `(${rebuilt.length}ビン)`);

if (write) {
  if (existsSync(OUT)) {
    const bak = OUT.replace(/\.jsonl$/, `.bak.${Math.floor(Date.now() / 1000)}.jsonl`);
    copyFileSync(OUT, bak);
    console.log(`[rebuild] 旧ファイル退避: ${bak}`);
  }
  writeFileSync(OUT, rebuilt.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`[rebuild] 書き換え完了: ${OUT}`);
} else {
  console.log('[rebuild] dry-run(書き換えは --write)');
}
