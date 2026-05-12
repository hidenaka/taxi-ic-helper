#!/usr/bin/env node
/**
 * stall-rois.json の各 ROI を実画像から crop して /tmp に保存する。
 * 加えて、画像にグリッド線をオーバーレイした画像も出力する。
 *
 * グリッド体系 (Real01: 800x600):
 *   列 A=x:0-99, B=100-199, C=200-299, D=300-399,
 *      E=400-499, F=500-599, G=600-699, H=700-799
 *   行 1=y:0-99, 2=100-199, 3=200-299, 4=300-399,
 *      5=400-499, 6=500-599
 *
 *   例: 「A3 セル」= x=0-99, y=200-299 の 100x100 領域
 *       「G1 セル」= x=600-699, y=0-99 (画像右上の 100x100)
 *
 * Real02 (800x600 同サイズ) も同じグリッド体系を使う。
 *
 * 使い方:
 *   node scripts/calibrate-stall-rois.mjs
 *   open /tmp/real01-grid.jpg /tmp/real02-grid.jpg
 *   # ユーザーに「A3 が第1乗り場、 B2 が第2乗り場」のように指示してもらう
 *
 *   open /tmp/stall-stall1.jpg /tmp/stall-stall2.jpg /tmp/stall-stall3.jpg /tmp/stall-stall4.jpg
 *   # 現在の stall-rois.json で切り出した ROI 内容を確認
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Jimp } from 'jimp';

const REAL01_URL = 'https://ttc.taxi-inf.jp/Real01_line.jpg';
const REAL02_URL = 'https://ttc.taxi-inf.jp/Real02.jpg';
const GRID_STEP = 100;       // セルサイズ (px)
const GRID_RGB = 0x00ff00ff; // 緑線 (R=0, G=255, B=0, A=255)
const GRID_LINE_THICKNESS = 1;

async function fetchImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function drawGrid(img) {
  // jimp 1.x: bitmap.data は RGBA Uint8Array
  const { width, height, data } = img.bitmap;
  // 縦線
  for (let x = GRID_STEP; x < width; x += GRID_STEP) {
    for (let y = 0; y < height; y++) {
      const idx = (y * width + x) * 4;
      data[idx] = 0;       // R
      data[idx + 1] = 255; // G (緑線)
      data[idx + 2] = 0;   // B
      data[idx + 3] = 255; // A
    }
  }
  // 横線
  for (let y = GRID_STEP; y < height; y += GRID_STEP) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      data[idx] = 0;
      data[idx + 1] = 255;
      data[idx + 2] = 0;
      data[idx + 3] = 255;
    }
  }
}

async function main() {
  console.log('Fetching latest images from ttc.taxi-inf.jp ...');
  const [buf1, buf2] = await Promise.all([fetchImage(REAL01_URL), fetchImage(REAL02_URL)]);
  writeFileSync('/tmp/ttc-real01-source.jpg', buf1);
  writeFileSync('/tmp/ttc-real02-source.jpg', buf2);

  // グリッド付き画像を生成
  const img1ForGrid = await Jimp.read(buf1);
  const img2ForGrid = await Jimp.read(buf2);
  drawGrid(img1ForGrid);
  drawGrid(img2ForGrid);
  await img1ForGrid.write('/tmp/real01-grid.jpg');
  await img2ForGrid.write('/tmp/real02-grid.jpg');
  console.log('Grid overlay saved:');
  console.log('  /tmp/real01-grid.jpg');
  console.log('  /tmp/real02-grid.jpg');

  // 既存 stall-rois.json で crop
  const rois = JSON.parse(readFileSync('./scripts/lib/stall-rois.json', 'utf8'));
  const img1 = await Jimp.read(buf1);
  const img2 = await Jimp.read(buf2);
  const images = { real01_line: img1, real02: img2 };
  console.log('\nCrop with current stall-rois.json:');
  for (const [name, def] of Object.entries(rois.stalls)) {
    const src = images[def.source];
    if (!src) {
      console.error(`  ${name}: source ${def.source} not available`);
      continue;
    }
    const { width, height } = src.bitmap;
    const x = Math.max(0, Math.min(width, def.roi.x));
    const y = Math.max(0, Math.min(height, def.roi.y));
    const w = Math.max(0, Math.min(width - x, def.roi.width));
    const h = Math.max(0, Math.min(height - y, def.roi.height));
    const out = src.clone().crop({ x, y, w, h });
    const outPath = `/tmp/stall-${name}.jpg`;
    await out.write(outPath);
    console.log(`  ${name}: ${def.label} → ${outPath} (x=${x},y=${y},${w}x${h})`);
  }

  console.log('\nグリッド画像を開いて、各乗り場のセル座標を教えてください:');
  console.log('  open /tmp/real01-grid.jpg /tmp/real02-grid.jpg');
  console.log('\nグリッド体系: 列 A-H (x=0-799、100px 刻み)、行 1-6 (y=0-599、100px 刻み)');
  console.log('  例: 「A3 セル」= x=0-99, y=200-299');
  console.log('      「G1 セル」= x=600-699, y=0-99 (画像右上)');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
