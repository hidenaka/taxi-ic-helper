#!/usr/bin/env node
// 過去の image-archive を時系列に reproc して slot-occupancy-history を再生成。
// 現在の判定ロジック (R除外 行灯検出 + ABN skip + 夜分岐) で全画像を再計算する。
//
// 使い方:
//   node scripts/replay-history-from-archive.mjs <archive_root> <YYYY-MM-DD> <out_path>
// 例:
//   node scripts/replay-history-from-archive.mjs ~/taxi-image-archive 2026-05-20 /tmp/replayed-history.jsonl

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Jimp } from 'jimp';
import { analyzeROI } from './lib/image-pool-analyzer.mjs';
import {
  slotOccupied, isFrameAbnormal, expandRoiVertical,
  DEFAULT_EDGE_THRESHOLD, DEFAULT_NIGHT_LANTERN_RATIO, NIGHT_BRIGHTNESS_THRESHOLD,
  countStallOccupancy, slotsForStall,
} from './lib/slot-occupancy.mjs';

const cfg = JSON.parse(readFileSync('./scripts/lib/stall-slots.json', 'utf8'));
const [archiveRoot, ymd, outPath] = process.argv.slice(2);
if (!archiveRoot || !ymd || !outPath) {
  console.error('usage: node scripts/replay-history-from-archive.mjs <archive_root> <YYYY-MM-DD> <out_path>');
  process.exit(1);
}

const STALLS = Object.keys(cfg.stalls);
const sources = [...new Set(STALLS.map(n => cfg.stalls[n].source))];
const globalThreshold = cfg._meta?.edge_threshold ?? DEFAULT_EDGE_THRESHOLD;
const globalNightLantern = cfg._meta?.night_lantern_ratio ?? DEFAULT_NIGHT_LANTERN_RATIO;
const globalNightBrightness = cfg._meta?.night_brightness_threshold ?? NIGHT_BRIGHTNESS_THRESHOLD;

function avgBrightness(img) {
  const { data } = img.bitmap;
  let sum = 0, count = 0;
  for (let i = 0; i < data.length; i += 4 * 50) {
    sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    count += 1;
  }
  return count > 0 ? sum / count : 0;
}

function slotRoi(slot, w, h) {
  return {
    x: Math.round((slot.cx - slot.r) * w),
    y: Math.round((slot.cy - slot.r) * h),
    width: Math.round(slot.r * 2 * w),
    height: Math.round(slot.r * 2 * h),
  };
}

// ファイル名 "HHMMSS.jpg" を秒に変換
function fnameToSec(f) {
  const h = parseInt(f.slice(0, 2), 10);
  const m = parseInt(f.slice(2, 4), 10);
  const s = parseInt(f.slice(4, 6), 10);
  return h * 3600 + m * 60 + s;
}

// 各 source の画像 ファイル名リスト
const fileLists = {};
for (const src of sources) {
  const dir = path.join(archiveRoot, src, ymd);
  if (!existsSync(dir)) {
    console.error(`[replay] missing archive dir: ${dir}`);
    fileLists[src] = [];
    continue;
  }
  fileLists[src] = readdirSync(dir).filter(f => /^\d{6}\.jpg$/.test(f)).sort();
}

// 主軸は最も多い source (通常 real01_line)
const primary = sources[0];
console.log(`[replay] primary source: ${primary}, files=${fileLists[primary].length}`);

// 副軸 (real02 等) を主軸の時刻に最も近い画像で対応付け
function findClosest(list, targetSec) {
  let best = null, bestDiff = Infinity;
  for (const f of list) {
    const d = Math.abs(fnameToSec(f) - targetSec);
    if (d < bestDiff) { bestDiff = d; best = f; }
  }
  return best;
}

const outLines = [];
let processed = 0;
let abnSkipped = 0;
let abnAt = [];
for (const pf of fileLists[primary]) {
  const ts = pf.slice(0, 6);
  const tsSec = fnameToSec(pf);
  const isoTs = `${ymd}T${ts.slice(0, 2)}:${ts.slice(2, 4)}:${ts.slice(4, 6)}+09:00`;

  // 各 source の画像をロード
  const imgs = {};
  let loadFailed = false;
  for (const src of sources) {
    const list = fileLists[src] || [];
    const matched = (src === primary) ? pf : findClosest(list, tsSec);
    if (!matched) { loadFailed = true; break; }
    try {
      imgs[src] = await Jimp.read(path.join(archiveRoot, src, ymd, matched));
    } catch {
      loadFailed = true; break;
    }
  }
  if (loadFailed) continue;

  // ABN チェック + 夜判定
  const cameraIsNight = {};
  let abn = false;
  for (const src of sources) {
    const avg = avgBrightness(imgs[src]);
    if (isFrameAbnormal(avg)) { abn = true; break; }
    cameraIsNight[src] = avg < globalNightBrightness;
  }
  if (abn) { abnSkipped++; abnAt.push(ts); continue; }

  // 各 stall の occ 計算
  const stalls = {};
  for (const name of STALLS) {
    const st = cfg.stalls[name];
    const img = imgs[st.source];
    if (!img) continue;
    const { width, height } = img.bitmap;
    const stallThreshold = (typeof st.edge_threshold === 'number') ? st.edge_threshold : globalThreshold;
    const isNight = cameraIsNight[st.source];
    const occupiedById = {};
    for (const slot of st.slots) {
      const baseRoi = slotRoi(slot, width, height);
      const roi = isNight ? expandRoiVertical(baseRoi, 2, width, height) : baseRoi;
      const feat = await analyzeROI(img, roi);
      occupiedById[slot.id] = slotOccupied(feat, {
        edgeThreshold: stallThreshold,
        isNight,
        nightLanternRatio: globalNightLantern,
      });
    }
    stalls[name] = {
      occ: countStallOccupancy(occupiedById, slotsForStall(cfg, name)),
      slots: occupiedById,
    };
  }
  const mode = cameraIsNight[primary] ? 'night' : 'day';
  outLines.push(JSON.stringify({ schema_version: 1, ts: isoTs, mode, stalls }));
  processed++;
  if (processed % 100 === 0) console.log(`[replay] processed ${processed}/${fileLists[primary].length}...`);
}

writeFileSync(outPath, outLines.join('\n') + '\n', 'utf8');
console.log(`[replay] done. ticks written: ${processed}, ABN skipped: ${abnSkipped}, out: ${outPath}`);
if (abnAt.length) console.log(`[replay] ABN at: ${abnAt.slice(0, 10).join(', ')}${abnAt.length > 10 ? ` (+${abnAt.length - 10} more)` : ''}`);
