/**
 * 予測精度評価 (Phase D-1)。
 *
 * 設計: docs/superpowers/specs/2026-05-16-forecast-accuracy-tracking-design.md
 *
 * forecast-log.jsonl の過去予測と、実測 jsonl を突き合わせて
 * lead time 別 MAE を計算する純関数群。
 */

export const SLOTS_PER_HOUR = 12;
export const SLOTS_PER_DAY = 288;
export const NIGHT_LUMINANCE_THRESHOLD = 30;
export const ACCURACY_SCHEMA_VERSION = 1;

// lead time バケット: [ラベル, 中心分, 許容幅]
export const LEAD_BUCKETS = [
  { key: 'lead30', center: 30, halfWidth: 5 },
  { key: 'lead60', center: 60, halfWidth: 5 },
  { key: 'lead120', center: 120, halfWidth: 5 },
];

export function slotKeyOf(dateStr, slotIdx) {
  return `${dateStr}#${slotIdx}`;
}

function formatYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 信頼サブセットの jsonl 行群から、各 (日付, slotIdx) の出庫実測を Map で返す。
 * 値は [stall1Out, stall2Out, stall3Out, stall4Out]。
 *
 * 信頼サブセット条件: schema_version=3 ∧ img1.roi.luminance_mean >= 30 ∧ stalls 非 null
 */
export function buildActualMap(history) {
  const map = new Map();
  for (const row of history) {
    if (row.schema_version !== 3) continue;
    const lum = row.img1?.roi?.luminance_mean;
    if (typeof lum !== 'number' || lum < NIGHT_LUMINANCE_THRESHOLD) continue;
    if (!row.stalls) continue;
    const ts = new Date(row.ts);
    if (Number.isNaN(ts.getTime())) continue;
    const slotIdx = ts.getHours() * SLOTS_PER_HOUR + Math.floor(ts.getMinutes() / 5);
    const key = slotKeyOf(formatYmd(ts), slotIdx);
    const out = [0, 0, 0, 0];
    const names = ['stall1', 'stall2', 'stall3', 'stall4'];
    for (let i = 0; i < 4; i++) {
      const d = row.stalls[names[i]]?.diff_occupied_from_prev;
      if (typeof d === 'number' && d < 0) out[i] = -d;
    }
    map.set(key, out);
  }
  return map;
}

function jstNowIsoString(now) {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
}

function leadBucketOf(leadMinutes) {
  for (const b of LEAD_BUCKETS) {
    if (Math.abs(leadMinutes - b.center) <= b.halfWidth) return b.key;
  }
  return null;
}

function emptyBucketStats() {
  const stats = {};
  for (const b of LEAD_BUCKETS) {
    stats[b.key] = { absSum: 0, absPerStall: [0, 0, 0, 0], n: 0 };
  }
  return stats;
}

function finalizeBucketStats(stats) {
  const out = {};
  for (const b of LEAD_BUCKETS) {
    const s = stats[b.key];
    if (s.n === 0) {
      out[b.key] = { mae_total: null, mae_per_stall: [null, null, null, null], n: 0 };
    } else {
      out[b.key] = {
        mae_total: Number((s.absSum / s.n).toFixed(3)),
        mae_per_stall: s.absPerStall.map(v => Number((v / s.n).toFixed(3))),
        n: s.n,
      };
    }
  }
  return out;
}

/**
 * 1 つの method (forecast / patternMatch) の予測 slot 配列を評価し、stats に加算する。
 */
function accumulate(stats, issueDate, predSlots, actualMap) {
  const issueSlotIdx = issueDate.getHours() * SLOTS_PER_HOUR + Math.floor(issueDate.getMinutes() / 5);
  for (const slot of predSlots) {
    const [hh, mm] = slot.slotStart.split(':').map(Number);
    if (Number.isNaN(hh) || Number.isNaN(mm)) continue;
    const slotIdx = hh * SLOTS_PER_HOUR + Math.floor(mm / 5);
    // slot が発行時刻より後なら同日、前なら翌日
    const dateForSlot = new Date(issueDate);
    if (slotIdx <= issueSlotIdx) {
      dateForSlot.setDate(dateForSlot.getDate() + 1);
    }
    const y = dateForSlot.getFullYear();
    const m = String(dateForSlot.getMonth() + 1).padStart(2, '0');
    const d = String(dateForSlot.getDate()).padStart(2, '0');
    const key = slotKeyOf(`${y}-${m}-${d}`, slotIdx);
    const actual = actualMap.get(key);
    if (!actual) continue; // 実測なし → スキップ
    // lead time
    let leadSlots = slotIdx - issueSlotIdx;
    if (leadSlots <= 0) leadSlots += SLOTS_PER_DAY;
    const leadMinutes = leadSlots * 5;
    const bucket = leadBucketOf(leadMinutes);
    if (!bucket) continue;
    const predStalls = [slot.stall1, slot.stall2, slot.stall3, slot.stall4];
    const predTotal = slot.total;
    const actualTotal = actual[0] + actual[1] + actual[2] + actual[3];
    const s = stats[bucket];
    s.absSum += Math.abs(predTotal - actualTotal);
    for (let i = 0; i < 4; i++) {
      s.absPerStall[i] += Math.abs(predStalls[i] - actual[i]);
    }
    s.n += 1;
  }
}

function evaluatePeriod(logEntries, actualMap) {
  const fcStats = emptyBucketStats();
  const pmStats = emptyBucketStats();
  for (const entry of logEntries) {
    const issueDate = new Date(entry.ts);
    if (Number.isNaN(issueDate.getTime())) continue;
    if (Array.isArray(entry.forecast)) accumulate(fcStats, issueDate, entry.forecast, actualMap);
    if (Array.isArray(entry.patternMatch)) accumulate(pmStats, issueDate, entry.patternMatch, actualMap);
  }
  const forecast = finalizeBucketStats(fcStats);
  const patternMatch = finalizeBucketStats(pmStats);
  const winner = {};
  for (const b of LEAD_BUCKETS) {
    const f = forecast[b.key].mae_total;
    const p = patternMatch[b.key].mae_total;
    if (f === null && p === null) winner[b.key] = 'n/a';
    else if (p === null) winner[b.key] = 'forecast';
    else if (f === null) winner[b.key] = 'patternMatch';
    else winner[b.key] = f <= p ? 'forecast' : 'patternMatch';
  }
  return { forecast, patternMatch, winner };
}

/**
 * 予測精度を評価する。
 *
 * @param {Array} logEntries forecast-log.jsonl の全行
 * @param {Map<string, number[]>} actualMap buildActualMap の戻り値
 * @param {Date} now
 * @returns 精度オブジェクト
 */
export function evaluateAccuracy(logEntries, actualMap, now) {
  const cutoff = now.getTime() - 24 * 3600 * 1000;
  const recentEntries = logEntries.filter(e => {
    const t = new Date(e.ts).getTime();
    return !Number.isNaN(t) && t >= cutoff;
  });
  return {
    schemaVersion: ACCURACY_SCHEMA_VERSION,
    generatedAt: jstNowIsoString(now),
    logEntryCount: logEntries.length,
    recent24h: evaluatePeriod(recentEntries, actualMap),
    allPeriod: evaluatePeriod(logEntries, actualMap),
  };
}
