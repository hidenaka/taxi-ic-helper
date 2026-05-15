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

/**
 * 段階プレフィルタで候補日を選ぶ。
 *
 * @param {Array<{dateStr,dayType,month,slots}>} pastDays
 * @param {string} targetDayType
 * @param {number} targetMonth (1-12)
 * @returns {{filterTier: string, candidates: Array}}
 */
export function selectCandidates(pastDays, targetDayType, targetMonth) {
  const strict = pastDays.filter(d => d.dayType === targetDayType && d.month === targetMonth);
  if (strict.length >= MIN_CANDIDATES) return { filterTier: 'strict', candidates: strict };
  const medium = pastDays.filter(d => d.dayType === targetDayType && Math.abs(d.month - targetMonth) <= 2);
  if (medium.length >= MIN_CANDIDATES) return { filterTier: 'medium', candidates: medium };
  const targetIsWeekday = ['weekday', 'pre_holiday'].includes(targetDayType);
  const loose = pastDays.filter(d => {
    const dIsWeekday = ['weekday', 'pre_holiday'].includes(d.dayType);
    return dIsWeekday === targetIsWeekday;
  });
  if (loose.length >= MIN_CANDIDATES) return { filterTier: 'loose', candidates: loose };
  return { filterTier: 'all', candidates: pastDays };
}

function jstNowIsoString(now) {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
}

function slotIdx(date) {
  return date.getHours() * SLOTS_PER_HOUR + Math.floor(date.getMinutes() / 5);
}

function extractWindowVec(daySlots, startSlot, lengthSlots) {
  const out = [];
  for (let i = 0; i < lengthSlots; i++) {
    const idx = (startSlot + i) % SLOTS_PER_DAY;
    const s = daySlots[idx];
    out.push(s[0], s[1], s[2], s[3]);
  }
  return out;
}

const DOW_LABEL_JA = ['日', '月', '火', '水', '木', '金', '土'];

function makeLabel(dateStr, dayType) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dow = DOW_LABEL_JA[date.getDay()];
  return `${m}/${d} (${dow}・${dayType})`;
}

/**
 * パターンマッチング予測のメイン関数。
 *
 * @param {Array} historyAll 全 jsonl 行
 * @param {Set<string>} holidaysSet
 * @param {Date} now 現在時刻
 * @returns 出力 JSON オブジェクト
 */
export function computePatternMatch(historyAll, holidaysSet, now) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayDateStr = formatYmd(today);
  const todayDayType = getDayType(today, holidaysSet);
  const todayMonth = today.getMonth() + 1;

  const byDate = aggregateByDate(historyAll);

  const todayEntry = byDate.get(todayDateStr) || null;
  const pastDays = [];
  for (const [dateStr, entry] of byDate.entries()) {
    if (dateStr === todayDateStr) continue;
    pastDays.push({
      dateStr,
      date: entry.date,
      dayType: getDayType(entry.date, holidaysSet),
      month: entry.date.getMonth() + 1,
      slots: entry.slots,
    });
  }

  const baseOut = {
    schemaVersion: PATTERN_SCHEMA_VERSION,
    generatedAt: jstNowIsoString(now),
    today: {
      date: todayDateStr,
      dayType: todayDayType,
      month: todayMonth,
    },
  };

  if (pastDays.length === 0) {
    return {
      ...baseOut,
      today: { ...baseOut.today, filterTier: 'all' },
      candidateCount: 0,
      similarDays: [],
      historicalCurve: [],
    };
  }

  const { filterTier, candidates } = selectCandidates(pastDays, todayDayType, todayMonth);

  const nowSlot = slotIdx(now);
  const windowStart = (nowSlot - WINDOW_PAST_SLOTS + SLOTS_PER_DAY) % SLOTS_PER_DAY;
  const todayVec = todayEntry
    ? extractWindowVec(todayEntry.slots, windowStart, WINDOW_PAST_SLOTS)
    : new Array(WINDOW_PAST_SLOTS * STALLS.length).fill(0);

  const scored = candidates.map(c => {
    const candVec = extractWindowVec(c.slots, windowStart, WINDOW_PAST_SLOTS);
    return { entry: c, similarity: cosine(todayVec, candVec) };
  });
  scored.sort((a, b) => b.similarity - a.similarity);
  const top = scored.slice(0, TOP_N_SIMILAR);

  const similarDays = top.map(s => ({
    date: s.entry.dateStr,
    dayType: s.entry.dayType,
    month: s.entry.month,
    similarity: Number(s.similarity.toFixed(3)),
    label: makeLabel(s.entry.dateStr, s.entry.dayType),
  }));

  const forecastStart = (nowSlot + 1) % SLOTS_PER_DAY;
  const historicalCurve = [];
  for (let i = 0; i < FORECAST_SLOT_COUNT; i++) {
    const idx = (forecastStart + i) % SLOTS_PER_DAY;
    const stallSums = [0, 0, 0, 0];
    let count = 0;
    for (const s of top) {
      const slot = s.entry.slots[idx];
      stallSums[0] += slot[0];
      stallSums[1] += slot[1];
      stallSums[2] += slot[2];
      stallSums[3] += slot[3];
      count += 1;
    }
    const stall1 = count > 0 ? Math.round(stallSums[0] / count) : 0;
    const stall2 = count > 0 ? Math.round(stallSums[1] / count) : 0;
    const stall3 = count > 0 ? Math.round(stallSums[2] / count) : 0;
    const stall4 = count > 0 ? Math.round(stallSums[3] / count) : 0;
    const slotStartMin = idx * 5;
    const startH = Math.floor(slotStartMin / 60) % 24;
    const startM = slotStartMin % 60;
    const endTotal = slotStartMin + 5;
    const endH = Math.floor(endTotal / 60) % 24;
    const endM = endTotal % 60;
    const fmt = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    historicalCurve.push({
      slotStart: fmt(startH, startM),
      slotEnd: fmt(endH, endM),
      stall1, stall2, stall3, stall4,
      total: stall1 + stall2 + stall3 + stall4,
    });
  }

  return {
    ...baseOut,
    today: { ...baseOut.today, filterTier },
    candidateCount: candidates.length,
    similarDays,
    historicalCurve,
  };
}
