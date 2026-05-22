// 第1/第2乗り場の埋まり具合(fill率)推定 JS版 (jimp)。
// Python版 scripts/lib/fill_estimate.py と同一ロジック。主系 slot-occupancy-tick が昼に使用。
// 領域全体で「空の駐車場(背景)」との差分割合 → ざっくり台数。明るさ正規化込み。夜は呼び出し側でゲート。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Jimp } from 'jimp';

function grayArray(jimp) {
  const { width, height, data } = jimp.bitmap;
  const g = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    g[i] = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  }
  return { g, width, height };
}

function median(arr) {
  const a = Float32Array.from(arr).sort();
  return a[Math.floor(a.length / 2)] || 1;
}

export async function loadFillAssets(libDir) {
  try {
    const cfg = JSON.parse(readFileSync(path.join(libDir, 'fill-config.json'), 'utf8'));
    const bgImg = await Jimp.read(path.join(libDir, cfg.background));
    const { g: bg, width, height } = grayArray(bgImg);
    const bgMed = median(bg);
    const stalls = {};
    for (const [name, s] of Object.entries(cfg.stalls)) {
      const mImg = await Jimp.read(path.join(libDir, s.mask));
      const md = mImg.bitmap.data;
      const mask = new Uint8Array(width * height);
      let area = 0;
      for (let i = 0; i < width * height; i++) { mask[i] = md[i * 4] > 127 ? 1 : 0; area += mask[i]; }
      stalls[name] = { mask, area, cap: s.cap, full_ref: s.full_ref };
    }
    return { cfg, bg, bgMed, width, height, diffThreshold: cfg.diff_threshold ?? 32, stalls };
  } catch (e) {
    return null;
  }
}

// jimpImg(Real01_line) の stallName 領域の fill率 → {count, fill}。サイズ不一致/失敗で null。
export function estimateFill(jimpImg, assets, stallName) {
  if (!assets || !jimpImg) return null;
  const s = assets.stalls[stallName];
  if (!s || s.area === 0) return null;
  const { g, width, height } = grayArray(jimpImg);
  if (width !== assets.width || height !== assets.height) return null;
  const factor = assets.bgMed / median(g);
  const thr = assets.diffThreshold;
  let filled = 0;
  for (let i = 0; i < g.length; i++) {
    if (s.mask[i] && Math.abs(g[i] * factor - assets.bg[i]) > thr) filled++;
  }
  const fr = filled / s.area;
  const count = Math.max(0, Math.min(Math.round((fr / s.full_ref) * s.cap), s.cap));
  return { count, fill: Math.round(fr * 1000) / 1000 };
}
