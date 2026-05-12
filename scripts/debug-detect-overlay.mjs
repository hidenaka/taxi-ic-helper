#!/usr/bin/env node
/**
 * 使い方: node scripts/debug-detect-overlay.mjs <input.jpg> <output.png>
 * 例: node scripts/debug-detect-overlay.mjs tests/fixtures/observation/sample-real01.jpg /tmp/real01-bbox.png
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Jimp, JimpMime } from 'jimp';
import { detectVehicles, loadModel } from './lib/vehicle-detector.mjs';

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/debug-detect-overlay.mjs <input.jpg> <output.png>');
  process.exit(1);
}

const model = await loadModel('./models/yolov8m.onnx');
const buf = readFileSync(inputPath);
const detections = await detectVehicles(buf, model, { confidenceThreshold: 0.3 });
console.log(`Detected ${detections.length} vehicles:`);
for (const d of detections) {
  console.log(`  ${d.class} conf=${d.confidence.toFixed(2)} bbox=[${d.bbox.join(', ')}]`);
}

const img = await Jimp.read(buf);
// 各bboxを赤線で描画
for (const d of detections) {
  const [x, y, w, h] = d.bbox;
  for (let i = 0; i < w; i++) {
    img.setPixelColor(0xff0000ff, x + i, y);
    img.setPixelColor(0xff0000ff, x + i, y + h - 1);
  }
  for (let j = 0; j < h; j++) {
    img.setPixelColor(0xff0000ff, x, y + j);
    img.setPixelColor(0xff0000ff, x + w - 1, y + j);
  }
}
const outBuf = await img.getBuffer(JimpMime.png);
writeFileSync(outputPath, outBuf);
console.log(`Wrote ${outputPath}`);
