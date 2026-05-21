// 乗り場先頭スロット占有方式の純関数群。

/** 在/不在のエッジ密度しきい値の既定。空きアスファルトは滑らか・車はエッジが多い。 */
export const DEFAULT_EDGE_THRESHOLD = 0.08;

/** 夜行灯検出: 赤色高輝度 pixel の ROI 面積比のしきい値の既定。 */
export const DEFAULT_NIGHT_LANTERN_RATIO = 0.005;

/** 夜時間帯と判定する画像全体 平均輝度の上限 (これ以下が夜)。 */
export const NIGHT_BRIGHTNESS_THRESHOLD = 50;

/** 雨天時に lantern しきい値へ掛ける倍率。 濡れた路面の弱い反射を除外する。
 *  ×3 では過大が残った (ユーザー現場感覚) ため ×5 に強化。 */
export const RAIN_LANTERN_MULTIPLIER = 5;

/** 雨天時に edge_density しきい値へ掛ける倍率。 濡れ路面・水たまりの輪郭エッジを除外。
 *  ×1.8 では stall3/4 の過大が残ったため ×2.5 に強化。 */
export const RAIN_EDGE_MULTIPLIER = 2.5;

/**
 * 天気 (降水量) に応じて夜行灯しきい値を調整する純関数。
 * 雨天 (precipitation > 0) は 濡れた路面・水たまりが G/B 高輝度に反射して
 * 行灯と誤検出され 出庫が過大計上される。 しきい値を上げて弱い反射を除外し、
 * 強い点光源 (本物の行灯) のみ残す。
 *
 * @param {number} baseRatio 基準 lantern しきい値
 * @param {number|null} precipitation mm/h (weather.json の current.precipitation)
 * @returns {number} 調整後しきい値
 */
export function nightLanternRatioForWeather(baseRatio, precipitation) {
  if (typeof precipitation === 'number' && precipitation > 0) {
    return baseRatio * RAIN_LANTERN_MULTIPLIER;
  }
  return baseRatio;
}

/**
 * 天気 (降水量) に応じて edge_density しきい値を調整する純関数。
 * 雨天は 濡れた路面・水たまりの輪郭が Sobel エッジを増やし、 空きアスファルトが
 * 「車あり」と誤検出され 昼の stall3/4 出庫が過大計上される。 しきい値を上げて
 * 弱い反射エッジを除外し、 車本体の強いエッジのみ残す。
 *
 * @param {number} baseThreshold 基準 edge_density しきい値
 * @param {number|null} precipitation mm/h
 * @returns {number} 調整後しきい値
 */
export function edgeThresholdForWeather(baseThreshold, precipitation) {
  if (typeof precipitation === 'number' && precipitation > 0) {
    return baseThreshold * RAIN_EDGE_MULTIPLIER;
  }
  return baseThreshold;
}

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
 * 昼: edge_density >= edgeThreshold で判定。
 * 夜 (opts.isNight=true): lantern_pixel_ratio >= nightLanternRatio で判定。
 *
 * @param {object} features analyzeROI の戻り値
 * @param {object} opts 判定オプション
 * @param {number} [opts.edgeThreshold] 昼の edge_density しきい値
 * @param {boolean} [opts.isNight] 夜モード
 * @param {number} [opts.nightLanternRatio] 夜の lantern_pixel_ratio しきい値
 * @returns {boolean}
 */
export function slotOccupied(features, opts = {}) {
  if (!features) return false;
  if (opts.isNight) {
    const ratio = features.lantern_pixel_ratio;
    if (typeof ratio !== 'number') return false;
    return ratio >= (opts.nightLanternRatio ?? DEFAULT_NIGHT_LANTERN_RATIO);
  }
  const ed = features.edge_density;
  if (typeof ed !== 'number') return false;
  return ed >= (opts.edgeThreshold ?? DEFAULT_EDGE_THRESHOLD);
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
