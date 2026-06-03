#!/usr/bin/env node
// learn-arrival-advance — 段階B。
// 到着需要ログ(arrival-demand-history.jsonl)と実測列移動(advance-count-history.jsonl)から
// 乗り場ごとの「到着→列移動のラグ(15分バケット数)」を学習し data/arrival-advance-coeffs.json に出力。
// データが少ない/相関が弱い乗り場は applied:false(lag0=従来動作)。
// publish-advance-forecast がこの係数を読んで lag を適用する。日次など低頻度で回せばよい。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { learnArrivalLag } from './lib/advance-forecast.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEMAND = join(ROOT, 'data/arrival-demand-history.jsonl');
const ADV = join(ROOT, 'data/advance-count-history.jsonl');
const OUT = join(ROOT, 'data/arrival-advance-coeffs.json');
const STALLS = ['stall1', 'stall2', 'stall3', 'stall4'];

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const demandRows = readJsonl(DEMAND);
const advRows = readJsonl(ADV);
if (demandRows.length === 0) {
  console.error('[learn] 到着需要ログがまだ無い(publish-advance-forecast が貯め始めてから)。skip。');
  process.exit(0);
}

const learned = learnArrivalLag(demandRows, advRows, { stalls: STALLS, maxLag: 6, minSamples: 24, minCorr: 0.2 });
const out = {
  schema_version: 1,
  generatedAt: new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('Z', '+09:00'),
  demandRows: demandRows.length,
  advanceRows: advRows.length,
  coeffs: learned.coeffs,
};
writeFileSync(OUT, JSON.stringify(out, null, 2));
const summary = STALLS.map((s) => `${s}=lag${learned.coeffs[s].lag}${learned.coeffs[s].applied ? '' : '(未適用)'}/r${learned.coeffs[s].corr}/n${learned.coeffs[s].n}`).join(' ');
console.log(`[learn] ${summary} -> ${OUT}`);
