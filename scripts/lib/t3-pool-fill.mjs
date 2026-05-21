// T3 第3待機所 埋まり具合（占有度）の純関数群。
// 駐車エリア ROI の占有度メトリクスを空/満 baseline で 0〜1 に正規化し、
// レベルラベルと概算台数を出す。台数は数えず占有度ベース。

export const LEVEL_HALF_THRESHOLD = 0.33;
export const LEVEL_BUSY_THRESHOLD = 0.66;

/**
 * 占有度メトリクスを空/満 baseline で 0〜1 に正規化する純関数。
 * @param {number} metric 計測値（edge_density か black_ratio）
 * @param {number} emptyBaseline 空っぽの時の metric 値
 * @param {number} fullBaseline 満杯の時の metric 値
 * @returns {number} 0〜1（範囲外はクランプ、full<=empty の異常時は 0）
 */
export function computeFillRatio(metric, emptyBaseline, fullBaseline) {
  const span = fullBaseline - emptyBaseline;
  if (!(span > 0)) return 0;
  const ratio = (metric - emptyBaseline) / span;
  if (ratio < 0) return 0;
  if (ratio > 1) return 1;
  return ratio;
}

/**
 * fillRatio を 3段階ラベルに変換する純関数。
 * @param {number} ratio 0〜1
 * @returns {string} '空き' | '半分' | '混雑'
 */
export function fillLevel(ratio) {
  if (ratio < LEVEL_HALF_THRESHOLD) return '空き';
  if (ratio < LEVEL_BUSY_THRESHOLD) return '半分';
  return '混雑';
}

/**
 * 概算台数 = fillRatio × エリア最大収容数（四捨五入）。
 * @param {number} ratio 0〜1
 * @param {number} maxCapacity エリア最大収容台数
 * @returns {number}
 */
export function approxCount(ratio, maxCapacity) {
  return Math.round(ratio * maxCapacity);
}

/**
 * t3-pool-rois.json を検証して front/rear を抽出する純関数。
 * @param {object} json
 * @returns {{front:object, rear:object}}
 */
export function parseT3PoolRois(json) {
  if (!json || json.schema_version !== 1) {
    throw new Error(`parseT3PoolRois: unsupported schema_version: ${json && json.schema_version}`);
  }
  if (!json.areas || !json.areas.front || !json.areas.rear) {
    throw new Error('parseT3PoolRois: areas.front/rear not found');
  }
  return { front: json.areas.front, rear: json.areas.rear };
}

/**
 * 表示用 payload を整形する純関数。null のエリアは省略。
 * @param {object|null} frontResult {camera, fillRatio, level, approxCount} or null
 * @param {object|null} rearResult 同上
 * @param {Date} now
 * @returns {object}
 */
export function buildT3PoolFillPayload(frontResult, rearResult, now) {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const generatedAt = jst.toISOString().replace('Z', '+09:00').replace(/\.\d+/, '');
  const areas = {};
  if (frontResult) areas.front = frontResult;
  if (rearResult) areas.rear = rearResult;
  return { schemaVersion: 1, generatedAt, areas };
}
