import { createHash } from 'node:crypto';
import { Jimp } from 'jimp';

const BLACK_THRESHOLD = 60; // RGB 各値が 60 未満なら「黒」扱い (タクシー車体近似)

/**
 * 画像 Buffer を解析してメタデータを返す純粋関数 (画像 I/O 以外は副作用なし)。
 *
 * @param {Buffer} buffer - 解析対象の画像 (JPEG/PNG)
 * @param {{black_ratio: number}|null} prev - 前 tick の解析結果 (null なら初回)
 * @returns {Promise<{sha256: string, size_bytes: number, black_ratio: number, diff_from_prev: number|null}>}
 */
export async function analyzePoolImage(buffer, prev = null) {
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

  // 簡素化: 前 tick 画像との pixel diff ではなく、black_ratio の差で「変化量」を表現
  const diff_from_prev = (prev && typeof prev.black_ratio === 'number')
    ? Number(Math.abs(black_ratio - prev.black_ratio).toFixed(4))
    : null;

  return { sha256, size_bytes, black_ratio, diff_from_prev };
}
