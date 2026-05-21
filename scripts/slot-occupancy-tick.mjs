#!/usr/bin/env node
// 60秒tick: 各乗り場のスロット領域を画像解析し在/不在を判定、
// 乗り場別の在台数を data/slot-occupancy-history.jsonl に追記する。
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { Jimp } from 'jimp';
import { analyzeROI } from './lib/image-pool-analyzer.mjs';
import { slotOccupied, slotsForStall, countStallOccupancy, DEFAULT_EDGE_THRESHOLD, DEFAULT_NIGHT_LANTERN_RATIO, NIGHT_BRIGHTNESS_THRESHOLD, isFrameAbnormal, expandRoiVertical, nightLanternRatioForWeather, edgeThresholdForWeather }
  from './lib/slot-occupancy.mjs';
import { saveArchive } from './lib/slot-archive.mjs';

const TTC_BASE = 'https://ttc.taxi-inf.jp';
const SLOTS_PATH = './scripts/lib/stall-slots.json';
const OUTPUT_PATH = './data/slot-occupancy-history.jsonl';

function jstNowIso() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
}

async function fetchBuffer(name) {
  const res = await fetch(`${TTC_BASE}/${name}.jpg`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// 画像全体の平均輝度を 50px 間隔でサンプリングして返す。
// isFrameAbnormal 用と 夜判定 用の両方で再利用。
function avgBrightness(img) {
  const { data } = img.bitmap;
  let sum = 0, count = 0;
  for (let i = 0; i < data.length; i += 4 * 50) {
    sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
    count += 1;
  }
  return count > 0 ? sum / count : 0;
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
  const STALLS = Object.keys(cfg.stalls || {});
  const globalThreshold = (cfg._meta && cfg._meta.edge_threshold) || DEFAULT_EDGE_THRESHOLD;
  // 雨天時の路面反射ノイズ対策: weather.json の降水量で lantern しきい値を調整。
  let precipitation = null;
  try {
    const w = JSON.parse(readFileSync('./data/weather.json', 'utf8'));
    precipitation = w.current?.precipitation ?? null;
  } catch { /* weather 無し時は補正なし */ }
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
      const buf = await fetchBuffer(imgName);
      await saveArchive(cam, buf, new Date());
      cameras[cam] = await Jimp.read(buf);
    }
  } catch (e) {
    console.error(`[slot] image fetch failed, skip tick: ${e.message}`);
    return;
  }
  // カメラごとの brightness を計算し、 異常フレームは tick 全体 skip。
  // 同時に「夜モード」判定を保持する。
  const cameraIsNight = {};
  for (const cam of Object.keys(cameras)) {
    const avg = avgBrightness(cameras[cam]);
    if (isFrameAbnormal(avg)) {
      console.error(`[slot] abnormal frame for ${cam} (avg=${avg.toFixed(1)}), skip tick`);
      return;
    }
    cameraIsNight[cam] = avg < (cfg._meta?.night_brightness_threshold ?? NIGHT_BRIGHTNESS_THRESHOLD);
  }
  // mode = 'night' if real01_line camera is night, else 'day'.
  // computeSlotActuals が mode 切替 tick の差分を 0 扱いするのに使う。
  // (slot-actuals は stall1-4 + stall4_back を集計するが、 stall4_back の
  // real02 camera は別 brightness。 多くの場合は同じ夜/昼判定なので
  // real01_line を mode の代表値として使う。)
  const mode = cameraIsNight['real01_line'] ? 'night' : 'day';
  const row = { schema_version: 1, ts: jstNowIso(), mode, stalls: {} };
  for (const name of STALLS) {
    const st = cfg.stalls?.[name];
    if (!st) continue;
    const img = cameras[st.source];
    if (!img) continue;
    const { width, height } = img.bitmap;
    const baseStallThreshold = (typeof st.edge_threshold === 'number') ? st.edge_threshold : globalThreshold;
    const stallThreshold = edgeThresholdForWeather(baseStallThreshold, precipitation);
    // stall に detection_mode: "lantern" 指定があれば 24時間 lantern 検出。
    // 画像遠方 (stall1/2) で r=0.010 の小 ROI では 昼の edge_density 検出が
    // 機能せず常時 14 で動かない問題に対応。 屋根上の点光源で 出入りを捕捉。
    const isNight = (st.detection_mode === 'lantern') || cameraIsNight[st.source];
    const baseLanternRatio = cfg._meta?.night_lantern_ratio ?? DEFAULT_NIGHT_LANTERN_RATIO;
    const nightLanternRatio = nightLanternRatioForWeather(baseLanternRatio, precipitation);
    const occupiedById = {};
    for (const slot of slotsForStall(cfg, name)) {
      const baseRoi = slotRoi(slot, width, height);
      // 夜は ROI を縦×2 に拡張して屋根上 (行灯位置) も含める。
      const roi = isNight ? expandRoiVertical(baseRoi, 2, width, height) : baseRoi;
      const feat = await analyzeROI(img, roi);
      occupiedById[slot.id] = slotOccupied(feat, {
        edgeThreshold: stallThreshold,
        isNight,
        nightLanternRatio,
      });
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
