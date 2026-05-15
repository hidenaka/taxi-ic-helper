/**
 * 短期需要予測エンジン (stall ベース MVP)。
 *
 * 設計: docs/superpowers/specs/2026-05-15-stall-forecast-mvp-design.md
 *
 * 純関数のみ (副作用なし)。observe-taxi-pool.mjs から呼ばれる。
 */

export const SLOTS_PER_HOUR = 12; // 5 min slot
export const SLOTS_PER_DAY = 24 * SLOTS_PER_HOUR; // 288
export const FORECAST_SLOT_COUNT = 24; // 2 時間先 = 24 slot
export const NIGHT_LUMINANCE_THRESHOLD = 30; // 信頼サブセット条件
export const TREND_WINDOW_TICKS = 12; // 直近 60 分
export const TREND_FACTOR_MIN = 0.3;
export const TREND_FACTOR_MAX = 3.0;
export const FLIGHT_FACTOR_MIN = 0.3;
export const FLIGHT_FACTOR_MAX = 3.0;
export const FORECAST_SCHEMA_VERSION = 1;

/**
 * (hour, minute) → 0-287 の slot index を返す。
 */
export function slotKey(hour, minute) {
  return hour * SLOTS_PER_HOUR + Math.floor(minute / 5);
}

/**
 * 数値を [min, max] にクリップする。
 */
export function clip(value, min, max) {
  if (Number.isNaN(value) || !Number.isFinite(value)) return 1.0;
  return Math.max(min, Math.min(max, value));
}

/**
 * 信頼サブセットの jsonl 行群から stall 別 × 288 slot の出庫平均を返す。
 *
 * 信頼サブセット条件: schema_version=3 ∧ img1.roi.luminance_mean >= 30
 *                    ∧ stalls 非 null
 *
 * @param {Array} history jsonl 行の配列
 * @returns {{slots: Array, sampleCount: number}}
 */
export function computeBaseline(history) {
  const sums = Array.from({ length: SLOTS_PER_DAY }, () => ({
    stall1: 0, stall2: 0, stall3: 0, stall4: 0, count: 0,
  }));
  let sampleCount = 0;
  for (const row of history) {
    if (row.schema_version !== 3) continue;
    const lum = row.img1?.roi?.luminance_mean;
    if (typeof lum !== 'number' || lum < NIGHT_LUMINANCE_THRESHOLD) continue;
    if (!row.stalls) continue;
    const ts = new Date(row.ts);
    if (Number.isNaN(ts.getTime())) continue;
    const slot = slotKey(ts.getHours(), ts.getMinutes());
    const acc = sums[slot];
    for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
      const d = row.stalls[name]?.diff_occupied_from_prev;
      if (typeof d !== 'number') continue;
      acc[name] += d < 0 ? -d : 0;
    }
    acc.count += 1;
    sampleCount += 1;
  }
  const slots = sums.map(s => {
    if (s.count === 0) {
      return { stall1: null, stall2: null, stall3: null, stall4: null };
    }
    return {
      stall1: s.stall1 / s.count,
      stall2: s.stall2 / s.count,
      stall3: s.stall3 / s.count,
      stall4: s.stall4 / s.count,
    };
  });
  return { slots, sampleCount };
}
