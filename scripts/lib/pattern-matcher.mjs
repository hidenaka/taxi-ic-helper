/**
 * パターンマッチング予測エンジン (Phase C-2 MVP)。
 *
 * 設計: docs/superpowers/specs/2026-05-15-pattern-matching-mvp-design.md
 *
 * 純関数のみ。observe-taxi-pool.mjs から呼ばれる。
 */

import { formatYmd, getDayContext } from './calendar-context.mjs';

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

const WEEKDAY_DAY_TYPES = ['weekday', 'post_holiday', 'pre_holiday'];

/**
 * 各日の「関連連休日数」を取り出す。
 *   - 休日 (saturday/sunday_holiday/in_consec_holiday/last_consec_holiday): 当該連休 consecLength
 *   - post_holiday: 直前連休 prevConsecLength
 *   - pre_holiday: 直後連休 nextConsecLength
 *   - weekday: 1 (フィルタ的に「連休と無関係」)
 */
function relevantConsec(d) {
  if (d.dayType === 'post_holiday') return d.prevConsecLength ?? 0;
  if (d.dayType === 'pre_holiday') return d.nextConsecLength ?? 0;
  if (d.dayType === 'weekday') return 1;
  return d.consecLength ?? 1;
}

/**
 * 段階プレフィルタで候補日を選ぶ。
 *
 * @param {Array<{dateStr,dayType,month,consecLength,prevConsecLength,nextConsecLength,slots}>} pastDays
 * @param {string} targetDayType
 * @param {number} targetMonth (1-12)
 * @param {number} [targetConsec] 対象日の relevantConsec (省略時は consecLength 比較なし)
 * @returns {{filterTier: string, candidates: Array}}
 */
export function selectCandidates(pastDays, targetDayType, targetMonth, targetConsec) {
  // strict: 同 dayType + 同月 + (consec が指定されていれば ±1 以内)
  const strict = pastDays.filter(d => {
    if (d.dayType !== targetDayType) return false;
    if (d.month !== targetMonth) return false;
    if (targetConsec !== undefined && Math.abs(relevantConsec(d) - targetConsec) > 1) return false;
    return true;
  });
  if (strict.length >= MIN_CANDIDATES) return { filterTier: 'strict', candidates: strict };
  // medium: 同 dayType + 月±2 (consec 制約緩める)
  const medium = pastDays.filter(d => d.dayType === targetDayType && Math.abs(d.month - targetMonth) <= 2);
  if (medium.length >= MIN_CANDIDATES) return { filterTier: 'medium', candidates: medium };
  // loose: 平日/休日カテゴリのみ
  const targetIsWeekday = WEEKDAY_DAY_TYPES.includes(targetDayType);
  const loose = pastDays.filter(d => WEEKDAY_DAY_TYPES.includes(d.dayType) === targetIsWeekday);
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

function makeLabel(dateStr, dayType, consec) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dow = DOW_LABEL_JA[date.getDay()];
  const consecStr = (typeof consec === 'number' && consec >= 2) ? `・${consec}連休` : '';
  return `${m}/${d} (${dow}・${dayType}${consecStr})`;
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
  const todayContext = getDayContext(today, holidaysSet);
  const todayMonth = today.getMonth() + 1;
  const todayRelevantConsec = relevantConsec({
    dayType: todayContext.dayType,
    consecLength: todayContext.consecLength,
    prevConsecLength: todayContext.prevConsecLength,
    nextConsecLength: todayContext.nextConsecLength,
  });

  const byDate = aggregateByDate(historyAll);

  const todayEntry = byDate.get(todayDateStr) || null;
  const pastDays = [];
  for (const [dateStr, entry] of byDate.entries()) {
    if (dateStr === todayDateStr) continue;
    const ctx = getDayContext(entry.date, holidaysSet);
    pastDays.push({
      dateStr,
      date: entry.date,
      dayType: ctx.dayType,
      month: entry.date.getMonth() + 1,
      consecLength: ctx.consecLength,
      prevConsecLength: ctx.prevConsecLength,
      nextConsecLength: ctx.nextConsecLength,
      slots: entry.slots,
    });
  }

  const baseOut = {
    schemaVersion: PATTERN_SCHEMA_VERSION,
    generatedAt: jstNowIsoString(now),
    today: {
      date: todayDateStr,
      dayType: todayContext.dayType,
      month: todayMonth,
      consecLength: todayContext.consecLength,
      prevConsecLength: todayContext.prevConsecLength,
      nextConsecLength: todayContext.nextConsecLength,
      relevantConsec: todayRelevantConsec,
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

  const { filterTier, candidates } = selectCandidates(pastDays, todayContext.dayType, todayMonth, todayRelevantConsec);

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
    consecLength: s.entry.consecLength,
    prevConsecLength: s.entry.prevConsecLength,
    nextConsecLength: s.entry.nextConsecLength,
    relevantConsec: relevantConsec(s.entry),
    similarity: Number(s.similarity.toFixed(3)),
    label: makeLabel(s.entry.dateStr, s.entry.dayType, relevantConsec(s.entry)),
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
    // 小数のまま保持する。整数化は書き出し時の applyThroughputScale (round(値×k)) で1回だけ行う。
    const stall1 = count > 0 ? stallSums[0] / count : 0;
    const stall2 = count > 0 ? stallSums[1] / count : 0;
    const stall3 = count > 0 ? stallSums[2] / count : 0;
    const stall4 = count > 0 ? stallSums[3] / count : 0;
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
