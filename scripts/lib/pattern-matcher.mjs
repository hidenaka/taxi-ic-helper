/**
 * パターンマッチング予測エンジン (Phase C-2 MVP)。
 *
 * 設計: docs/superpowers/specs/2026-05-15-pattern-matching-mvp-design.md
 *
 * 純関数のみ。observe-taxi-pool.mjs から呼ばれる。
 */

import { formatYmd, getDayType } from './calendar-context.mjs';

export const SLOTS_PER_HOUR = 12;
export const SLOTS_PER_DAY = 288;
export const STALLS = ['stall1', 'stall2', 'stall3', 'stall4'];
export const WINDOW_PAST_SLOTS = 72;       // 過去 6 時間
export const FORECAST_SLOT_COUNT = 24;     // 2 時間先
export const MIN_CANDIDATES = 3;
export const TOP_N_SIMILAR = 5;
export const NIGHT_LUMINANCE_THRESHOLD = 30;
export const PATTERN_SCHEMA_VERSION = 1;

export function cosine(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 信頼サブセットの jsonl 行群を日単位に集約。
 * 各日について slots[288] = [[stall1Out, stall2Out, stall3Out, stall4Out], ...] を作る。
 *
 * 信頼サブセット条件: schema_version=3 ∧ img1.roi.luminance_mean >= 30 ∧ stalls 非 null
 *
 * @returns Map<"YYYY-MM-DD", {date: Date, slots: Array<Array<number>>}>
 */
export function aggregateByDate(history) {
  const byDate = new Map();
  for (const row of history) {
    if (row.schema_version !== 3) continue;
    const lum = row.img1?.roi?.luminance_mean;
    if (typeof lum !== 'number' || lum < NIGHT_LUMINANCE_THRESHOLD) continue;
    if (!row.stalls) continue;
    const ts = new Date(row.ts);
    if (Number.isNaN(ts.getTime())) continue;
    const dateKey = formatYmd(ts);
    const slotIdx = ts.getHours() * SLOTS_PER_HOUR + Math.floor(ts.getMinutes() / 5);
    if (!byDate.has(dateKey)) {
      const slots = Array.from({ length: SLOTS_PER_DAY }, () => [0, 0, 0, 0]);
      byDate.set(dateKey, { date: new Date(ts.getFullYear(), ts.getMonth(), ts.getDate()), slots });
    }
    const day = byDate.get(dateKey);
    for (let i = 0; i < STALLS.length; i++) {
      const d = row.stalls[STALLS[i]]?.diff_occupied_from_prev;
      if (typeof d === 'number' && d < 0) {
        day.slots[slotIdx][i] += -d;
      }
    }
  }
  return byDate;
}
