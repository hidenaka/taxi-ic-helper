// 全乗り場の埋まり具合(fill率)推定 JS版 (jimp)。Python版 fill_estimate.py と同一ロジック。
// 適応背景(直近同日アーカイブの画素pct%ile輝度=空アスファルト)との差分+明るさ正規化+空の床(empty_floor)。
// 夜は呼び出し側がper-slotにフォールバック。設計: 2026-05-22。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
  const a = Float64Array.from(arr).sort();
  return a[Math.floor(a.length / 2)] || 1;
}
function meanArr(arr) {
  let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i]; return s / arr.length;
}

export async function loadFillAssets(libDir) {
  try {
    const cfg = JSON.parse(readFileSync(path.join(libDir, 'fill-config.json'), 'utf8'));
    const bgImg = await Jimp.read(path.join(libDir, cfg.background));
    const { g: bg, width, height } = grayArray(bgImg);
    const stalls = {};
    for (const [name, s] of Object.entries(cfg.stalls)) {
      const mImg = await Jimp.read(path.join(libDir, s.mask));
      const md = mImg.bitmap.data;
      const mask = new Uint8Array(width * height); let area = 0;
      for (let i = 0; i < width * height; i++) { mask[i] = md[i * 4] > 127 ? 1 : 0; area += mask[i]; }
      stalls[name] = { mask, area, cap: s.cap, full_ref: s.full_ref,
                       empty_floor: s.empty_floor ?? 0, cam: s.cam ?? 'real01_line' };
    }
    return { cfg, bg, bgMed: median(bg), width, height,
             diffThreshold: cfg.diff_threshold ?? 40,
             nightBrightness: cfg.night_brightness ?? 50,
             adaptive: cfg.adaptive ?? { enabled: false }, stalls };
  } catch (e) { return null; }
}

// 直近同日アーカイブ(camera)から画素pct%ile輝度=空アスファルト背景。失敗で null。
export async function buildAdaptiveBg(camera, assets, now = new Date(),
                                      archiveDir = (process.env.TAXI_IMAGE_ARCHIVE_DIR || path.join(os.homedir(), 'taxi-image-archive'))) {
  try {
    const a = assets.adaptive || {};
    const hours = a.hours ?? 3, maxFrames = a.max_frames ?? 24, pct = a.percentile ?? 85;
    const minFrames = 6, W = assets.width, H = assets.height;
    const jst = new Date(now.getTime() + 9 * 3600 * 1000);
    const day = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(jst.getUTCDate()).padStart(2, '0')}`;
    const dir = path.join(archiveDir, camera, day);
    if (!existsSync(dir)) return null;
    const cut = new Date(jst.getTime() - hours * 3600 * 1000);
    const cutStr = `${String(cut.getUTCHours()).padStart(2, '0')}${String(cut.getUTCMinutes()).padStart(2, '0')}${String(cut.getUTCSeconds()).padStart(2, '0')}`;
    let files = readdirSync(dir).filter(f => f.endsWith('.jpg')).sort();
    let win = files.filter(f => f.slice(0, 6) >= cutStr);
    if (win.length < minFrames) win = files;          // 当日全部にゆるめる
    if (win.length < minFrames) return null;
    const step = Math.max(1, Math.floor(win.length / maxFrames));
    const picked = win.filter((_, i) => i % step === 0).slice(0, maxFrames);
    const grays = [];
    for (const f of picked) {
      try {
        const im = await Jimp.read(path.join(dir, f));
        if (im.bitmap.width !== W || im.bitmap.height !== H) im.resize({ w: W, h: H });
        const { g } = grayArray(im);
        if (meanArr(g) >= assets.nightBrightness) grays.push(g);
      } catch (_) { /* skip */ }
    }
    if (grays.length < minFrames) return null;
    const n = grays.length, len = W * H, bg = new Float32Array(len), buf = new Float64Array(n);
    const idx = Math.min(n - 1, Math.max(0, Math.round(pct / 100 * (n - 1))));
    for (let p = 0; p < len; p++) {
      for (let f = 0; f < n; f++) buf[f] = grays[f][p];
      buf.sort();
      bg[p] = buf[idx];
    }
    return { bg, bgMed: median(bg) };
  } catch (e) { return null; }
}

// jimpImg → {stall:{count,fill}}。camera指定でその cam の乗り場のみ。夜/失敗で null。
// dynamicFullRef: {stall:full_ref} があれば config の full_ref より優先 (自動較正)。
export function estimateFill(jimpImg, assets, adaptiveBg = null, camera = null, dynamicFullRef = null) {
  if (!assets || !jimpImg) return null;
  try {
    const { g, width, height } = grayArray(jimpImg);
    if (width !== assets.width || height !== assets.height) return null;
    if (meanArr(g) < assets.nightBrightness) return null;     // 夜
    const bg = adaptiveBg ? adaptiveBg.bg : assets.bg;
    const bgMed = adaptiveBg ? adaptiveBg.bgMed : assets.bgMed;
    const factor = bgMed / median(g);
    const thr = assets.diffThreshold;
    const out = {};
    for (const [name, s] of Object.entries(assets.stalls)) {
      if (camera !== null && s.cam !== camera) continue;
      if (s.area === 0) continue;
      let filled = 0;
      for (let i = 0; i < g.length; i++) {
        if (s.mask[i] && Math.abs(g[i] * factor - bg[i]) > thr) filled++;
      }
      const fr = filled / s.area;
      // 動的 full_ref があれば優先 (天候/光に自動追従)。無ければ config 既定。
      const fullRef = (dynamicFullRef && typeof dynamicFullRef[name] === 'number')
        ? dynamicFullRef[name] : s.full_ref;
      const denom = Math.max(1e-6, fullRef - s.empty_floor);
      const frAdj = Math.max(0, (fr - s.empty_floor) / denom);
      const count = Math.max(0, Math.min(Math.round(frAdj * s.cap), s.cap));
      out[name] = { count, fill: Math.round(fr * 1000) / 1000 };
    }
    return out;
  } catch (e) { return null; }
}
