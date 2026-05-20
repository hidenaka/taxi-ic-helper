import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Jimp } from 'jimp';
import { analyzePoolImage } from '../scripts/lib/image-pool-analyzer.mjs';

// 全黒の 10x10 画像を作って Buffer 化
async function blackBuffer() {
  const img = new Jimp({ width: 10, height: 10, color: 0x000000ff });
  return await img.getBuffer('image/jpeg');
}

// 全白の 10x10 画像
async function whiteBuffer() {
  const img = new Jimp({ width: 10, height: 10, color: 0xffffffff });
  return await img.getBuffer('image/jpeg');
}

test('analyzePoolImage: 全黒画像で black_ratio が 1.0 に近い', async () => {
  const buf = await blackBuffer();
  const r = await analyzePoolImage(buf, null);
  assert.ok(r.black_ratio > 0.95, `black_ratio=${r.black_ratio}`);
  assert.equal(typeof r.sha256, 'string');
  assert.equal(r.sha256.length, 64);
  assert.equal(typeof r.size_bytes, 'number');
  assert.equal(r.diff_from_prev, null, 'prev=null なら diff_from_prev も null');
});

test('analyzePoolImage: 全白画像で black_ratio が 0 に近い', async () => {
  const buf = await whiteBuffer();
  const r = await analyzePoolImage(buf, null);
  assert.ok(r.black_ratio < 0.05, `black_ratio=${r.black_ratio}`);
});

test('analyzePoolImage: prev に同じ画像を渡すと diff_from_prev が 0', async () => {
  const buf = await blackBuffer();
  const prev = await analyzePoolImage(buf, null);
  const curr = await analyzePoolImage(buf, prev);
  assert.equal(curr.diff_from_prev, 0);
});

test('analyzePoolImage: prev に異なる画像 (黒 vs 白) を渡すと diff_from_prev > 0.9', async () => {
  const black = await blackBuffer();
  const white = await whiteBuffer();
  const prev = await analyzePoolImage(black, null);
  const curr = await analyzePoolImage(white, prev);
  assert.ok(curr.diff_from_prev > 0.9, `diff_from_prev=${curr.diff_from_prev}`);
});

test('analyzePoolImage: 同じ Buffer で sha256 が deterministic', async () => {
  const buf = await blackBuffer();
  const r1 = await analyzePoolImage(buf, null);
  const r2 = await analyzePoolImage(buf, null);
  assert.equal(r1.sha256, r2.sha256);
});

// --- ROI 解析 (schema v2) ---

// 10x10 の市松模様 (黒白 5x5 タイル) を作る (エッジ多めの画像)
async function checkerBuffer() {
  const img = new Jimp({ width: 10, height: 10, color: 0xffffffff });
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      if ((Math.floor(x / 5) + Math.floor(y / 5)) % 2 === 0) {
        img.bitmap.data[(y * 10 + x) * 4 + 0] = 0;
        img.bitmap.data[(y * 10 + x) * 4 + 1] = 0;
        img.bitmap.data[(y * 10 + x) * 4 + 2] = 0;
      }
    }
  }
  return await img.getBuffer('image/jpeg');
}

const ROI_FULL = { x: 0, y: 0, width: 10, height: 10 };

test('ROI 解析: 全黒 ROI → edge_density が 0 に近い (一様)', async () => {
  const buf = await blackBuffer();
  const r = await analyzePoolImage(buf, null, ROI_FULL);
  assert.ok(r.roi, 'roi フィールドが存在する');
  assert.ok(r.roi.edge_density < 0.1, `edge_density=${r.roi.edge_density}`);
  assert.ok(r.roi.luminance_mean < 50, `luminance_mean=${r.roi.luminance_mean}`);
  assert.equal(r.roi.diff_edge_from_prev, null, 'prev=null なら diff_edge_from_prev も null');
});

test('ROI 解析: 市松模様 ROI → edge_density が高い', async () => {
  const buf = await checkerBuffer();
  const r = await analyzePoolImage(buf, null, ROI_FULL);
  assert.ok(r.roi.edge_density > 0.15, `edge_density=${r.roi.edge_density}`);
});

test('ROI 解析: ROI が画像範囲外でもクラッシュしない (クリップ)', async () => {
  const buf = await blackBuffer();
  const roi = { x: -50, y: -50, width: 200, height: 200 }; // 画像 10x10 を大きく超える
  const r = await analyzePoolImage(buf, null, roi);
  assert.ok(r.roi, 'roi フィールドが返る');
  assert.ok(typeof r.roi.edge_density === 'number');
});

test('ROI 解析: roi_black_ratio は ROI 内だけで計算される', async () => {
  const buf = await blackBuffer();
  // 全画像 10x10 が全黒なので、ROI 全範囲でも 0.95 以上
  const r = await analyzePoolImage(buf, null, ROI_FULL);
  assert.ok(r.roi.roi_black_ratio > 0.95, `roi_black_ratio=${r.roi.roi_black_ratio}`);
  // 全体の black_ratio も同様に高い
  assert.ok(r.black_ratio > 0.95);
});

test('ROI 解析: prev.roi.edge_density との差分が diff_edge_from_prev', async () => {
  const blackBuf = await blackBuffer();
  const checkerBuf = await checkerBuffer();
  const prev = await analyzePoolImage(blackBuf, null, ROI_FULL);
  const curr = await analyzePoolImage(checkerBuf, prev, ROI_FULL);
  assert.equal(typeof curr.roi.diff_edge_from_prev, 'number');
  assert.ok(curr.roi.diff_edge_from_prev > 0, '黒→市松 で edge_density 差は正の値');
});

test('ROI 解析: roi=null を渡すと既存動作 (roi フィールドなし)', async () => {
  const buf = await blackBuffer();
  const r = await analyzePoolImage(buf, null, null);
  assert.equal(r.roi, undefined, 'roi=null なら roi フィールドは返さない');
  assert.ok(typeof r.black_ratio === 'number', '既存の black_ratio は計算される');
});

// --- analyzeStalls (schema v3) ---
import { analyzeStalls } from '../scripts/lib/image-pool-analyzer.mjs';

const STALL_ROIS_FOR_TEST = {
  stalls: {
    stall1: {
      source: 'real01_line',
      capacity: 8,
      label: 'Test stall 1',
      roi: { x: 0, y: 0, width: 10, height: 10 }
    }
  }
};

test('analyzeStalls: 全黒画像 → occupied_estimate が capacity に近い', async () => {
  const buf = await blackBuffer();
  const img = await Jimp.read(buf);
  const r = await analyzeStalls({ real01_line: img }, STALL_ROIS_FOR_TEST, null);
  assert.equal(r.stall1.capacity, 8);
  assert.equal(r.stall1.occupied_estimate, 8, `occupied=${r.stall1.occupied_estimate}`);
  assert.ok(r.stall1.black_ratio > 0.95);
  assert.equal(r.stall1.diff_occupied_from_prev, null);
  assert.equal(r.stall1.source, 'real01_line');
  assert.equal(r.stall1.label, 'Test stall 1');
});

test('analyzeStalls: 全白画像 → occupied_estimate = 0', async () => {
  const buf = await whiteBuffer();
  const img = await Jimp.read(buf);
  const r = await analyzeStalls({ real01_line: img }, STALL_ROIS_FOR_TEST, null);
  assert.equal(r.stall1.occupied_estimate, 0);
  assert.ok(r.stall1.black_ratio < 0.05);
});

test('analyzeStalls: prev に同じ stalls を渡す → diff_occupied_from_prev = 0', async () => {
  const buf = await blackBuffer();
  const img = await Jimp.read(buf);
  const prev = await analyzeStalls({ real01_line: img }, STALL_ROIS_FOR_TEST, null);
  const curr = await analyzeStalls({ real01_line: img }, STALL_ROIS_FOR_TEST, prev);
  assert.equal(curr.stall1.diff_occupied_from_prev, 0);
});

test('analyzeStalls: 画像なし stall は null を返す', async () => {
  // stall4 が real02 を要求するが、real02 を渡さない場合
  const rois = {
    stalls: {
      stall4: {
        source: 'real02',
        capacity: 8,
        label: 'Test stall 4',
        roi: { x: 0, y: 0, width: 10, height: 10 }
      }
    }
  };
  const buf = await blackBuffer();
  const img = await Jimp.read(buf);
  const r = await analyzeStalls({ real01_line: img }, rois, null);
  assert.equal(r.stall4, null);
});

// --- analyzeROI: lantern_pixel_ratio ---
import { analyzeROI } from '../scripts/lib/image-pool-analyzer.mjs';

test('analyzeROI: 全画像が赤い行灯色なら lantern_pixel_ratio が 1.0 に近い', async () => {
  const img = new Jimp({ width: 10, height: 10, color: 0xff0000ff }); // R=255 G=0 B=0
  const r = await analyzeROI(img, { x: 0, y: 0, width: 10, height: 10 });
  assert.ok(r.lantern_pixel_ratio >= 0.99, `expected ~1.0, got ${r.lantern_pixel_ratio}`);
});

test('analyzeROI: 真っ黒なら lantern_pixel_ratio が 0', async () => {
  const img = new Jimp({ width: 10, height: 10, color: 0x000000ff });
  const r = await analyzeROI(img, { x: 0, y: 0, width: 10, height: 10 });
  assert.equal(r.lantern_pixel_ratio, 0);
});

test('analyzeROI: 真っ白 (R=G=B=255) は行灯ではない (G/B が高いため)', async () => {
  const img = new Jimp({ width: 10, height: 10, color: 0xffffffff });
  const r = await analyzeROI(img, { x: 0, y: 0, width: 10, height: 10 });
  assert.equal(r.lantern_pixel_ratio, 0);
});

test('analyzeROI: 範囲外 ROI で lantern_pixel_ratio=0', async () => {
  const img = new Jimp({ width: 10, height: 10, color: 0xff0000ff });
  const r = await analyzeROI(img, { x: 100, y: 100, width: 10, height: 10 });
  assert.equal(r.lantern_pixel_ratio, 0);
});
