#!/usr/bin/env node
// T3 校正支援: data/calibration/t3/<timestamp>/Real106.jpg にマス目をオーバーレイし、
// data/calibration/t3/<timestamp>/Real106_annotated.png として出力する。
// 18マスの位置調整を t3-stall-slots.json で繰り返しながら見比べる用途。
//
// CLI:
//   node scripts/calibrate-t3-slots.mjs <calibration-dir>
//   例: node scripts/calibrate-t3-slots.mjs data/calibration/t3/2026-05-20-21-30-00
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Jimp } from 'jimp';
import { parseT3SlotConfig } from './lib/t3-occupancy-helpers.mjs';

const SLOTS_PATH = './scripts/lib/t3-stall-slots.json';

const LANE_COLORS = {
  kanagawa: 0xff0000ff, // 赤
  general:  0x00ff00ff, // 緑
  wagon:    0x0000ffff, // 青
  ecd:      0xffff00ff, // 黄
  hire:     0xff00ffff, // 紫
};

async function annotateImage(srcPath, cfg) {
  const img = await Jimp.read(srcPath);
  const { width, height } = img.bitmap;
  for (const slot of cfg.slots) {
    const color = LANE_COLORS[slot.category] || 0xffffffff;
    const x = Math.round((slot.cx - slot.r) * width);
    const y = Math.round((slot.cy - slot.r) * height);
    const w = Math.round(slot.r * 2 * width);
    const h = Math.round(slot.r * 2 * height);
    // 矩形を線描画 (上下左右の辺)
    for (let i = 0; i < w; i++) {
      if (x + i >= 0 && x + i < width) {
        if (y >= 0 && y < height) img.setPixelColor(color, x + i, y);
        if (y + h - 1 >= 0 && y + h - 1 < height) img.setPixelColor(color, x + i, y + h - 1);
      }
    }
    for (let i = 0; i < h; i++) {
      if (y + i >= 0 && y + i < height) {
        if (x >= 0 && x < width) img.setPixelColor(color, x, y + i);
        if (x + w - 1 >= 0 && x + w - 1 < width) img.setPixelColor(color, x + w - 1, y + i);
      }
    }
  }
  return img;
}

async function main() {
  const calDir = process.argv[2];
  if (!calDir) {
    console.error('Usage: node scripts/calibrate-t3-slots.mjs <calibration-dir>');
    process.exit(1);
  }
  const cfg = parseT3SlotConfig(JSON.parse(readFileSync(SLOTS_PATH, 'utf8')));
  const camName = cfg.source; // 'real106' → ファイル名 'Real106.jpg'
  const imageName = camName.split('_').map((p, i) =>
    i === 0 ? p[0].toUpperCase() + p.slice(1) : p).join('_');
  const srcPath = join(calDir, `${imageName}.jpg`);
  if (!existsSync(srcPath)) {
    console.error(`source image not found: ${srcPath}`);
    process.exit(1);
  }
  const annotated = await annotateImage(srcPath, cfg);
  const outPath = join(calDir, `${imageName}_annotated.png`);
  await annotated.write(outPath);
  console.log(`[calibrate-t3] annotated: ${outPath}`);
  console.log(`  → このファイルを開いて 18マスが 9レーン × 2列 の先頭領域に重なるか確認`);
  console.log(`  → ズレがあれば ${SLOTS_PATH} の cx/cy/r を調整して再実行`);
}

main().catch(e => { console.error(`[calibrate-t3] fatal: ${e.message}`); process.exit(1); });
