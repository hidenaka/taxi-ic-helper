#!/usr/bin/env node
// スロット校正支援。/tmp/slots-input.json を読み、確認画像を出力。--write で stall-slots.json。
//
// /tmp/slots-input.json の形:
// { "edge_threshold": 0.08,
//   "stalls": { "stall1": {"source":"real01_line","slots":[[cx,cy,r],...]}, ... } }
import { readFileSync, writeFileSync } from 'node:fs';
import { Jimp } from 'jimp';

const TTC_BASE = 'https://ttc.taxi-inf.jp';
const SLOTS_PATH = './scripts/lib/stall-slots.json';
const INPUT_PATH = '/tmp/slots-input.json';
const LABELS = {
  stall1: '第1乗り場 (JAL 2番ポール T1)', stall2: '第2乗り場 (JAL 18番ポール T1)',
  stall3: '第3乗り場 (ANA 3番ポール T2)', stall4: '第4乗り場 (ANA 19番ポール T2)',
};
const RGBA = { stall1: 0xe22233ff, stall2: 0xddcc00ff, stall3: 0x22cc33ff, stall4: 0x2288eeff };

async function fetchJimp(imgName) {
  const res = await fetch(`${TTC_BASE}/${imgName}.jpg`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Jimp.read(Buffer.from(await res.arrayBuffer()));
}
function imageNameOf(source) {
  return source.split('_').map((p, i) => i === 0 ? p[0].toUpperCase() + p.slice(1) : p).join('_');
}

async function main() {
  const inp = JSON.parse(readFileSync(INPUT_PATH, 'utf8'));
  const bySource = {};
  for (const [name, st] of Object.entries(inp.stalls)) {
    (bySource[st.source] ||= []).push([name, st.slots]);
  }
  for (const [source, entries] of Object.entries(bySource)) {
    const img = await fetchJimp(imageNameOf(source));
    const { width: w, height: h } = img.bitmap;
    const big = img.clone().resize({ w: w * 2, h: h * 2 });
    for (const [name, slots] of entries) {
      const col = RGBA[name] || 0xffffffff;
      for (const [cx, cy, r] of slots) {
        const px = cx * w * 2, py = cy * h * 2, rr = r * w * 2;
        for (let a = 0; a < 360; a += 6) {
          const x = Math.round(px + rr * Math.cos(a * Math.PI / 180));
          const y = Math.round(py + rr * Math.sin(a * Math.PI / 180));
          if (x >= 0 && y >= 0 && x < w * 2 && y < h * 2) big.setPixelColor(col, x, y);
        }
      }
    }
    await big.write(`/tmp/slots-overlay-${source}.png`);
    console.log(`[calibrate] /tmp/slots-overlay-${source}.png`);
  }
  if (process.argv.includes('--write')) {
    const out = { _meta: { image_size: [800, 600], edge_threshold: inp.edge_threshold ?? 0.08,
      note: 'スロット中心は0-1正規化座標' }, schema_version: 1, stalls: {} };
    for (const [name, st] of Object.entries(inp.stalls)) {
      out.stalls[name] = {
        source: st.source, label: LABELS[name] || name,
        slots: st.slots.map(([cx, cy, r], i) => ({ id: `${name}-${i + 1}`, cx, cy, r })),
      };
    }
    writeFileSync(SLOTS_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
    console.log(`[calibrate] wrote ${SLOTS_PATH}`);
  }
}
main();
