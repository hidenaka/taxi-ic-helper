#!/usr/bin/env node
// backfill-advance-history — 過去アーカイブ画像から「15分×乗り場」の前進カウント履歴を生成する。
// 予測の学習データ兼、15分指標の検証用。data/advance-count-history.jsonl に書き出す(上書き)。
//
// 使い方: node scripts/backfill-advance-history.mjs [thr=8] [startHour=6] [endHour=24]
// 注意: 各乗り場は cfg.source のカメラ。昼は信頼高・夜(行灯)は少なめに出る(計測都合)。

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { Jimp } from 'jimp';
import { frontBox, meanGrayInBox, detectReplenishments } from './lib/advance-counter.mjs';

// binCountsByWindow と同等(デプロイ済みモジュールに無くても単独実行できるよう内蔵)。
// 正本は scripts/lib/advance-counter.mjs(TDD済)。
function binCountsByWindow(eventTimes, windowSec, originSec = 0) {
  const out = {};
  for (const t of eventTimes) {
    const start = originSec + Math.floor((t - originSec) / windowSec) * windowSec;
    out[start] = (out[start] || 0) + 1;
  }
  return out;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(ROOT, 'scripts/lib/stall-slots.json'), 'utf8'));
const OUT = join(ROOT, 'data/advance-count-history.jsonl');
const ARCHIVE_ROOT = join(os.homedir(), 'taxi-image-archive');
const THR = Number(process.argv[2] ?? 15); // 夜の行灯フリッカ抑制込みで昼夜共通(検証で最良)
const START_H = Number(process.argv[3] ?? 6);
const END_H = Number(process.argv[4] ?? 24);
const STEP = 60;
const N_FRONT = 6;
const BIN = 900; // 15分
const DEBOUNCE = 120;

const stalls = Object.entries(cfg.stalls).filter(([, d]) => Array.isArray(d.slots) && d.slots.length >= 3);
// カメラ別に乗り場をまとめる
const byCamera = {};
for (const [name, def] of stalls) {
  const cam = String(def.source).includes('real02') ? 'real02' : 'real01_line';
  (byCamera[cam] = byCamera[cam] || []).push(name);
}
const fsec = (f) => { const m = f.match(/^(\d{2})(\d{2})(\d{2})\.jpg$/); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : -1; };
const jstEpoch = (day, secOfDay) => Math.floor(new Date(`${day}T00:00:00+09:00`).getTime() / 1000) + secOfDay;
const jstIso = (epoch) => { const z = (n) => String(n).padStart(2, '0'); const j = new Date((epoch + 9 * 3600) * 1000); return `${j.getUTCFullYear()}-${z(j.getUTCMonth() + 1)}-${z(j.getUTCDate())}T${z(j.getUTCHours())}:${z(j.getUTCMinutes())}:00+09:00`; };

const days = existsSync(join(ARCHIVE_ROOT, 'real01_line'))
  ? readdirSync(join(ARCHIVE_ROOT, 'real01_line')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
  : [];

const lines = [];
for (const day of days) {
  const midnight = jstEpoch(day, 0);
  // day -> { binStartEpoch -> {stall:count} }
  const dayBins = {};
  for (const [cam, names] of Object.entries(byCamera)) {
    const dir = join(ARCHIVE_ROOT, cam, day);
    if (!existsSync(dir)) continue;
    const s0 = START_H * 3600;
    const e0 = END_H * 3600;
    let next = s0;
    const frames = readdirSync(dir).filter((f) => f.endsWith('.jpg')).map((f) => ({ f, s: fsec(f) }))
      .filter((x) => x.s >= s0 && x.s < e0).sort((a, b) => a.s - b.s);
    const picked = [];
    for (const x of frames) { if (x.s >= next) { picked.push(x); next = x.s + STEP; } }
    if (picked.length < 10) continue;
    const ser = Object.fromEntries(names.map((n) => [n, { t: [], v: [] }]));
    for (const { f, s } of picked) {
      let img;
      try { img = await Jimp.read(join(dir, f)); } catch { continue; }
      const epoch = jstEpoch(day, s);
      for (const n of names) {
        ser[n].t.push(epoch);
        ser[n].v.push(meanGrayInBox(img, frontBox(cfg.stalls[n].slots, N_FRONT), 3));
      }
    }
    for (const n of names) {
      // 補充エッジ方式: 平滑化(内蔵)→手薄→補充の立ち上がりだけを持続条件つきで数える。
      const { eventTimes } = detectReplenishments(ser[n].v, ser[n].t, { absThreshold: THR, debounceSec: DEBOUNCE });
      const bins = binCountsByWindow(eventTimes, BIN, midnight);
      for (const [start, count] of Object.entries(bins)) {
        (dayBins[start] = dayBins[start] || {})[n] = count;
      }
    }
  }
  const binStarts = Object.keys(dayBins).map(Number).sort((a, b) => a - b);
  for (const start of binStarts) {
    lines.push(JSON.stringify({ schema_version: 1, ts: jstIso(start), stalls: dayBins[start] }));
  }
  console.log(`[backfill] ${day}: ${binStarts.length} bins`);
}
writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`[backfill] wrote ${lines.length} rows -> ${OUT}`);
