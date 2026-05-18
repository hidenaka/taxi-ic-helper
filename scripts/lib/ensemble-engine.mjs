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

function jstNowIsoString(now) {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
}

/**
 * forecast と pattern-match を重み付き平均した統合予測を作る。
 *
 * @param {{slots: Array}|null} forecast        stall-forecast.json 相当
 * @param {{historicalCurve: Array}|null} patternMatch  stall-pattern-match.json 相当
 * @param {Object|null} accuracy                forecast-accuracy.json 相当
 * @param {Date} now
 * @returns 統合予測オブジェクト
 */
export function computeEnsemble(forecast, patternMatch, accuracy, now) {
  const weights = computeWeights(accuracy);
  const fcSlots = (forecast && Array.isArray(forecast.slots)) ? forecast.slots : [];
  const pmSlots = (patternMatch && Array.isArray(patternMatch.historicalCurve))
    ? patternMatch.historicalCurve : [];
  const pmBySlot = new Map();
  for (const s of pmSlots) pmBySlot.set(s.slotStart, s);

  const slots = fcSlots.map((fc, i) => {
    const leadMinutes = (i + 1) * 5;
    const bucket = leadBucketOf(leadMinutes);
    const { w_fc, w_pm } = weights[bucket];
    const pmRaw = pmBySlot.get(fc.slotStart) || null;
    // pattern-match slot が構造的に0 (total=0) のときは「利用不可」とみなす。
    // net-diff 由来の historicalCurve は満車時0になり、トラッカーアンカー型の
    // forecast を希釈してしまうため、その slot は forecast 100% にする。
    const pm = (pmRaw !== null && (pmRaw.total || 0) > 0) ? pmRaw : null;
    const out = { slotStart: fc.slotStart, leadBucket: bucket };
    let total = 0;
    for (const name of ['stall1', 'stall2', 'stall3', 'stall4']) {
      let val;
      if (pm === null) {
        val = fc[name];
      } else {
        // 小数のまま保持する。整数化は書き出し時の applyThroughputScale (round(値×k)) で1回だけ行う。
        val = fc[name] * w_fc + pm[name] * w_pm;
      }
      out[name] = val;
      total += val;
    }
    out.total = total;
    return out;
  });

  return {
    schemaVersion: ENSEMBLE_SCHEMA_VERSION,
    generatedAt: jstNowIsoString(now),
    weights,
    slots,
  };
}
