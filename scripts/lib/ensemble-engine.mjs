/**
 * アンサンブル重み自動調整 (Phase D-2)。
 *
 * 設計: docs/superpowers/specs/2026-05-16-ensemble-weighting-design.md
 *
 * forecast-accuracy.json の lead time 別 MAE から重みを計算し、
 * forecast と pattern-match を重み付き平均した統合予測を作る純関数群。
 */

export const ENSEMBLE_SCHEMA_VERSION = 1;
export const MIN_SAMPLE = 20;     // lead バケットの n がこれ未満ならフォールバック
export const LAPLACE = 0.5;       // MAE 逆数のゼロ除算回避用平滑化
export const LEAD_KEYS = ['lead30', 'lead60', 'lead120'];

/**
 * lead time (分) → バケットキー。境界は中心 30/60/120 の中点。
 */
export function leadBucketOf(leadMinutes) {
  if (leadMinutes <= 45) return 'lead30';
  if (leadMinutes <= 105) return 'lead60';
  return 'lead120';
}

function fallbackWeight() {
  return { w_fc: 0.5, w_pm: 0.5, source: 'fallback' };
}

/**
 * forecast-accuracy.json の recent24h から lead time 別の重みを計算する。
 *
 * @param {Object|null} accuracy forecast-accuracy.json の中身
 * @returns {{lead30, lead60, lead120}} 各 {w_fc, w_pm, source}
 */
export function computeWeights(accuracy) {
  const out = {};
  const r24 = accuracy && accuracy.recent24h;
  for (const key of LEAD_KEYS) {
    if (!r24 || !r24.forecast || !r24.patternMatch) {
      out[key] = fallbackWeight();
      continue;
    }
    const fc = r24.forecast[key];
    const pm = r24.patternMatch[key];
    if (!fc || !pm || typeof fc.mae_total !== 'number' || typeof pm.mae_total !== 'number') {
      out[key] = fallbackWeight();
      continue;
    }
    const nFc = typeof fc.n === 'number' ? fc.n : 0;
    const nPm = typeof pm.n === 'number' ? pm.n : 0;
    if (Math.min(nFc, nPm) < MIN_SAMPLE) {
      out[key] = fallbackWeight();
      continue;
    }
    const invFc = 1 / (fc.mae_total + LAPLACE);
    const invPm = 1 / (pm.mae_total + LAPLACE);
    const sum = invFc + invPm;
    out[key] = {
      w_fc: Number((invFc / sum).toFixed(4)),
      w_pm: Number((invPm / sum).toFixed(4)),
      source: 'mae',
    };
  }
  return out;
}
