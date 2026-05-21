/**
 * T3乗り場・待機所プール観測 (Phase E-1)。
 *
 * 設計: docs/superpowers/specs/2026-05-16-t3-pool-observation-design.md
 *
 * ttc.taxi-inf.jp の T3乗り場 (No5TaxiStand) と待機所プール (no23) の
 * 画像メトリクスを t3-pool-history.jsonl の行に整形する純関数群 (副作用なし)。
 */

export const AUX_SCHEMA_VERSION = 1;
export const T3_STAND_IMAGES = ['Real106', 'Real107'];
export const POOL_IMAGES = ['Real03', 'Real04', 'Real108', 'Real109'];
// analyzePoolImage に渡す全画面 ROI (clipRoi が実画像サイズにクリップする)。
export const FULL_FRAME_ROI = { x: 0, y: 0, width: 100000, height: 100000 };

function numOrNull(v) {
  return typeof v === 'number' ? v : null;
}

/**
 * analyzePoolImage の結果を t3-pool-history の画像エントリ (フラット) に整形する。
 *
 * @param {string} name           画像名 (例 'Real106')
 * @param {Object} analyzeResult  analyzePoolImage(buffer, prev, FULL_FRAME_ROI) の戻り値
 * @returns {Object} {name, sha256, size_bytes, black_ratio, edge_density, luminance_mean, luminance_std, diff_from_prev}
 */
export function buildAuxImageEntry(name, analyzeResult) {
  const r = analyzeResult || {};
  const roi = r.roi || {};
  return {
    name,
    sha256: r.sha256 ?? null,
    size_bytes: numOrNull(r.size_bytes),
    black_ratio: numOrNull(r.black_ratio),
    edge_density: numOrNull(roi.edge_density),
    luminance_mean: numOrNull(roi.luminance_mean),
    luminance_std: numOrNull(roi.luminance_std),
    diff_from_prev: numOrNull(r.diff_from_prev),
    // 駐車エリア占有度（埋まり具合）。observe-taxi-pool.mjs が Real108/109 のみ
    // 後付けで上書きする。未計測・他カメラは null。
    roi_fill_ratio: numOrNull(r.roi_fill_ratio),
  };
}

/**
 * 前 tick の aux 行から、あるグループのある画像名のエントリを返す。
 * analyzePoolImage の prev 引数 (diff_from_prev 算出に prev.black_ratio を使う) に渡す。
 *
 * @param {Object|null} prevRow  t3-pool-history.jsonl の最終行
 * @param {string} group         't3_stand' または 'pool'
 * @param {string} name          画像名
 * @returns {Object|null}
 */
export function findPrevAuxImage(prevRow, group, name) {
  if (!prevRow || !Array.isArray(prevRow[group])) return null;
  return prevRow[group].find(e => e && e.name === name) || null;
}

/**
 * t3-pool-history.jsonl の 1 行を組み立てる。
 *
 * @param {string} ts             tick タイムスタンプ (JST ISO)
 * @param {number} tickSeq        tick 連番
 * @param {Array} t3StandEntries  T3乗り場画像エントリ配列
 * @param {Array} poolEntries     待機所プール画像エントリ配列
 * @returns {Object}
 */
export function buildAuxRow(ts, tickSeq, t3StandEntries, poolEntries) {
  return {
    schema_version: AUX_SCHEMA_VERSION,
    ts,
    tick_seq: tickSeq,
    t3_stand: t3StandEntries,
    pool: poolEntries,
  };
}
