#!/usr/bin/env node
/**
 * 使い方: node scripts/debug-lane-overlay.mjs <input.jpg> <lane-roi.json> <camera> <output.png>
 * 例: node scripts/debug-lane-overlay.mjs tests/fixtures/observation/sample-real01.jpg data/lane-roi.json real01_line /tmp/real01-lanes.png
 *
 * polygon = 緑線、front_row_polygon = 青線で重ねて描画。
 * 各 lane の id を polygon の左上に小さく表示する。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Jimp, JimpMime, loadFont, HorizontalAlign, VerticalAlign } from 'jimp';
import { SANS_10_BLACK } from 'jimp/fonts';

const [, , imgPath, configPath, camera, outputPath] = process.argv;
if (!imgPath || !configPath || !camera || !outputPath) {
  console.error('Usage: node scripts/debug-lane-overlay.mjs <input.jpg> <lane-roi.json> <camera> <output.png>');
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const img = await Jimp.read(imgPath);

function drawPolygon(image, polygon, color) {
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % polygon.length];
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
    for (let t = 0; t <= steps; t++) {
      const x = Math.round(x1 + (x2 - x1) * t / steps);
      const y = Math.round(y1 + (y2 - y1) * t / steps);
      if (x >= 0 && y >= 0 && x < image.bitmap.width && y < image.bitmap.height) {
        image.setPixelColor(color, x, y);
      }
    }
  }
}

const matchingLanes = config.lanes.filter(l => l.camera === camera);
console.log(`Drawing ${matchingLanes.length} lanes for camera=${camera}`);
for (const lane of matchingLanes) {
  drawPolygon(img, lane.polygon, 0x00ff00ff); // 緑 = polygon
  drawPolygon(img, lane.front_row_polygon, 0x0000ffff); // 青 = front_row
  console.log(`  ${lane.id} (${lane.terminal})`);
}

const out = await img.getBuffer(JimpMime.png);
writeFileSync(outputPath, out);
console.log(`Wrote ${outputPath}`);
