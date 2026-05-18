// 車両トラッカーの実測出庫を直近 windowMinutes の15分スロットに乗り場別集計する。
import { trackRowDeparted, trackRowDepartedByStall } from './throughput-calibration.mjs';

const SLOT_MINUTES = 15;
const SLOT_MS = SLOT_MINUTES * 60 * 1000;
const STALL_NAMES = ['stall1', 'stall2', 'stall3', 'stall4'];

// epoch ms → JST "HH:MM"
function fmtJst(ms) {
  const jst = new Date(ms + 9 * 3600 * 1000);
  const h = String(jst.getUTCHours()).padStart(2, '0');
  const m = String(jst.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * 直近 windowMinutes ぶんのトラッカー実測出庫を15分スロットで乗り場別集計する。
 * @param {Array} trackHistory vehicle-track-history.jsonl の行配列
 * @param {Date} now 現在時刻
 * @param {number} [windowMinutes] 遡る分数（既定 120）
 * @returns {Array<{slotStart,slotEnd,stall1,stall2,stall3,stall4,total}>} 時刻昇順。
 *   v3 行（乗り場分離不可）は total のみに寄与し stall1..4 には加算しない。
 */
export function computeTrackActuals(trackHistory, now, windowMinutes = 120) {
  const endMs = now.getTime();
  const startMs = endMs - windowMinutes * 60 * 1000;
  const bins = new Map(); // binStartMs → {stall1..4, total}
  for (const r of trackHistory || []) {
    const tsMs = new Date(r.ts).getTime();
    if (Number.isNaN(tsMs) || tsMs < startMs || tsMs > endMs) continue;
    const binStartMs = Math.floor(tsMs / SLOT_MS) * SLOT_MS;
    let bin = bins.get(binStartMs);
    if (!bin) {
      bin = { stall1: 0, stall2: 0, stall3: 0, stall4: 0, total: 0 };
      bins.set(binStartMs, bin);
    }
    bin.total += trackRowDeparted(r);
    const byStall = trackRowDepartedByStall(r);
    if (byStall) {
      for (const name of STALL_NAMES) bin[name] += byStall[name];
    }
  }
  return [...bins.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([binStartMs, bin]) => ({
      slotStart: fmtJst(binStartMs),
      slotEnd: fmtJst(binStartMs + SLOT_MS),
      stall1: bin.stall1, stall2: bin.stall2, stall3: bin.stall3, stall4: bin.stall4,
      total: bin.total,
    }));
}
