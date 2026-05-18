// 車両トラッカーの実測出庫を直近 windowMinutes の15分スロットに集計する。
import { trackRowDeparted, TRACK_SCHEMA_VERSION } from './throughput-calibration.mjs';

const SLOT_MINUTES = 15;
const SLOT_MS = SLOT_MINUTES * 60 * 1000;

// epoch ms → JST "HH:MM"
function fmtJst(ms) {
  const jst = new Date(ms + 9 * 3600 * 1000);
  const h = String(jst.getUTCHours()).padStart(2, '0');
  const m = String(jst.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * 直近 windowMinutes ぶんのトラッカー実測出庫を15分スロットで集計する。
 * @param {Array} trackHistory vehicle-track-history.jsonl の行配列
 * @param {Date} now 現在時刻
 * @param {number} [windowMinutes] 遡る分数（既定 120）
 * @returns {Array<{slotStart:string, slotEnd:string, total:number}>} 時刻昇順。departed が全行 null/欠損でも total:0 としてスロットを出力する
 */
export function computeTrackActuals(trackHistory, now, windowMinutes = 120) {
  const endMs = now.getTime();
  const startMs = endMs - windowMinutes * 60 * 1000;
  const bins = new Map(); // binStartMs → total departed
  for (const r of trackHistory || []) {
    if (r.schema_version !== TRACK_SCHEMA_VERSION) continue;
    const tsMs = new Date(r.ts).getTime();
    if (Number.isNaN(tsMs) || tsMs < startMs || tsMs > endMs) continue;
    const binStartMs = Math.floor(tsMs / SLOT_MS) * SLOT_MS;
    bins.set(binStartMs, (bins.get(binStartMs) || 0) + trackRowDeparted(r));
  }
  return [...bins.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([binStartMs, total]) => ({
      slotStart: fmtJst(binStartMs),
      slotEnd: fmtJst(binStartMs + SLOT_MS),
      total,
    }));
}
