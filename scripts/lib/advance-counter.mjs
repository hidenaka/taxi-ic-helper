// advance-counter — 「前進/補充カウント」b5方式の核心。
// 乗り場の先頭エリア(面)の輝度を時系列で見て、全乗り場 共通の絶対しきい値を超える
// 状態の切り替わりを「前進イベント」として debounce 付きで数える。
// 台数とは突き合わせない。混む乗り場ほど多く出る相対フロー指標(昼で実証)。

import { jimpLumSampler } from './movement-shift.mjs';

/**
 * 順序付きスロット(先頭→末尾)の先頭 nFront 個の外接矩形(正規化座標)。
 * @param {{cx:number,cy:number}[]} slots
 * @param {number} nFront
 * @returns {{x0:number,x1:number,y0:number,y1:number}}
 */
export function frontBox(slots, nFront) {
  const fs = slots.slice(0, Math.min(nFront, slots.length));
  const xs = fs.map((s) => s.cx);
  const ys = fs.map((s) => s.cy);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/**
 * Jimp 画像の正規化ボックス領域の平均輝度。pad は画素単位の外側マージン。
 * @returns {number}
 */
export function meanGrayInBox(img, box, pad = 3) {
  const { width, height } = img.bitmap;
  const getLum = jimpLumSampler(img);
  const px0 = Math.max(0, Math.floor(box.x0 * (width - 1)) - pad);
  const px1 = Math.min(width - 1, Math.ceil(box.x1 * (width - 1)) + pad);
  const py0 = Math.max(0, Math.floor(box.y0 * (height - 1)) - pad);
  const py1 = Math.min(height - 1, Math.ceil(box.y1 * (height - 1)) + pad);
  let sum = 0;
  let n = 0;
  for (let y = py0; y <= py1; y++) {
    for (let x = px0; x <= px1; x++) {
      sum += getLum(x, y);
      n++;
    }
  }
  return n ? sum / n : 0;
}

/**
 * 先頭面密度の時系列から「前進/補充イベント」を数える。
 * 現在の基準レベル lvl から absThreshold 以上動いたら 1 イベント(方向は問わない)。
 * 直前イベントから debounceSec 未満なら数えない(連続変化の重複防止)。
 * 同レベル内の緩やかなドリフトは lvl に追従させる。
 * @param {number[]} values フレームごとの先頭面密度
 * @param {number[]} times  対応する epoch 秒(昇順)
 * @param {{absThreshold:number, debounceSec:number}} opts
 * @returns {{count:number, eventTimes:number[]}}
 */
export function detectAdvances(values, times, opts) {
  const absThreshold = opts.absThreshold;
  const debounceSec = opts.debounceSec ?? 120;
  let count = 0;
  const eventTimes = [];
  if (!values || values.length === 0) return { count, eventTimes };
  let lvl = values[0];
  let lastEvent = -Infinity;
  for (let i = 1; i < values.length; i++) {
    const d = Math.abs(values[i] - lvl);
    if (d >= absThreshold) {
      // 状態が大きく動いた。debounce を満たすときだけ「イベント」として数える。
      // 数えなくても基準レベルは更新する(同一遷移を debounce 明けに再カウントしない)。
      if (times[i] - lastEvent >= debounceSec) {
        count++;
        eventTimes.push(times[i]);
        lastEvent = times[i];
      }
      lvl = values[i];
    } else if (d < absThreshold * 0.4) {
      lvl = values[i]; // 同レベル内のドリフト追従
    }
  }
  return { count, eventTimes };
}

/**
 * イベント時刻(epoch秒)の配列を、windowSec ごとの窓に丸めて回数を集計する。
 * @param {number[]} eventTimes 昇順でなくても可
 * @param {number} windowSec 窓幅(秒) 例 900=15分
 * @param {number} originSec 窓の起点(秒)
 * @returns {Record<number, number>} { 窓開始秒: 回数 }
 */
export function binCountsByWindow(eventTimes, windowSec, originSec = 0) {
  const out = {};
  for (const t of eventTimes) {
    const idx = Math.floor((t - originSec) / windowSec);
    const start = originSec + idx * windowSec;
    out[start] = (out[start] || 0) + 1;
  }
  return out;
}
