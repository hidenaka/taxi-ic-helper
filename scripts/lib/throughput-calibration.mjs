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
export const TRACK_SCHEMA_VERSION = 3;           // 複数カメラ per-camera 版の track 行 schema

/**
 * v3 track 行の全カメラ departed 合計を返す。
 * row.cameras 配下の各カメラの departed (数値のみ) を合算する。
 */
function trackRowDeparted(row) {
  let sum = 0;
  const cameras = row.cameras;
  if (cameras && typeof cameras === 'object') {
    for (const cam of Object.values(cameras)) {
      if (cam && typeof cam.departed === 'number') sum += cam.departed;
    }
  }
  return sum;
}

/**
 * net-diff history と track history を5分窓で突き合わせ、累積比 k を返す。
 *
 * 信頼サブセット条件: schema_version=3 ∧ img1.roi.luminance_mean>=30 ∧ stalls 非 null。
 * net-diff outflow = stall1〜stall4 の負 diff の絶対値合算。
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
    trackParsed.push({ tsMs, departed: trackRowDeparted(row) });
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

    // net-diff outflow = stall1〜4 の負 diff 絶対値
    let winNetDiff = 0;
    for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
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
      sum += trackRowDeparted(row);
      ticks += 1;
    }
  }
  return ticks >= minTicks ? sum : null;
}

/**
 * forecast / ensemble / pattern-match の出力オブジェクトの slot outflow を k 倍した新オブジェクトを返す。
 *
 * slotsKey 配下の配列の各 slot の stall1-4 を round(値×k)、total はスケール後 stall1-4 の
 * 合計で再計算する。slot のその他フィールド (slotStart/slotEnd/flightFactor/leadBucket 等) と
 * トップレベルのその他フィールド (schemaVersion/trendFactor/similarDays/today 等) は保持する。
 * 入力は破壊しない。トップレベルに throughputScaleK (適用した k) を付与する。
 *
 * @param {object} obj forecast/ensemble/pattern-match の出力オブジェクト
 * @param {number} k スケール係数 (非数値・非正なら 1.0 扱い)
 * @param {string} [slotsKey] スケール対象の配列のキー (既定 'slots'、pattern-match は 'historicalCurve')
 * @returns {object} スケール済みの新オブジェクト
 */
export function applyThroughputScale(obj, k, slotsKey = 'slots') {
  const scale = (Number.isFinite(k) && k > 0) ? k : 1.0;
  if (!Array.isArray(obj[slotsKey])) {
    return { ...obj, throughputScaleK: scale };
  }
  const scaledSlots = obj[slotsKey].map(slot => {
    const out = { ...slot };
    let total = 0;
    for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
      if (typeof slot[name] === 'number') {
        out[name] = Math.round(slot[name] * scale);
        total += out[name];
      }
    }
    out.total = total;
    return out;
  });
  return { ...obj, [slotsKey]: scaledSlots, throughputScaleK: scale };
}

/**
 * accuracy オブジェクトの全 MAE 値を k 倍した新オブジェクトを返す。
 *
 * recent24h / allPeriod の forecast・patternMatch の各 lead bucket の
 * mae_total と mae_per_stall[] を round(値×k, 小数3桁) でスケールする。
 * null (や非数値) の MAE はそのまま。n / winner / metadata は保持。
 * 入力は破壊しない。トップレベルに throughputScaleK (適用した k) を付与する。
 * recent24h / allPeriod / forecast / patternMatch / bucket が欠けていても例外を投げない。
 *
 * @param {object} accObj evaluateAccuracy の戻り値相当
 * @param {number} k スケール係数 (非数値・非正なら 1.0 扱い)
 * @returns {object} スケール済みの新オブジェクト
 */
export function applyThroughputScaleToAccuracy(accObj, k) {
  const scale = (Number.isFinite(k) && k > 0) ? k : 1.0;
  const scaleMae = (v) => (typeof v === 'number' ? Number((v * scale).toFixed(3)) : v);
  const scaleBucket = (bucket) => {
    if (!bucket || typeof bucket !== 'object') return bucket;
    const out = { ...bucket };
    if ('mae_total' in bucket) out.mae_total = scaleMae(bucket.mae_total);
    if (Array.isArray(bucket.mae_per_stall)) {
      out.mae_per_stall = bucket.mae_per_stall.map(scaleMae);
    }
    return out;
  };
  const scaleMethod = (method) => {
    if (!method || typeof method !== 'object') return method;
    const out = {};
    for (const [key, bucket] of Object.entries(method)) {
      out[key] = scaleBucket(bucket);
    }
    return out;
  };
  const scalePeriod = (period) => {
    if (!period || typeof period !== 'object') return period;
    const out = { ...period };
    if (period.forecast) out.forecast = scaleMethod(period.forecast);
    if (period.patternMatch) out.patternMatch = scaleMethod(period.patternMatch);
    return out;
  };
  const result = { ...accObj, throughputScaleK: scale };
  if (accObj.recent24h) result.recent24h = scalePeriod(accObj.recent24h);
  if (accObj.allPeriod) result.allPeriod = scalePeriod(accObj.allPeriod);
  return result;
}
