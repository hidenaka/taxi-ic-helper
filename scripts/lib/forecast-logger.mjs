/**
 * 予測ログ生成 (Phase D-1)。
 *
 * 設計: docs/superpowers/specs/2026-05-16-forecast-accuracy-tracking-design.md
 *
 * 各 tick の forecast / pattern-match の予測スナップショットを
 * forecast-log.jsonl の 1 行に整形する純関数。
 */

function compactSlot(s) {
  return {
    slotStart: s.slotStart,
    stall1: s.stall1,
    stall2: s.stall2,
    stall3: s.stall3,
    stall4: s.stall4,
    total: s.total,
  };
}

/**
 * @param {{slots: Array}|null} forecast      stall-forecast.json 相当
 * @param {{historicalCurve: Array}|null} patternMatch  stall-pattern-match.json 相当
 * @param {number} tickSeq
 * @param {string} ts ISO 文字列 (JST)
 * @returns {{ts, tickSeq, forecast, patternMatch}|null} 両方空なら null
 */
export function buildLogEntry(forecast, patternMatch, tickSeq, ts) {
  const fcSlots = (forecast && Array.isArray(forecast.slots)) ? forecast.slots : [];
  const pmSlots = (patternMatch && Array.isArray(patternMatch.historicalCurve))
    ? patternMatch.historicalCurve : [];
  if (fcSlots.length === 0 && pmSlots.length === 0) return null;
  return {
    ts,
    tickSeq,
    forecast: fcSlots.map(compactSlot),
    patternMatch: pmSlots.map(compactSlot),
  };
}
