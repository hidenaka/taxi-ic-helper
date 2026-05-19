// スロット占有履歴 → 乗り場別出庫（15分スロット・実績形）。
import { departuresBetween, medianOf3 } from './slot-occupancy.mjs';

const SLOT_MS = 15 * 60 * 1000;
const STALLS = ['stall1', 'stall2', 'stall3', 'stall4'];

function fmtJst(ms) {
  const jst = new Date(ms + 9 * 3600 * 1000);
  return `${String(jst.getUTCHours()).padStart(2, '0')}:${String(jst.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * 占有履歴から乗り場別出庫を15分スロットで集計する。
 * @param {Array} occHistory slot-occupancy-history.jsonl の行配列（時刻昇順想定）
 * @param {Date} now 現在時刻
 * @param {number} [windowMinutes] 遡る分数（既定120）
 * @returns {Array<{slotStart,slotEnd,stall1,stall2,stall3,stall4,total}>}
 */
export function computeSlotActuals(occHistory, now, windowMinutes = 120) {
  const rows = (occHistory || [])
    .map(r => ({ tsMs: new Date(r.ts).getTime(), stalls: r.stalls || {} }))
    .filter(r => !Number.isNaN(r.tsMs))
    .sort((a, b) => a.tsMs - b.tsMs);
  if (rows.length < 2) return [];
  const endMs = now.getTime();
  const startMs = endMs - windowMinutes * 60 * 1000;
  const smooth = {};
  for (const name of STALLS) {
    const backName = `${name}_back`;
    const raw = rows.map(r => {
      const front = (typeof r.stalls[name]?.occ === 'number' ? r.stalls[name].occ : 0);
      const back = (typeof r.stalls[backName]?.occ === 'number' ? r.stalls[backName].occ : 0);
      return front + back;
    });
    smooth[name] = raw.map((v, i) =>
      (i === 0 || i === raw.length - 1) ? v : medianOf3(raw[i - 1], v, raw[i + 1]));
  }
  const bins = new Map();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].tsMs < startMs || rows[i].tsMs > endMs) continue;
    const binStart = Math.floor(rows[i].tsMs / SLOT_MS) * SLOT_MS;
    let bin = bins.get(binStart);
    if (!bin) { bin = { stall1: 0, stall2: 0, stall3: 0, stall4: 0, total: 0 }; bins.set(binStart, bin); }
    for (const name of STALLS) {
      const dep = departuresBetween(smooth[name][i - 1], smooth[name][i]);
      bin[name] += dep;
      bin.total += dep;
    }
  }
  return [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([ms, bin]) => ({
    slotStart: fmtJst(ms), slotEnd: fmtJst(ms + SLOT_MS),
    stall1: bin.stall1, stall2: bin.stall2, stall3: bin.stall3, stall4: bin.stall4, total: bin.total,
  }));
}
