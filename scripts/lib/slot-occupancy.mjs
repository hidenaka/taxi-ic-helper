// 乗り場先頭スロット占有方式の純関数群。

/** 在/不在のエッジ密度しきい値の既定。空きアスファルトは滑らか・車はエッジが多い。 */
export const DEFAULT_EDGE_THRESHOLD = 0.08;

/** 夜行灯検出: 赤色高輝度 pixel の ROI 面積比のしきい値の既定。 */
export const DEFAULT_NIGHT_LANTERN_RATIO = 0.005;

/** 夜時間帯と判定する画像全体 平均輝度の上限 (これ以下が夜)。 */
export const NIGHT_BRIGHTNESS_THRESHOLD = 50;

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
 * 任意窓幅の中央値平滑化。 単発スパイク (salt-and-pepper ノイズ) を除去する。
 * 端は窓を縮める。 win<=1 は無平滑化 (コピーを返す)。
 *
 * lantern 検出は昼間に判定境界付近で値がブレ、 在台数が高速にチラつく。
 * これを除去しないと 在台数の差分 (出庫) に偽の減少が大量に混入する。
 *
 * @param {number[]} series 在台数の時系列 (時刻昇順)
 * @param {number} win 窓幅 (奇数推奨)
 * @returns {number[]} 平滑化後の系列 (長さは入力と同じ)
 */
export function medianSmooth(series, win) {
  if (!Array.isArray(series) || win <= 1) return (series || []).slice();
  const h = Math.floor(win / 2);
  const out = [];
  for (let i = 0; i < series.length; i++) {
    const w = series.slice(Math.max(0, i - h), Math.min(series.length, i + h + 1))
      .sort((a, b) => a - b);
    out.push(w[Math.floor(w.length / 2)]);
  }
  return out;
}

/**
 * 減少方向の持続確認 (ヒステリシス)。 各点を「直近 k tick の最大値」 に置き換え、
 * 在台数の減少を k tick 遅延させる純関数。 一瞬下がってすぐ戻るフリッカの谷を
 * 埋め、 「下がって戻らない」 真の出庫だけを残す。 増加は即時反映。
 *
 * 固定の時間窓 (medianSmooth) と違い、 出庫レートが時間帯で変動しても
 * ピーク時の連続的な減少は保ったまま 単発のチラつきだけを消せる。
 *
 * @param {number[]} series 在台数の時系列 (時刻昇順、 medianSmooth 後を想定)
 * @param {number} k 持続確認する tick 数 (>=1)
 * @returns {number[]} 遅延後の系列 (長さは入力と同じ)
 */
export function rollingMaxDelay(series, k) {
  if (!Array.isArray(series) || k <= 1) return (series || []).slice();
  const out = [];
  for (let i = 0; i < series.length; i++) {
    let m = series[Math.max(0, i - k + 1)];
    for (let j = Math.max(0, i - k + 1) + 1; j <= i; j++) {
      if (series[j] > m) m = series[j];
    }
    out.push(m);
  }
  return out;
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
