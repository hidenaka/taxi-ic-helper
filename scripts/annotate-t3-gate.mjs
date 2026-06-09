#!/usr/bin/env node
// annotate-t3-gate — Real108 の実画像に gate ROI の枠を描いた注釈画像を出力する校正支援。
// 使い方:
//   node scripts/annotate-t3-gate.mjs                 # ttc から現在画像を取得して注釈
//   node scripts/annotate-t3-gate.mjs path/to/img.jpg # 既存サンプル(snapshot-t3-cameras.mjs 出力)に注釈
// 出力: data/calibration/t3/gate-annotated.jpg
// 枠が「出口直前の細い帯」に重なるまで data/t3-front-flow-rois.json の gate を編集→再実行。

import { Jimp } from 'jimp';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseT3FrontFlowRois, gateToBox } from './lib/t3-front-flow.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROIS_PATH = join(ROOT, 'data/t3-front-flow-rois.json');
const OUT_PATH = join(ROOT, 'data/calibration/t3/gate-annotated.jpg');
const RED = { r: 255, g: 40, b: 40 };
const THICK = 3;

function drawRect(img, box) {
  const { width: w, height: h, data } = img.bitmap;
  const px0 = Math.round(box.x0 * (w - 1));
  const px1 = Math.round(box.x1 * (w - 1));
  const py0 = Math.round(box.y0 * (h - 1));
  const py1 = Math.round(box.y1 * (h - 1));
  const put = (x, y) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const i = (y * w + x) * 4;
    data[i] = RED.r; data[i + 1] = RED.g; data[i + 2] = RED.b;
  };
  for (let t = 0; t < THICK; t++) {
    for (let x = px0; x <= px1; x++) { put(x, py0 + t); put(x, py1 - t); }
    for (let y = py0; y <= py1; y++) { put(px0 + t, y); put(px1 - t, y); }
  }
}

async function main() {
  const cfg = parseT3FrontFlowRois(JSON.parse(readFileSync(ROIS_PATH, 'utf8')));
  const src = process.argv[2];
  let img;
  if (src) {
    img = await Jimp.read(src);
  } else {
    const res = await fetch(`https://ttc.taxi-inf.jp/${cfg.camera}.jpg`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    img = await Jimp.read(Buffer.from(await res.arrayBuffer()));
  }
  if (!cfg.calibrated) {
    console.log('[annotate-t3-gate] gate が未校正 (width/height=0)。仮の値を入れてから再実行');
  } else {
    drawRect(img, gateToBox(cfg.gate));
  }
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, await img.getBuffer('image/jpeg'));
  console.log(`[annotate-t3-gate] -> ${OUT_PATH} (gate=${JSON.stringify(cfg.gate)})`);
}

main().catch((e) => { console.error(`[annotate-t3-gate] ${e.message}`); process.exit(1); });
