#!/usr/bin/env node
// T3 第5乗り場 slot-occupancy tick: Real106/107 を取得し、18マスの在/不在を
// 画像解析で判定、 t3-slot-occupancy-history.jsonl に 1 行追記する。
//
// CLI: `node scripts/t3-slot-occupancy-tick.mjs`
// import: `import { runT3SlotOccupancyTick } from './t3-slot-occupancy-tick.mjs'`
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { Jimp } from 'jimp';
import { analyzeROI } from './lib/image-pool-analyzer.mjs';
import {
  slotOccupied, DEFAULT_EDGE_THRESHOLD, DEFAULT_NIGHT_LANTERN_RATIO,
  NIGHT_BRIGHTNESS_THRESHOLD, isFrameAbnormal, expandRoiVertical,
} from './lib/slot-occupancy.mjs';
import { parseT3SlotConfig, summarizeT3Occupancy } from './lib/t3-occupancy-helpers.mjs';

const TTC_BASE = 'https://ttc.taxi-inf.jp';
const DEFAULT_SLOTS_PATH = './scripts/lib/t3-stall-slots.json';
const DEFAULT_HISTORY_PATH = './data/t3-slot-occupancy-history.jsonl';

function jstNowIso() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
}

async function fetchBuffer(name) {
  const res = await fetch(`${TTC_BASE}/${name}.jpg`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function avgBrightness(img) {
  const { data } = img.bitmap;
  let sum = 0, count = 0;
  for (let i = 0; i < data.length; i += 4 * 50) {
    sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    count += 1;
  }
  return count > 0 ? sum / count : 0;
}

// 'real106' → 'Real106' のような画像名変換（slot-occupancy-tick.mjs と同形）
function cameraToImageName(cam) {
  return cam.split('_').map((p, i) =>
    i === 0 ? p[0].toUpperCase() + p.slice(1) : p).join('_');
}

function slotRoi(slot, w, h) {
  return {
    x: Math.round((slot.cx - slot.r) * w),
    y: Math.round((slot.cy - slot.r) * h),
    width: Math.round(slot.r * 2 * w),
    height: Math.round(slot.r * 2 * h),
  };
}

/**
 * T3 slot-occupancy tick の本体。CLI からも observe-taxi-pool.mjs からも呼べる。
 * @param {object} [options]
 * @param {string} [options.cfgPath]
 * @param {string} [options.historyPath]
 * @returns {Promise<{ok:boolean, reason?:string, occ?:number}>}
 */
export async function runT3SlotOccupancyTick(options = {}) {
  const cfgPath = options.cfgPath || DEFAULT_SLOTS_PATH;
  const historyPath = options.historyPath || DEFAULT_HISTORY_PATH;
  if (!existsSync(cfgPath)) {
    return { ok: false, reason: 't3-stall-slots.json missing' };
  }
  const cfg = parseT3SlotConfig(JSON.parse(readFileSync(cfgPath, 'utf8')));
  const camName = cfg.source; // 'real106'
  // 画像取得
  let img;
  try {
    const buf = await fetchBuffer(cameraToImageName(camName));
    img = await Jimp.read(buf);
  } catch (e) {
    return { ok: false, reason: `fetch failed: ${e.message}` };
  }
  // 異常フレーム検出
  const avg = avgBrightness(img);
  if (isFrameAbnormal(avg)) {
    return { ok: false, reason: `abnormal frame (avg=${avg.toFixed(1)})` };
  }
  const isNight = avg < (cfg.meta.night_brightness_threshold ?? NIGHT_BRIGHTNESS_THRESHOLD);
  const mode = isNight ? 'night' : 'day';
  const edgeThreshold = cfg.meta.edge_threshold ?? DEFAULT_EDGE_THRESHOLD;
  const nightLanternRatio = cfg.meta.night_lantern_ratio ?? DEFAULT_NIGHT_LANTERN_RATIO;
  const { width, height } = img.bitmap;
  const occupiedById = {};
  for (const slot of cfg.slots) {
    const baseRoi = slotRoi(slot, width, height);
    // 座標プレースホルダー (r=0) の場合 width/height=0 → analyzeROI が undefined を返す可能性
    // その場合 slotOccupied は features を見て false を返す（既存挙動）
    if (baseRoi.width <= 0 || baseRoi.height <= 0) {
      occupiedById[slot.id] = false;
      continue;
    }
    const roi = isNight ? expandRoiVertical(baseRoi, 2, width, height) : baseRoi;
    const feat = await analyzeROI(img, roi);
    occupiedById[slot.id] = slotOccupied(feat, {
      edgeThreshold, isNight, nightLanternRatio,
    });
  }
  const summary = summarizeT3Occupancy(cfg.slots, occupiedById);
  const row = {
    schema_version: 1,
    ts: jstNowIso(),
    mode,
    stalls: {
      t3_stand: {
        occ: summary.total,
        row1: summary.row1,
        row2: summary.row2,
        slots: occupiedById,
      },
    },
  };
  appendFileSync(historyPath, JSON.stringify(row) + '\n', 'utf8');
  return { ok: true, occ: summary.total, row1: summary.row1, row2: summary.row2, mode };
}

// CLI 単独実行用 main
if (import.meta.url === `file://${process.argv[1]}`) {
  runT3SlotOccupancyTick().then(result => {
    if (result.ok) {
      console.log(`[t3-slot] ok: total=${result.occ} row1=${result.row1} row2=${result.row2} mode=${result.mode}`);
    } else {
      console.error(`[t3-slot] skip: ${result.reason}`);
      process.exit(0); // skip は exit 0（launchd ジョブの retry を待たない）
    }
  }).catch(e => {
    console.error(`[t3-slot] fatal: ${e.message}`);
    process.exit(0);
  });
}
