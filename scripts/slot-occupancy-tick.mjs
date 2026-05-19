#!/usr/bin/env node
// 60秒tick: 各乗り場のスロット領域を画像解析し在/不在を判定、
// 乗り場別の在台数を data/slot-occupancy-history.jsonl に追記する。
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { Jimp } from 'jimp';
import { analyzeROI } from './lib/image-pool-analyzer.mjs';
import { slotOccupied, slotsForStall, countStallOccupancy, DEFAULT_EDGE_THRESHOLD }
  from './lib/slot-occupancy.mjs';

const TTC_BASE = 'https://ttc.taxi-inf.jp';
const SLOTS_PATH = './scripts/lib/stall-slots.json';
const OUTPUT_PATH = './data/slot-occupancy-history.jsonl';
const STALLS = ['stall1', 'stall2', 'stall3', 'stall4'];

function jstNowIso() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
}

async function fetchJimp(name) {
  const res = await fetch(`${TTC_BASE}/${name}.jpg`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Jimp.read(Buffer.from(await res.arrayBuffer()));
}

// スロット {cx,cy,r}(正規化) → analyzeROI 用ピクセル roi
function slotRoi(slot, w, h) {
  return {
    x: Math.round((slot.cx - slot.r) * w),
    y: Math.round((slot.cy - slot.r) * h),
    width: Math.round(slot.r * 2 * w),
    height: Math.round(slot.r * 2 * h),
  };
}

async function main() {
  if (!existsSync(SLOTS_PATH)) {
    console.error('[slot] stall-slots.json なし、skip');
    return;
  }
  const cfg = JSON.parse(readFileSync(SLOTS_PATH, 'utf8'));
  const threshold = (cfg._meta && cfg._meta.edge_threshold) || DEFAULT_EDGE_THRESHOLD;
  // 必要なカメラを集める
  const cameras = {};
  for (const name of STALLS) {
    const src = cfg.stalls?.[name]?.source;
    if (src && !cameras[src]) cameras[src] = null;
  }
  try {
    for (const cam of Object.keys(cameras)) {
      // source 名 'real01_line' → 画像名 'Real01_line'
      const imgName = cam.split('_').map((p, i) =>
        i === 0 ? p[0].toUpperCase() + p.slice(1) : p).join('_');
      cameras[cam] = await fetchJimp(imgName);
    }
  } catch (e) {
    console.error(`[slot] image fetch failed, skip tick: ${e.message}`);
    return;
  }
  const row = { schema_version: 1, ts: jstNowIso(), stalls: {} };
  for (const name of STALLS) {
    const st = cfg.stalls?.[name];
    if (!st) continue;
    const img = cameras[st.source];
    if (!img) continue;
    const { width, height } = img.bitmap;
    const occupiedById = {};
    for (const slot of slotsForStall(cfg, name)) {
      const feat = await analyzeROI(img, slotRoi(slot, width, height));
      occupiedById[slot.id] = slotOccupied(feat, threshold);
    }
    row.stalls[name] = {
      occ: countStallOccupancy(occupiedById, slotsForStall(cfg, name)),
      slots: occupiedById,
    };
  }
  appendFileSync(OUTPUT_PATH, JSON.stringify(row) + '\n', 'utf8');
  const summary = STALLS.map(n => `${n}=${row.stalls[n]?.occ ?? '-'}`).join(' ');
  console.log(`[slot] ok: ${summary}`);
}

main();
