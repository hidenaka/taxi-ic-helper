import { createHash } from 'node:crypto';
import { Jimp } from 'jimp';

const BLACK_THRESHOLD = 60; // RGB 各値が 60 未満なら「黒」扱い (タクシー車体近似)
const EDGE_THRESHOLD = 50;  // Sobel 勾配大きさのしきい値
const LANTERN_R_MIN = 180;   // 赤チャネルの下限 (空車行灯の赤)
const LANTERN_GB_MAX = 120;  // 緑・青チャネルの上限 (白色ライトを除外)

// 3x3 Sobel カーネル
const SOBEL_X = [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]];
const SOBEL_Y = [[-1, -2, -1], [0, 0, 0], [1, 2, 1]];

function clipRoi(roi, width, height) {
  // ROI 座標を画像範囲にクリップ
  const x = Math.max(0, Math.min(width, roi.x ?? 0));
  const y = Math.max(0, Math.min(height, roi.y ?? 0));
  const w = Math.max(0, Math.min(width - x, roi.width ?? 0));
  const h = Math.max(0, Math.min(height - y, roi.height ?? 0));
  return { x, y, width: w, height: h };
}

export async function analyzeROI(jimpImage, roi) {
  const { width, height } = jimpImage.bitmap;
  const clipped = clipRoi(roi, width, height);
  if (clipped.width === 0 || clipped.height === 0) {
    return {
      edge_density: 0,
      roi_black_ratio: 0,
      luminance_mean: 0,
      luminance_std: 0,
      lantern_pixel_ratio: 0
    };
  }

  // ROI をクローン + crop してから処理 (元画像を破壊しない)
  const roiImg = jimpImage.clone().crop({ x: clipped.x, y: clipped.y, w: clipped.width, h: clipped.height });
  const roiData = roiImg.bitmap.data;
  const total = clipped.width * clipped.height;

  // 1. roi_black_ratio と luminance と lantern_pixel_ratio を 1 ループで集計
  let blackCount = 0;
  let lanternCount = 0;
  let lumSum = 0;
  const luminances = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const idx = i * 4;
    const r = roiData[idx];
    const g = roiData[idx + 1];
    const b = roiData[idx + 2];
    if (r < BLACK_THRESHOLD && g < BLACK_THRESHOLD && b < BLACK_THRESHOLD) blackCount++;
    if (r > LANTERN_R_MIN && g < LANTERN_GB_MAX && b < LANTERN_GB_MAX) lanternCount++;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    luminances[i] = lum;
    lumSum += lum;
  }
  const luminance_mean = lumSum / total;
  let varSum = 0;
  for (let i = 0; i < total; i++) {
    varSum += (luminances[i] - luminance_mean) ** 2;
  }
  const luminance_std = Math.sqrt(varSum / total);
  const roi_black_ratio = blackCount / total;
  const lantern_pixel_ratio = lanternCount / total;

  // 2. Sobel エッジ密度
  // luminances を 2D グリッドとして扱い、内側 (w-2)*(h-2) ピクセルで Sobel
  let edgeCount = 0;
  const w = clipped.width;
  const h = clipped.height;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let gx = 0, gy = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = luminances[(y + dy) * w + (x + dx)];
          gx += v * SOBEL_X[dy + 1][dx + 1];
          gy += v * SOBEL_Y[dy + 1][dx + 1];
        }
      }
      const mag = Math.sqrt(gx * gx + gy * gy);
      if (mag >= EDGE_THRESHOLD) edgeCount++;
    }
  }
  const inner = Math.max(1, (w - 2) * (h - 2));
  const edge_density = edgeCount / inner;

  return {
    edge_density: Number(edge_density.toFixed(4)),
    roi_black_ratio: Number(roi_black_ratio.toFixed(4)),
    luminance_mean: Number(luminance_mean.toFixed(2)),
    luminance_std: Number(luminance_std.toFixed(2)),
    lantern_pixel_ratio: Number(lantern_pixel_ratio.toFixed(4))
  };
}

/**
 * 画像 Buffer を解析してメタデータを返す純粋関数 (画像 I/O 以外は副作用なし)。
 *
 * @param {Buffer} buffer - 解析対象の画像 (JPEG/PNG)
 * @param {{black_ratio: number, roi?: {edge_density: number}}|null} prev - 前 tick の解析結果
 * @param {{x: number, y: number, width: number, height: number}|null} roi - ROI 座標 (null なら ROI 解析スキップ)
 * @returns {Promise<{sha256: string, size_bytes: number, black_ratio: number, diff_from_prev: number|null, roi?: object}>}
 */
export async function analyzePoolImage(buffer, prev = null, roi = null) {
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const size_bytes = buffer.length;

  const img = await Jimp.read(buffer);
  const { width, height, data } = img.bitmap;
  const totalPixels = width * height;
  let blackCount = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r < BLACK_THRESHOLD && g < BLACK_THRESHOLD && b < BLACK_THRESHOLD) {
      blackCount += 1;
    }
  }
  const black_ratio = totalPixels > 0
    ? Number((blackCount / totalPixels).toFixed(4))
    : 0;

  const diff_from_prev = (prev && typeof prev.black_ratio === 'number')
    ? Number(Math.abs(black_ratio - prev.black_ratio).toFixed(4))
    : null;

  const result = { sha256, size_bytes, black_ratio, diff_from_prev };

  // ROI 解析 (オプショナル、roi=null なら追加しない)
  if (roi) {
    try {
      const roiResult = await analyzeROI(img, roi);
      const prevEdge = prev?.roi?.edge_density;
      const diff_edge_from_prev = (typeof prevEdge === 'number')
        ? Number(Math.abs(roiResult.edge_density - prevEdge).toFixed(4))
        : null;
      result.roi = { ...roiResult, diff_edge_from_prev };
    } catch (e) {
      console.error(`[analyzePoolImage] ROI 解析失敗: ${e.message}`);
      result.roi = null;
    }
  }

  return result;
}

const NORMALIZATION = 0.4; // ROI 満杯時の経験則 black_ratio

/**
 * 各乗り場の帯状 ROI を解析して状態を返す純粋関数。
 *
 * @param {{real01_line?: import('jimp').Jimp, real02?: import('jimp').Jimp}} jimpImagesByName
 * @param {{stalls: Object}} stallRois - stall-rois.json の中身
 * @param {Object|null} prevStalls - 前 tick の stalls オブジェクト (v3 以前の tick なら null)
 * @returns {Object} { stall1, stall2, stall3, stall4 } の各値は { source, capacity, label, occupied_estimate, black_ratio, edge_density, luminance_mean, diff_occupied_from_prev } または null
 */
export async function analyzeStalls(jimpImagesByName, stallRois, prevStalls = null) {
  const result = {};
  for (const [stallName, def] of Object.entries(stallRois.stalls)) {
    const img = jimpImagesByName[def.source];
    if (!img) {
      result[stallName] = null;
      continue;
    }
    try {
      const roiData = await analyzeROI(img, def.roi);
      const raw = roiData.roi_black_ratio / NORMALIZATION * def.capacity;
      const occupied_estimate = Math.max(0, Math.min(def.capacity, Math.round(raw)));
      const prevOcc = prevStalls?.[stallName]?.occupied_estimate;
      const diff_occupied_from_prev = (typeof prevOcc === 'number')
        ? occupied_estimate - prevOcc
        : null;
      result[stallName] = {
        source: def.source,
        capacity: def.capacity,
        label: def.label,
        occupied_estimate,
        black_ratio: roiData.roi_black_ratio,
        edge_density: roiData.edge_density,
        luminance_mean: roiData.luminance_mean,
        diff_occupied_from_prev
      };
    } catch (e) {
      console.error(`[analyzeStalls] ${stallName} 解析失敗: ${e.message}`);
      result[stallName] = null;
    }
  }
  return result;
}
