// 乗り場先頭スロット占有方式の純関数群。

/** 在/不在のエッジ密度しきい値の既定。空きアスファルトは滑らか・車はエッジが多い。 */
export const DEFAULT_EDGE_THRESHOLD = 0.08;

/**
 * 画像の平均輝度から「異常フレーム（露出オーバー/アンダー）」を判定する純関数。
 * カメラサーバが時々返す真っ白/真っ黒の壊れフレームを検出し、その tick を
 * スキップして擬似出庫が計上されるのを防ぐ。
 *
 * 下限は 5 に設定。羽田の夜時間帯(車ライトが点在する暗い画像)は avg=15-25 程度
 * になるため、それを誤って skip しないように。avg<5 は本当の真っ黒(取得失敗・
 * カメラオフ)のみ。
 * 上限 235 は昼間通常 100-130 から大きく離れた真っ白(露出オーバー)を捕捉。
 *
 * @param {number} avgBrightness 0-255 の平均輝度
 * @returns {boolean} 異常なら true
 */
export function isFrameAbnormal(avgBrightness) {
  if (typeof avgBrightness !== 'number' || Number.isNaN(avgBrightness)) return true;
  return avgBrightness > 235 || avgBrightness < 5;
}

/**
 * スロットの画像特徴から在(車あり)/不在を判定する純関数。
 * @param {{edge_density:number}|null} features analyzeROI の戻り
 * @param {number} edgeThreshold エッジ密度しきい値
 * @returns {boolean}
 */
export function slotOccupied(features, edgeThreshold = DEFAULT_EDGE_THRESHOLD) {
  if (!features || typeof features.edge_density !== 'number') return false;
  return features.edge_density >= edgeThreshold;
}

/**
 * stall-slots.json から指定乗り場の slots 配列を返す純関数。無ければ []。
 */
export function slotsForStall(slotConfig, stallName) {
  const st = (slotConfig && slotConfig.stalls || {})[stallName];
  return st && Array.isArray(st.slots) ? st.slots : [];
}

/**
 * スロット別の在/不在 dict から、指定 slots の占有数を数える純関数。
 * @param {Object} occupiedById {slotId: boolean}
 * @param {Array} slots [{id}, ...]
 * @returns {number}
 */
export function countStallOccupancy(occupiedById, slots) {
  let n = 0;
  for (const s of slots) if (occupiedById[s.id]) n += 1;
  return n;
}

/**
 * 在台数の前→現での出庫数。減った分が出庫、増加(列移動の補充)は 0。
 */
export function departuresBetween(prevCount, curCount) {
  if (typeof prevCount !== 'number' || typeof curCount !== 'number') return 0;
  return Math.max(0, prevCount - curCount);
}

/**
 * 3値の中央値。在台数の 1 tick だけのフリッカを除去する平滑用。
 */
export function medianOf3(a, b, c) {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

/**
 * ROI の縦方向を factor 倍に拡張する純関数。
 * 中心 (cx, cy_center) は不変、 height のみ factor 倍。 画像範囲外はクリップ。
 * 夜の行灯検出で「車屋根上」を含める ROI を作るために使う。
 *
 * @param {{x:number, y:number, width:number, height:number}} roi 元 ROI
 * @param {number} factor 縦方向倍率 (>=1)
 * @param {number} imgWidth 画像幅
 * @param {number} imgHeight 画像高
 * @returns {{x:number, y:number, width:number, height:number}}
 */
export function expandRoiVertical(roi, factor, imgWidth, imgHeight) {
  if (factor <= 1) return { ...roi };
  const newHeight = roi.height * factor;
  const offset = (newHeight - roi.height) / 2;
  let y = Math.round(roi.y - offset);
  let h = Math.round(newHeight);
  // 上端クリップ
  if (y < 0) {
    h += y; // y が負ぶん height を縮める
    y = 0;
  }
  // 下端クリップ
  if (y + h > imgHeight) {
    h = imgHeight - y;
  }
  if (h < 0) h = 0;
  return { x: roi.x, y, width: roi.width, height: h };
}
