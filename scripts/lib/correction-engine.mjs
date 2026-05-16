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

export const CORRECTION_SCHEMA_VERSION = 1;
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

const STALL_NAMES = ['stall1', 'stall2', 'stall3', 'stall4'];

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
      const v = Math.round((slot[name] || 0) * factor);
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
 * 純関数 (マスター非破壊)。rates の各 terminal を factor 倍する。
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
    const factor = (entry && typeof entry.factor === 'number') ? entry.factor : 1.0;
    if (factor === 1.0 || !b.rates) continue;
    for (const term of Object.keys(b.rates)) {
      b.rates[term] = b.rates[term] * factor;
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
