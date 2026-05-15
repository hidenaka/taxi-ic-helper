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
