/**
 * 係数オンライン補正 (Phase D-3)。
 *
 * 設計: docs/superpowers/specs/2026-05-16-coefficient-online-correction-design.md
 *
 * transit-share 率と forecast レベルの系統バイアスを、ログ・観測からの
 * 決定論的ウィンドウ加重平均で補正する純関数群 (副作用なし)。
 */
import { leadBucketOf, LEAD_KEYS } from './ensemble-engine.mjs';
import { slotKeyOf } from './accuracy-evaluator.mjs';
import { pickBucket } from './taxi-estimator.mjs';
import { hhmmToMinutes } from './route-reachability.mjs';

export const CORRECTION_SCHEMA_VERSION = 3;
export const SHARE_WINDOW_DAYS = 7;
export const SHARE_MIN_FLIGHTS = 20;
export const SHARE_FACTOR_MIN = 0.3;
export const SHARE_FACTOR_MAX = 3.0;
export const LEVEL_WINDOW_HOURS = 48;
export const LEVEL_MIN_SAMPLE = 20;
export const LEVEL_FACTOR_MIN = 0.5;
export const LEVEL_FACTOR_MAX = 2.0;
export const SLOTS_PER_HOUR = 12;
export const SLOTS_PER_DAY = 288;
export const T3_MIN_TICKS = 20;
export const T3_DIRECTIONAL_GAIN = 0.2;
export const T3_FACTOR_MIN = 0.8;
export const T3_FACTOR_MAX = 1.2;

const STALL_NAMES = ['stall1', 'stall2', 'stall3', 'stall4'];

// stall 添字 (buildActualMap の [s1,s2,s3,s4] 配列) → 端末。stall-rois.json 準拠。
const TERMINAL_STALLS = { T1: [0, 1], T2: [2, 3] };

/**
 * 数値を [min, max] にクリップ。NaN・非有限・非数は 1.0。
 */
export function clipFactor(value, min, max) {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) return 1.0;
  return Math.max(min, Math.min(max, value));
}

/**
 * forecast の各 slot に level 補正係数を掛ける。純関数 (入力非破壊)。
 * slot index i は現在 +（i+1）×5 分先 → leadBucketOf でバケット決定。
 *
 * @param {{slots: Array}|null} forecast  computeForecast の戻り値相当
 * @param {Object|null} corrections       coefficient-corrections.json 相当
 * @returns 補正済み forecast (slots 以外のキーは保持)
 */
export function applyLevelCorrection(forecast, corrections) {
  if (!forecast || !Array.isArray(forecast.slots)) return forecast;
  const level = (corrections && corrections.level) || {};
  const correctedSlots = forecast.slots.map((slot, i) => {
    const bucket = leadBucketOf((i + 1) * 5);
    const entry = level[bucket];
    const factor = (entry && typeof entry.factor === 'number') ? entry.factor : 1.0;
    const out = { ...slot };
    let total = 0;
    for (const name of STALL_NAMES) {
      // 小数のまま保持する。整数化は書き出し時の applyThroughputScale (round(値×k)) で1回だけ行う。
      const v = (slot[name] || 0) * factor;
      out[name] = v;
      total += v;
    }
    out.total = total;
    return out;
  });
  return { ...forecast, slots: correctedSlots };
}

/**
 * transit-share マスターに share 補正係数を掛けた実効版を返す。
 * 純関数 (マスター非破壊)。端末別 (v2: entry.T1/T2/T3.factor) と
 * 旧一律 (v1: entry.factor) の両形状を許容する。
 *
 * @param {Object} transitShareMaster  data/transit-share.json
 * @param {Object|null} corrections    coefficient-corrections.json 相当
 * @returns 実効 transit-share
 */
export function buildEffectiveTransitShare(transitShareMaster, corrections) {
  const share = (corrections && corrections.share) || {};
  const effective = JSON.parse(JSON.stringify(transitShareMaster));
  if (!Array.isArray(effective.buckets)) return effective;
  for (const b of effective.buckets) {
    const entry = share[b.id];
    if (!entry || !b.rates) continue;
    for (const term of Object.keys(b.rates)) {
      let factor = 1.0;
      if (entry[term] && typeof entry[term].factor === 'number') {
        factor = entry[term].factor;        // v2: 端末別
      } else if (typeof entry.factor === 'number') {
        factor = entry.factor;              // v1: 一律
      }
      if (factor !== 1.0) b.rates[term] = b.rates[term] * factor;
    }
  }
  return effective;
}

/**
 * Date → "YYYY-MM-DD" (ローカル時刻)。
 */
function ymdOf(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 1 つの予測 slot 配列を actualMap と突き合わせ、lead bucket 別に
 * 予測合計・実測合計・件数を stats に加算する。
 */
function accumulateLevel(stats, issueDate, predSlots, actualMap) {
  const issueSlotIdx = issueDate.getHours() * SLOTS_PER_HOUR + Math.floor(issueDate.getMinutes() / 5);
  for (const slot of predSlots) {
    const parts = String(slot.slotStart).split(':');
    const hh = Number(parts[0]);
    const mm = Number(parts[1]);
    if (Number.isNaN(hh) || Number.isNaN(mm)) continue;
    const slotIdx = hh * SLOTS_PER_HOUR + Math.floor(mm / 5);
    // slot が発行時刻より後なら同日、以前なら翌日
    const dateForSlot = new Date(issueDate);
    if (slotIdx <= issueSlotIdx) dateForSlot.setDate(dateForSlot.getDate() + 1);
    const actual = actualMap.get(slotKeyOf(ymdOf(dateForSlot), slotIdx));
    if (!actual) continue;
    let leadSlots = slotIdx - issueSlotIdx;
    if (leadSlots <= 0) leadSlots += SLOTS_PER_DAY;
    const bucket = leadBucketOf(leadSlots * 5);
    const predTotal = typeof slot.total === 'number'
      ? slot.total
      : STALL_NAMES.reduce((s, n) => s + (slot[n] || 0), 0);
    const actualTotal = actual[0] + actual[1] + actual[2] + actual[3];
    const st = stats[bucket];
    st.predSum += predTotal;
    st.actualSum += actualTotal;
    st.n += 1;
  }
}

/**
 * forecast-log の RAW 予測を実測と突き合わせ、lead bucket 別レベル補正係数を計算。
 * 直近 LEVEL_WINDOW_HOURS 以内に発行されたエントリのみ対象。
 *
 * @param {Array} logEntries  forecast-log.jsonl の全行 (各 {ts, forecast})
 * @param {Map} actualMap     buildActualMap の戻り値
 * @param {Date} now
 * @returns {{lead30, lead60, lead120}} 各 {factor, source, n}
 */
export function computeLevelCorrection(logEntries, actualMap, now) {
  const cutoff = now.getTime() - LEVEL_WINDOW_HOURS * 3600 * 1000;
  const stats = {};
  for (const k of LEAD_KEYS) stats[k] = { predSum: 0, actualSum: 0, n: 0 };
  for (const entry of logEntries) {
    if (!entry || typeof entry.ts !== 'string') continue;
    const issueDate = new Date(entry.ts);
    if (Number.isNaN(issueDate.getTime())) continue;
    if (issueDate.getTime() < cutoff) continue;
    if (Array.isArray(entry.forecast)) {
      accumulateLevel(stats, issueDate, entry.forecast, actualMap);
    }
  }
  const out = {};
  for (const k of LEAD_KEYS) {
    const st = stats[k];
    if (st.n < LEVEL_MIN_SAMPLE || st.predSum <= 0) {
      out[k] = { factor: 1.0, source: 'fallback', n: st.n };
    } else {
      const raw = Number((st.actualSum / st.predSum).toFixed(4));
      out[k] = {
        factor: clipFactor(raw, LEVEL_FACTOR_MIN, LEVEL_FACTOR_MAX),
        source: 'learning',
        n: st.n,
      };
    }
  }
  return out;
}

/**
 * "YYYY-MM-DD" → 翌日の "YYYY-MM-DD"。
 */
function nextDayStr(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return ymdOf(d);
}

/**
 * actualMap から、ある日のあるバケット時間範囲に入る slot の実測 outflow 合計を返す。
 * stallIndices で集計対象の stall 添字を指定する (T1=[0,1], T2=[2,3])。
 * バケット範囲が 24:00 を超える場合 (midnight バケット等) は翌日の slot を参照する。
 */
function sumActualForBucket(actualMap, dateStr, bucket, stallIndices) {
  const fromMin = hhmmToMinutes(bucket.fromHHMM);
  const toMin = hhmmToMinutes(bucket.toHHMM);
  if (fromMin === null || toMin === null) return 0;
  let sum = 0;
  for (let slotIdx = Math.floor(fromMin / 5); slotIdx < Math.floor(toMin / 5); slotIdx++) {
    let day = dateStr;
    let idx = slotIdx;
    if (idx >= SLOTS_PER_DAY) { day = nextDayStr(dateStr); idx -= SLOTS_PER_DAY; }
    const actual = actualMap.get(slotKeyOf(day, idx));
    if (actual) {
      for (const si of stallIndices) sum += actual[si];
    }
  }
  return sum;
}

/**
 * transit-share バケット率の補正係数を端末別 (T1/T2/T3) に計算する。
 * 直近 SHARE_WINDOW_DAYS の完了日について、バケット×端末別に
 * 「Σ実測outflow ÷ Σ estimatedTaxiPax」の日次比率を求め、直近日ほど重い加重平均をとる。
 *
 * T1 = stall1+stall2 outflow / terminal=="T1" 便。
 * T2 = stall3+stall4 outflow / terminal=="T2" 便。
 * T3 = 観測 stall が無いため常に factor 1.0・source "unobservable"。
 *
 * @param {Array} snapshotRows  arrivals-snapshots/*.jsonl の行 (各 {ts, flights})
 * @param {Map} actualMap       buildActualMap の戻り値
 * @param {Object} transitShare data/transit-share.json (バケット定義)
 * @param {Date} now
 * @returns {Object} {<bucketId>: {T1, T2, T3}} 各端末 {factor, source, flightCount?, dayCount?}
 */
export function computeShareCorrection(snapshotRows, actualMap, transitShare, now) {
  const buckets = (transitShare && Array.isArray(transitShare.buckets)) ? transitShare.buckets : [];

  // 行を日別にグループ化
  const rowsByDay = new Map();
  for (const row of snapshotRows) {
    if (!row || typeof row.ts !== 'string') continue;
    const day = row.ts.slice(0, 10);
    if (!rowsByDay.has(day)) rowsByDay.set(day, []);
    rowsByDay.get(day).push(row);
  }
  // 完了日 (当日より前) を昇順で直近 SHARE_WINDOW_DAYS 個
  const todayStr = ymdOf(now);
  const targetDays = [...rowsByDay.keys()]
    .filter(d => d < todayStr)
    .sort()
    .slice(-SHARE_WINDOW_DAYS);

  // dayRatios[bucketId][term] = [{ratio, weight}]、flightCounts[bucketId][term] = 件数
  const dayRatios = {};
  const flightCounts = {};
  for (const b of buckets) {
    dayRatios[b.id] = { T1: [], T2: [] };
    flightCounts[b.id] = { T1: 0, T2: 0 };
  }

  targetDays.forEach((day, dayIdx) => {
    const weight = dayIdx + 1; // 最古 = 1 .. 最新 = targetDays.length
    const rows = [...(rowsByDay.get(day) || [])].sort((a, b) => (a.ts < b.ts ? -1 : 1));
    // 便ごとに最終スナップショットの flight を採用 (ts 昇順 → 後勝ち)
    const lastFlightByNumber = new Map();
    for (const row of rows) {
      if (!Array.isArray(row.flights)) continue;
      for (const f of row.flights) {
        if (f && f.flightNumber) lastFlightByNumber.set(f.flightNumber, f);
      }
    }
    // バケット×端末別 Σ estimatedTaxiPax / 便数 (T1/T2 のみ。T3・不明は除外)
    const estByBucket = {};
    for (const b of buckets) estByBucket[b.id] = { T1: { sum: 0, count: 0 }, T2: { sum: 0, count: 0 } };
    for (const f of lastFlightByNumber.values()) {
      if (typeof f.estimatedTaxiPax !== 'number' || !f.lobbyExitTime) continue;
      const term = f.terminal;
      if (term !== 'T1' && term !== 'T2') continue;
      const bucket = pickBucket(f.lobbyExitTime, transitShare);
      if (!bucket || !estByBucket[bucket.id]) continue;
      estByBucket[bucket.id][term].sum += f.estimatedTaxiPax;
      estByBucket[bucket.id][term].count += 1;
    }
    for (const b of buckets) {
      for (const term of ['T1', 'T2']) {
        const est = estByBucket[b.id][term];
        flightCounts[b.id][term] += est.count;
        if (est.sum <= 0) continue;
        const actualSum = sumActualForBucket(actualMap, day, b, TERMINAL_STALLS[term]);
        dayRatios[b.id][term].push({ ratio: actualSum / est.sum, weight });
      }
    }
  });

  const share = {};
  for (const b of buckets) {
    share[b.id] = {};
    for (const term of ['T1', 'T2']) {
      const ratios = dayRatios[b.id][term];
      const count = flightCounts[b.id][term];
      if (ratios.length === 0 || count < SHARE_MIN_FLIGHTS) {
        share[b.id][term] = { factor: 1.0, source: 'fallback', flightCount: count, dayCount: ratios.length };
      } else {
        let wSum = 0;
        let wTotal = 0;
        for (const r of ratios) { wSum += r.ratio * r.weight; wTotal += r.weight; }
        const raw = Number((wSum / wTotal).toFixed(4));
        share[b.id][term] = {
          factor: clipFactor(raw, SHARE_FACTOR_MIN, SHARE_FACTOR_MAX),
          source: 'learning',
          flightCount: count,
          dayCount: ratios.length,
        };
      }
    }
    share[b.id].T3 = { factor: 1.0, source: 'unobservable' };
  }
  return share;
}

/**
 * t3-pool-history.jsonl の Real106 black_ratio から、T3 のバケット別方向性補正を計算する。
 *
 * curb の 5 分サンプリングでは台数を数えられないため、これは弱い経験則:
 * バケットの先頭活性 (Real106 black_ratio 平均) を全バケット平均で相対化し、
 * 相対的に活性が高い (滞留タクシー多め) バケットは factor < 1、低いバケットは factor > 1。
 *
 * @param {Array} t3PoolRows    t3-pool-history.jsonl の全行
 * @param {Object} transitShare data/transit-share.json (バケット定義)
 * @param {Date} now
 * @returns {Object} {<bucketId>: {factor, source, n, relativeActivity}}
 */
export function computeT3DirectionalCorrection(t3PoolRows, transitShare, now) {
  const buckets = (transitShare && Array.isArray(transitShare.buckets)) ? transitShare.buckets : [];
  const todayStr = ymdOf(now);

  // バケット別に Real106 black_ratio を集計 (完了日のみ)
  const sums = {};
  for (const b of buckets) sums[b.id] = { sum: 0, n: 0 };
  for (const row of t3PoolRows) {
    if (!row || typeof row.ts !== 'string') continue;
    if (row.ts.slice(0, 10) >= todayStr) continue; // 完了日のみ
    if (!Array.isArray(row.t3_stand)) continue;
    const r106 = row.t3_stand.find(e => e && e.name === 'Real106');
    if (!r106 || typeof r106.black_ratio !== 'number') continue;
    const bucket = pickBucket(row.ts.slice(11, 16), transitShare);
    if (!bucket || !sums[bucket.id]) continue;
    sums[bucket.id].sum += r106.black_ratio;
    sums[bucket.id].n += 1;
  }

  // tick 数が閾値以上のバケットの平均活性 → overall
  const activity = {};
  let overallSum = 0;
  let overallCount = 0;
  for (const b of buckets) {
    const s = sums[b.id];
    if (s.n >= T3_MIN_TICKS) {
      activity[b.id] = s.sum / s.n;
      overallSum += activity[b.id];
      overallCount += 1;
    }
  }
  const overall = overallCount > 0 ? overallSum / overallCount : 0;

  const out = {};
  for (const b of buckets) {
    const s = sums[b.id];
    if (s.n < T3_MIN_TICKS || overall <= 0) {
      out[b.id] = { factor: 1.0, source: 'fallback', n: s.n, relativeActivity: null };
    } else {
      const relative = activity[b.id] / overall;
      const factor = clipFactor(
        Number((1 - T3_DIRECTIONAL_GAIN * (relative - 1)).toFixed(4)),
        T3_FACTOR_MIN, T3_FACTOR_MAX
      );
      out[b.id] = {
        factor,
        source: 'directional',
        n: s.n,
        relativeActivity: Number(relative.toFixed(4)),
      };
    }
  }
  return out;
}
