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
