// スロット占有履歴 → 乗り場別出庫（15分スロット・実績形）。
import { departuresBetween, medianSmooth, rollingMaxDelay } from './slot-occupancy.mjs';

const SLOT_MS = 15 * 60 * 1000;
const STALLS = ['stall1', 'stall2', 'stall3', 'stall4'];
// 在台数フリッカ除去パラメータ (1 tick ≈ 30秒)。 lantern 検出が昼間に判定境界で
// チラつき、 在台数の差分に偽の出庫が大量混入する問題への対策。
// SMOOTH_WINDOW=5: 直近約2.5分の中央値で単発スパイクを除去。
// HYSTERESIS_TICKS=3: 減少を約90秒遅延させ、 一瞬下がってすぐ戻る谷を埋める。
// 今日(雨天)の実データで偽出庫を約6割削減し時間帯波形は保てた値 (暫定・要再校正)。
const SMOOTH_WINDOW = 5;
const HYSTERESIS_TICKS = 3;

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
    .map(r => ({ tsMs: new Date(r.ts).getTime(), stalls: r.stalls || {}, mode: r.mode || null }))
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
    // 1. median 平滑化で単発スパイクを除去 → 2. 持続確認で減少を遅延させ
    //    一瞬下がってすぐ戻るフリッカの谷を埋める (真の出庫だけ残す)。
    smooth[name] = rollingMaxDelay(medianSmooth(raw, SMOOTH_WINDOW), HYSTERESIS_TICKS);
  }
  const bins = new Map();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].tsMs < startMs || rows[i].tsMs > endMs) continue;
    // 昼/夜モード切替の tick は差分を 0 扱い。 edge_density と lantern_pixel_ratio で
    // 検出対象 (車本体 vs 屋根点光源) が違うので、 同じ画像でも occ の絶対値が違う。
    // mode が連続 tick で変化したら 「擬似出庫」 を計上しない。 mode フィールドが
    // 無い古い history (mode === null) は従来通り差分を取る (互換性維持)。
    const prevMode = rows[i - 1].mode;
    const curMode = rows[i].mode;
    if (prevMode !== null && curMode !== null && prevMode !== curMode) continue;
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
