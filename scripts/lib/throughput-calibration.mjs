/**
 * 追跡 throughput キャリブレーション (Phase G-1)。
 *
 * 設計: docs/superpowers/specs/2026-05-16-throughput-forecast-connection-design.md
 *
 * net-diff outflow は真の出庫 throughput を系統的に過小評価する。
 * F-3 の track departed を5分窓で突き合わせ、累積比 k を算出する。
 * 純関数のみ (副作用なし)。
 */

export const WINDOW_MS = 5 * 60 * 1000;          // net-diff 1 tick = 5 分
export const MIN_TRACK_TICKS_PER_WINDOW = 4;     // k 算出: この本数未満の窓は不採用
export const MIN_WINDOWS_FOR_LEARNING = 12;      // 採用窓がこの数に達したら learning
export const MIN_TRACK_TICKS_FOR_TREND = 48;     // trendActual 用 60 分窓の最小 track 本数
export const K_MIN = 0.5;
export const K_MAX = 5.0;
export const NIGHT_LUMINANCE_THRESHOLD = 30;     // 信頼サブセット条件
export const TRACK_SCHEMA_VERSION = 2;           // F-3 stall-ROI 制限版の track 行 schema

/**
 * net-diff history と track history を5分窓で突き合わせ、累積比 k を返す。
 *
 * 信頼サブセット条件: schema_version=3 ∧ img1.roi.luminance_mean>=30 ∧ stalls 非 null。
 * net-diff outflow = stall1+stall2+stall3 の負 diff の絶対値合算 (stall4 は track 対象外)。
 *
 * @param {Array} netDiffHistory taxi-pool-history.jsonl の行配列
 * @param {Array} trackHistory   vehicle-track-history.jsonl の行配列
 * @returns {{k:number, state:string, windowCount:number, trackSum:number, netDiffSum:number}}
 */
export function computeThroughputCalibration(netDiffHistory, trackHistory) {
  // track 行を {tsMs, departed} に1回だけパース
  const trackParsed = [];
  for (const row of trackHistory) {
    if (row.schema_version !== TRACK_SCHEMA_VERSION) continue;
    const tsMs = new Date(row.ts).getTime();
    if (Number.isNaN(tsMs)) continue;
    const departed = typeof row.departed === 'number' ? row.departed : 0;
    trackParsed.push({ tsMs, departed });
  }

  let trackSum = 0;
  let netDiffSum = 0;
  let windowCount = 0;

  for (const row of netDiffHistory) {
    if (row.schema_version !== 3) continue;
    const lum = row.img1?.roi?.luminance_mean;
    if (typeof lum !== 'number' || lum < NIGHT_LUMINANCE_THRESHOLD) continue;
    if (!row.stalls) continue;
    const endMs = new Date(row.ts).getTime();
    if (Number.isNaN(endMs)) continue;
    const startMs = endMs - WINDOW_MS;

    // 窓 (startMs, endMs] の track departed 合算 + 本数
    let winTrack = 0;
    let winTicks = 0;
    for (const t of trackParsed) {
      if (t.tsMs > startMs && t.tsMs <= endMs) {
        winTrack += t.departed;
        winTicks += 1;
      }
    }
    if (winTicks < MIN_TRACK_TICKS_PER_WINDOW) continue;

    // net-diff outflow = stall1+2+3 の負 diff 絶対値
    let winNetDiff = 0;
    for (const name of ['stall1', 'stall2', 'stall3']) {
      const d = row.stalls[name]?.diff_occupied_from_prev;
      if (typeof d === 'number' && d < 0) winNetDiff += -d;
    }

    trackSum += winTrack;
    netDiffSum += winNetDiff;
    windowCount += 1;
  }

  let state = 'bootstrapping';
  let k = 1.0;
  if (windowCount >= MIN_WINDOWS_FOR_LEARNING) {
    state = 'learning';
    if (netDiffSum > 0) {
      k = Math.max(K_MIN, Math.min(K_MAX, trackSum / netDiffSum));
    }
  }

  return { k, state, windowCount, trackSum, netDiffSum };
}

/**
 * track history のうち ts が (startMs, endMs] に入る行の departed を合算する。
 * 区間内の行数が minTicks 未満なら null (カバレッジ不足のためフォールバックさせる)。
 *
 * @param {Array} trackHistory vehicle-track-history.jsonl の行配列
 * @param {number} startMs 窓開始 (排他)
 * @param {number} endMs   窓終了 (包含)
 * @param {number} minTicks この本数未満なら null
 * @returns {number|null}
 */
export function sumTrackDepartedInWindow(trackHistory, startMs, endMs, minTicks) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  let sum = 0;
  let ticks = 0;
  for (const row of trackHistory) {
    if (row.schema_version !== TRACK_SCHEMA_VERSION) continue;
    const tsMs = new Date(row.ts).getTime();
    if (Number.isNaN(tsMs)) continue;
    if (tsMs > startMs && tsMs <= endMs) {
      sum += typeof row.departed === 'number' ? row.departed : 0;
      ticks += 1;
    }
  }
  return ticks >= minTicks ? sum : null;
}
