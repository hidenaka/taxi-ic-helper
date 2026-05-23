// fill 自動較正の純関数群 (jimp 非依存・テスト容易)。
// 固定 full_ref は天候/光で満杯時の fill 比率(fr)が変動するためズレる (晴=高/雨=低)。
// プールは日中ほぼ満杯まで埋まるので「直近窓の高パーセンタイル fr ≒ 満杯」とみなし、
// その値を full_ref として動的採用する。empty は適応背景が吸収するため empty_floor は
// 小さい固定でよい。設計: 2026-05-23 (条件適応化)。

/**
 * 直近 fr 履歴から乗り場別の動的 full_ref を自動較正する。
 *
 * @param {Array} rows slot-occupancy-history の行配列 (stalls[name].fill を持つ)
 * @param {string[]} names 対象乗り場キー
 * @param {object} opts
 * @param {number} [opts.nowMs] 現在時刻ms (既定 Date.now())
 * @param {number} [opts.windowMs] 遡る窓 (既定 12h)
 * @param {number} [opts.percentile] 満杯とみなす百分位 0..1 (既定 0.92)
 * @param {number} [opts.min] full_ref 下限クランプ (既定 0.35)
 * @param {number} [opts.max] full_ref 上限クランプ (既定 0.85)
 * @param {number} [opts.minSamples] 必要サンプル数 (既定 20)
 * @param {Object<string,number>} [opts.fallback] 不足時の既定 full_ref
 * @returns {Object<string,number>} {name: full_ref}  (不足かつ fallback 無しは null)
 */
export function computeDynamicFullRef(rows, names, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const windowMs = opts.windowMs ?? 12 * 3600 * 1000;
  const percentile = opts.percentile ?? 0.92;
  const lo = opts.min ?? 0.35;
  const hi = opts.max ?? 0.85;
  const minSamples = opts.minSamples ?? 20;
  const fallback = opts.fallback ?? {};
  const cutoff = nowMs - windowMs;
  const out = {};
  for (const name of names) {
    const vals = [];
    for (const r of (rows || [])) {
      const t = new Date(r.ts).getTime();
      if (Number.isNaN(t) || t < cutoff || t > nowMs) continue;
      const fr = r.stalls?.[name]?.fill;
      if (typeof fr === 'number') vals.push(fr);
    }
    if (vals.length < minSamples) { out[name] = fallback[name] ?? null; continue; }
    vals.sort((a, b) => a - b);
    const idx = Math.min(vals.length - 1, Math.max(0, Math.round(percentile * (vals.length - 1))));
    out[name] = Math.max(lo, Math.min(hi, vals[idx]));
  }
  return out;
}
