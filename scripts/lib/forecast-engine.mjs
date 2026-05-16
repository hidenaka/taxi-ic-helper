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

/**
 * 現在時刻から +5min〜+120min (24 slot) の予測を返す。
 *
 * @param {{slots: Array, sampleCount: number}} baseline computeBaseline の戻り値
 * @param {Array} recentHistory 直近 N tick の jsonl 行 (各行に ts と total_outflow)
 * @param {{flights: Array}|null} arrivalsJson arrivals.json (flights[].lobbyExitTime, .estimatedTaxiPax)
 * @param {Date} now 現在時刻
 * @param {{k: number, actual: number}|null} trackTrend 車両追跡 throughput (Phase G-1)。null なら net-diff 経路
 * @returns 予測オブジェクト
 */
export function computeForecast(baseline, recentHistory, arrivalsJson, now, trackTrend = null) {
  const nowSlot = slotKey(now.getHours(), now.getMinutes());

  // --- trendFactor ---
  // trackTrend ({ k, actual }) があれば track 経路、無ければ net-diff 経路 (Phase G-1)。
  let trendFactor = 1.0;
  let trendActual = 0;
  let trendExpected = 0;
  let trendSource = 'netdiff';
  let trendK = null;
  if (recentHistory.length >= TREND_WINDOW_TICKS) {
    const window = recentHistory.slice(-TREND_WINDOW_TICKS);
    for (const row of window) {
      if (typeof row.total_outflow === 'number') {
        trendActual += row.total_outflow;
      }
      const ts = new Date(row.ts);
      if (!Number.isNaN(ts.getTime())) {
        const slot = baseline.slots[slotKey(ts.getHours(), ts.getMinutes())];
        if (slot && slot.stall1 !== null) {
          trendExpected += (slot.stall1 + slot.stall2 + slot.stall3 + slot.stall4);
        }
      }
    }
    const useTrack = trackTrend !== null
      && typeof trackTrend.actual === 'number'
      && typeof trackTrend.k === 'number'
      && trackTrend.k > 0
      && trendExpected > 0;
    if (useTrack) {
      // track 経路: k で net-diff baseline と単位を揃える
      trendActual = trackTrend.actual;
      trendSource = 'track';
      trendK = trackTrend.k;
      trendFactor = clip(trendActual / (trackTrend.k * trendExpected), TREND_FACTOR_MIN, TREND_FACTOR_MAX);
    } else if (trendExpected > 0) {
      trendFactor = clip(trendActual / trendExpected, TREND_FACTOR_MIN, TREND_FACTOR_MAX);
    }
  }

  // --- flightFactor[slot_t] ---
  const flightSums = new Array(FORECAST_SLOT_COUNT).fill(0);
  if (arrivalsJson && Array.isArray(arrivalsJson.flights)) {
    for (const f of arrivalsJson.flights) {
      if (!f.lobbyExitTime || typeof f.estimatedTaxiPax !== 'number') continue;
      const [h, m] = f.lobbyExitTime.split(':').map(Number);
      if (Number.isNaN(h) || Number.isNaN(m)) continue;
      const lobbySlot = slotKey(h, m);
      for (let i = 0; i < FORECAST_SLOT_COUNT; i++) {
        const targetSlot = (nowSlot + 1 + i) % SLOTS_PER_DAY;
        if (lobbySlot === targetSlot) {
          flightSums[i] += f.estimatedTaxiPax;
          break;
        }
      }
    }
  }
  const dailyAvg = flightSums.reduce((s, v) => s + v, 0) / FORECAST_SLOT_COUNT;
  const flightFactors = flightSums.map(s => {
    if (dailyAvg <= 0) return 1.0;
    return clip(s / dailyAvg, FLIGHT_FACTOR_MIN, FLIGHT_FACTOR_MAX);
  });

  // --- 各 slot の予測 ---
  const outSlots = [];
  for (let i = 0; i < FORECAST_SLOT_COUNT; i++) {
    const targetSlot = (nowSlot + 1 + i) % SLOTS_PER_DAY;
    const slotStartMin = targetSlot * 5;
    const startH = Math.floor(slotStartMin / 60) % 24;
    const startM = slotStartMin % 60;
    const endTotal = slotStartMin + 5;
    const endH = Math.floor(endTotal / 60) % 24;
    const endM = endTotal % 60;
    const fmt = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    const base = baseline.slots[targetSlot] || { stall1: null, stall2: null, stall3: null, stall4: null };
    const f = flightFactors[i];
    const slotOut = { slotStart: fmt(startH, startM), slotEnd: fmt(endH, endM), flightFactor: f };
    let total = 0;
    for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
      const b = base[name];
      const val = (b === null || b === undefined) ? 0 : Math.round(b * trendFactor * f);
      slotOut[name] = val;
      total += val;
    }
    slotOut.total = total;
    outSlots.push(slotOut);
  }

  // JST 文字列を組み立てる (observe-taxi-pool.mjs の jstNowIso と同じハック)
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const generatedAt = jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');

  return {
    schemaVersion: FORECAST_SCHEMA_VERSION,
    generatedAt,
    trendFactor,
    trendWindow: { actual: trendActual, expected: trendExpected, ticks: Math.min(recentHistory.length, TREND_WINDOW_TICKS), source: trendSource, k: trendK },
    baselineSampleCount: baseline.sampleCount,
    slots: outSlots,
  };
}
