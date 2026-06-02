#!/usr/bin/env node
// publish-advance-forecast — 前進カウント履歴からモデルを作り、乗り場別・15分ごとの
// 予測前進回数カーブを data/advance-forecast.json に出力する。
// 表示(日報tools)が「次の15分: 予測◯回」を読むためのソース。台数とは別物・少なめに出る。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildAdvanceModel, predictAdvance } from './lib/advance-forecast.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HIST = join(ROOT, 'data/advance-count-history.jsonl');
const OUT = join(ROOT, 'data/advance-forecast.json');
const STALLS = ['stall1', 'stall2', 'stall3', 'stall4'];

function jstNowIso() {
  const z = (n) => String(n).padStart(2, '0');
  const j = new Date(Date.now() + 9 * 3600 * 1000);
  return `${j.getUTCFullYear()}-${z(j.getUTCMonth() + 1)}-${z(j.getUTCDate())}T${z(j.getUTCHours())}:${z(j.getUTCMinutes())}:00+09:00`;
}

if (!existsSync(HIST)) { console.error('履歴なし(backfill未実行?)'); process.exit(1); }
const rows = readFileSync(HIST, 'utf8').trim().split('\n')
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const model = buildAdvanceModel(rows);

// 96 バケット分の予測カーブ。観測のある時間帯のみ出力(夜明け前の空白は省く)。
const slots = [];
for (let b = 0; b < 96; b++) {
  const bk = model.buckets?.[b];
  if (!bk || bk.rows === 0) continue;
  const hh = String(Math.floor(b / 4)).padStart(2, '0');
  const mm = String((b % 4) * 15).padStart(2, '0');
  const ts = `2026-01-01T${hh}:${mm}:00+09:00`;
  const stalls = {};
  for (const s of STALLS) stalls[s] = Number(predictAdvance(model, ts, s).toFixed(1));
  slots.push({ time: `${hh}:${mm}`, stalls });
}

const out = {
  schema_version: 1,
  generatedAt: jstNowIso(),
  note: '15分あたりの予測前進回数(相対指標)。計測の都合で実際より少なめに出る。',
  trainedRows: rows.length,
  slots,
};
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`[advance-forecast] trained=${rows.length}rows slots=${slots.length} -> ${OUT}`);
// 妥当性サンプル: 代表的な時間帯の予測
for (const t of ['08:00', '13:00', '18:00', '22:00']) {
  const s = slots.find((x) => x.time === t);
  if (s) console.log(`  ${t}: ` + STALLS.map((n) => `${n}=${s.stalls[n]}`).join(' '));
}
